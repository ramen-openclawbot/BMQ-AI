// Offline tests for the pure generation domain: request contract, cost bounding,
// strict output validation, dedupe and provenance. No network or database.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GENERATION_COUNT_MAX,
  GENERATION_COUNT_MIN,
  GENERATION_FILTER_KEYS,
  GENERATION_MAX_INPUT_TOKENS,
  SUPPORTED_TOPICS,
  BUILT_IN_EXAMPLE_SEEDS,
  SEED_SOURCE_LABEL,
  buildGenerationPrompt,
  defaultStyleMix,
  estimateWorstCaseCostUsd,
  generationApiKey,
  generationFingerprint,
  generationInputTokenBound,
  generationItemProvenance,
  generationOutputSchema,
  generationOutputTokenBound,
  isDeterministicGenerationFailure,
  serializeGenerationRequest,
  usageCostUpperBoundUsd,
  validateGenerationOutput,
  validateGenerationRequest,
  type GenerationRequest,
} from './generation.ts';
import { verifiedGenerationPricing } from './generation-pricing.ts';
import { DataAdminError } from './data-assets.ts';

const base = { topic: 'controlled_revenue', count: 20, target_language: 'vi', budget_usd: 1 };
const TODAY = '2026-09-21';

function request(overrides: Record<string, unknown> = {}): GenerationRequest {
  return validateGenerationRequest({ ...base, ...overrides });
}

function outputFor(req: GenerationRequest, mutate: (items: any[]) => any[] = (items) => items) {
  const styles = ['variant', 'typo', 'ambiguous', 'out_of_scope'] as const;
  const response: Record<string, string> = { variant: 'answer', typo: 'answer', ambiguous: 'clarify', out_of_scope: 'abstain' };
  const items = Array.from({ length: req.count }, (_, index) => {
    const style = styles[index % styles.length];
    const topic = req.topicId === 'mixed' ? SUPPORTED_TOPICS[index % SUPPORTED_TOPICS.length].id : req.topicId;
    return {
      question: `Câu hỏi tổng hợp số ${index} về ${topic}?`,
      style,
      topic_id: topic,
      expected_response: response[style],
      expected_filters: {},
    };
  });
  return { questions: mutate(items) };
}

test('request validation enforces the 20-50 batch, supported topics and budget', () => {
  assert.equal(request().count, GENERATION_COUNT_MIN);
  assert.equal(request({ count: 50 }).count, GENERATION_COUNT_MAX);
  for (const bad of [
    { count: 19 }, { count: 51 }, { count: 20.5 }, { count: '20' },
    { topic: 'invented_topic' }, { topic: '' },
  ]) {
    assert.throws(() => request(bad), (error: unknown) => error instanceof DataAdminError, JSON.stringify(bad));
  }
  for (const bad of [{ budget_usd: 0 }, { budget_usd: -1 }, { budget_usd: 6 }, { budget_usd: '1' }]) {
    assert.throws(() => request(bad), (error: unknown) => error instanceof DataAdminError, JSON.stringify(bad));
  }
  // target_language is required and independent from the admin UI language.
  assert.throws(() => validateGenerationRequest({ ...base, language: 'vi', target_language: undefined }), (error: unknown) => error instanceof DataAdminError);
  assert.equal(request({ target_language: 'en' }).language, 'en');
});

test('style mix defaults sum to the count and explicit mixes are exact', () => {
  for (const count of [20, 33, 50]) {
    const mix = defaultStyleMix(count);
    assert.equal(Object.values(mix).reduce((sum, value) => sum + value, 0), count);
    assert.ok(mix.variant > 0 && mix.typo > 0 && mix.ambiguous > 0 && mix.out_of_scope > 0);
  }
  const explicit = request({ count: 20, style_mix: { variant: 10, typo: 4, ambiguous: 4, out_of_scope: 2 } });
  assert.equal(explicit.styleMix.typo, 4);
  assert.throws(() => request({ count: 20, style_mix: { variant: 10, typo: 4, ambiguous: 4, out_of_scope: 1 } }), (error: unknown) => error instanceof DataAdminError);
  assert.throws(() => request({ count: 20, style_mix: { variant: 11, typo: 4, ambiguous: 4, out_of_scope: 1, other: 0 } }), (error: unknown) => error instanceof DataAdminError);
});

test('seeds are curated built-in examples, topic-scoped and never invented', () => {
  const defaults = request({ topic: 'supplier_payments' });
  assert.deepEqual(defaults.seedIds, BUILT_IN_EXAMPLE_SEEDS.filter((seed) => seed.topicId === 'supplier_payments').map((seed) => seed.id));
  assert.deepEqual(request({ topic: 'supplier_payments', seed_ids: ['seed-payment-month'] }).seedIds, ['seed-payment-month']);
  assert.throws(() => request({ topic: 'supplier_payments', seed_ids: ['seed-payment-month', 'seed-payment-month'] }), (error: unknown) => error instanceof DataAdminError);
  assert.throws(() => request({ topic: 'supplier_payments', seed_ids: ['made-up-seed'] }), (error: unknown) => error instanceof DataAdminError);
  // A seed for another topic cannot be attached to an explicit single topic.
  assert.throws(() => request({ topic: 'controlled_revenue', seed_ids: ['seed-payment-month'] }), (error: unknown) => error instanceof DataAdminError);
  assert.equal(request({ topic: 'mixed', seed_ids: ['seed-payment-month', 'seed-revenue-today'] }).seedIds.length, 2);
  // The list is honestly labelled as built-in examples, never as owner approvals.
  assert.match(SEED_SOURCE_LABEL, /not owner-approved/i);
  for (const seed of BUILT_IN_EXAMPLE_SEEDS) assert.match(seed.source, /^builtin_example:/);
});

test('idempotency key is preserved or generated; the fingerprint covers the contract only', () => {
  const generated = request();
  assert.match(generated.idempotencyKey, /^[0-9a-f-]{36}$/);
  assert.throws(() => request({ idempotency_key: 'short' }), (error: unknown) => error instanceof DataAdminError);
  assert.throws(() => request({ idempotency_key: 'bad key!' }), (error: unknown) => error instanceof DataAdminError);
  const a = request({ idempotency_key: 'batch-0001' });
  const b = request({ idempotency_key: 'batch-0002' });
  // The fingerprint describes the batch contract, NOT the retry key.
  assert.equal(generationFingerprint(a, 'm'), generationFingerprint(b, 'm'));
  assert.notEqual(generationFingerprint(a, 'm'), generationFingerprint(request({ idempotency_key: 'batch-0001', count: 30 }), 'm'));
  assert.notEqual(generationFingerprint(a, 'm'), generationFingerprint(a, 'other-model'));
});

test('the enforced input bound comes from the ACTUAL serialized request body', () => {
  const req = request({ topic: 'mixed', count: 50 });
  const bytes = new TextEncoder().encode(serializeGenerationRequest(req, 'deepseek-flash')).length;
  assert.equal(generationInputTokenBound(req, 'deepseek-flash'), Math.max(bytes, 1));
  assert.ok(bytes > 0 && bytes <= GENERATION_MAX_INPUT_TOKENS);
  // The body really carries the DeepSeek JSON-output request and the exact output bound.
  const body = JSON.parse(serializeGenerationRequest(req, 'deepseek-flash'));
  assert.equal(body.max_tokens, generationOutputTokenBound(50));
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.deepEqual(body.thinking, { type: 'disabled' });
  assert.equal('providerOptions' in body, false);
});

test('the DeepSeek request carries no Gateway ZDR payload and the prompt asks for json', () => {
  const req = request({ topic: 'mixed', count: 50 });
  const serialized = serializeGenerationRequest(req, 'deepseek-flash');
  assert.ok(!serialized.includes('providerOptions'));
  assert.ok(!serialized.includes('zeroDataRetention'));
  assert.ok(!/retention/i.test(serialized), 'no retention guarantee is claimed');
  const body = JSON.parse(serialized);
  assert.equal(body.model, 'deepseek-flash');
  assert.equal(body.stream, false);
  assert.match(body.messages[0].content, /\bjson\b/);
  assert.match(body.messages[1].content, /\bjson\b/);
});

test('worst-case cost is bounded from the measured input/output bounds and fails closed without prices', () => {
  const outputTokens = generationOutputTokenBound(20);
  assert.equal(estimateWorstCaseCostUsd({ inputTokens: 4000, outputTokens }, null), null);
  assert.equal(estimateWorstCaseCostUsd({ inputTokens: 0, outputTokens }, { inputPer1kUsd: 1, outputPer1kUsd: 1 }), null);
  assert.equal(estimateWorstCaseCostUsd({ inputTokens: 4000, outputTokens }, { inputPer1kUsd: 0, outputPer1kUsd: 1 }), null);
  assert.equal(estimateWorstCaseCostUsd({ inputTokens: 4000, outputTokens }, { inputPer1kUsd: 1, outputPer1kUsd: Number.NaN }), null);
  const prices = { inputPer1kUsd: 0.0002, outputPer1kUsd: 0.0012 };
  const small = estimateWorstCaseCostUsd({ inputTokens: 3000, outputTokens: generationOutputTokenBound(20) }, prices)!;
  const large = estimateWorstCaseCostUsd({ inputTokens: 7000, outputTokens: generationOutputTokenBound(50) }, prices)!;
  assert.ok(small > 0 && large > small);
  assert.ok(large < 1);
  assert.equal(generationOutputTokenBound(20), 400 + 20 * 140);
  assert.ok(generationOutputTokenBound(500) <= 12000);
});

test('the reviewed DeepSeek price list is conservative and traceable', () => {
  const flash = verifiedGenerationPricing('deepseek-flash')!;
  // Peak cache-miss input $0.30/1M and peak output $1.20/1M, the conservative tiers.
  assert.equal(flash.inputPer1kUsd, 0.0003);
  assert.equal(flash.outputPer1kUsd, 0.0012);
  assert.equal(flash.cachedInputPer1kUsd, 0.000006);
  assert.equal(flash.provenance.source, 'deepseek-official-pricing');
  assert.equal(flash.provenance.modelId, 'deepseek-flash');
  assert.equal(flash.provenance.pricingUrl, 'https://api-docs.deepseek.com/quick_start/pricing');
  assert.equal(flash.provenance.pricingSnapshot, 'generated/deepseek/coordinator/pricing.txt');
  assert.equal(flash.provenance.chatApiUrl, 'https://api-docs.deepseek.com/api/create-chat-completion');
  assert.equal(flash.provenance.pricingTier, 'peak');
  assert.match(String(flash.provenance.budgetBasis), /peak-cache-miss-input/);
  assert.match(String(flash.provenance.retention), /not asserted/i);
  const pro = verifiedGenerationPricing('deepseek-v4-pro')!;
  assert.equal(pro.inputPer1kUsd, 0.00132);
  assert.equal(pro.outputPer1kUsd, 0.00396);
  // An unknown / retired model id must fail closed (null), never be guessed.
  assert.equal(verifiedGenerationPricing('deepseek-chat'), null);
  assert.equal(verifiedGenerationPricing('openai/gpt-5.6-luna'), null);

  // A worst-case 50-question batch is a small, finite, honest bound.
  const req = request({ topic: 'mixed', count: 50 });
  const bound = estimateWorstCaseCostUsd(
    { inputTokens: generationInputTokenBound(req, 'deepseek-flash'), outputTokens: generationOutputTokenBound(50) },
    flash,
  )!;
  assert.ok(bound > 0 && bound < 0.05, `unexpected worst case ${bound}`);
});

test('the peak-rate usage UPPER BOUND is computed from reported tokens and stays null when unknown', () => {
  const prices = { inputPer1kUsd: 0.0003, cachedInputPer1kUsd: 0.000006, outputPer1kUsd: 0.0012 };
  assert.equal(usageCostUpperBoundUsd({ inputTokens: 900, cachedInputTokens: 400, outputTokens: 640 }, prices), 0.000921);
  // No cache-hit breakdown: the whole prompt is conservatively cache miss.
  assert.equal(usageCostUpperBoundUsd({ inputTokens: 1000, cachedInputTokens: null, outputTokens: 1000 }, prices), 0.0015);
  // A cache-hit count above the prompt cannot lower the cost below the real prompt.
  assert.equal(usageCostUpperBoundUsd({ inputTokens: 100, cachedInputTokens: 900, outputTokens: 0 }, prices), 0.000001);
  // Unknown usage or unknown prices are null, never a fabricated 0.
  assert.equal(usageCostUpperBoundUsd({ inputTokens: null, cachedInputTokens: null, outputTokens: null }, prices), null);
  assert.equal(usageCostUpperBoundUsd({ inputTokens: 100, cachedInputTokens: null, outputTokens: null }, prices), null);
  assert.equal(usageCostUpperBoundUsd({ inputTokens: 100, cachedInputTokens: null, outputTokens: 100 }, null), null);
  assert.equal(usageCostUpperBoundUsd({ inputTokens: 100, cachedInputTokens: null, outputTokens: 100 }, { inputPer1kUsd: 0, outputPer1kUsd: 1 }), null);
});

test('the prompt uses only supported definitions and built-in example questions', () => {
  const req = request({ topic: 'cost_classification' });
  const prompt = buildGenerationPrompt(req);
  const topic = SUPPORTED_TOPICS.find((entry) => entry.id === 'cost_classification')!;
  assert.match(prompt, new RegExp(topic.definition.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').slice(0, 40)));
  assert.match(prompt, /built-in example questions/i);
  assert.match(prompt, /not owner approvals/i);
  assert.doesNotMatch(prompt, /owner-approved seed/i);
  assert.match(prompt, /never label anything verified, correct, Gold or truth/i);
  for (const seed of BUILT_IN_EXAMPLE_SEEDS.filter((entry) => entry.topicId === 'cost_classification')) assert.ok(prompt.includes(seed.question));
});

test('the output schema uses only strict-supported keywords and no truth label field', () => {
  const schema = generationOutputSchema();
  const serialized = JSON.stringify(schema);
  assert.doesNotMatch(serialized, /dataset_stage|evaluation_status|gold|verified|reviewer/i);
  // The exact count is enforced in code (and restated in the prompt); it is not
  // expressed as minItems/maxItems because DeepSeek JSON Output takes only
  // {"type": "json_object"} and enforces no schema.
  assert.doesNotMatch(serialized, /minItems|maxItems/);
  const items = (schema as any).properties.questions;
  assert.equal(items.type, 'array');
  assert.deepEqual(Object.keys(items).sort(), ['items', 'type']);
  assert.equal(items.items.additionalProperties, false);
  assert.deepEqual([...items.items.required].sort(), ['expected_filters', 'expected_response', 'question', 'style', 'topic_id']);
  for (const key of GENERATION_FILTER_KEYS) assert.ok(Object.hasOwn(items.items.properties.expected_filters.properties, key));
  assert.deepEqual([...items.items.properties.expected_filters.required].sort(), [...GENERATION_FILTER_KEYS].sort());
});

test('strict output validation accepts a real batch and rejects every contract break', () => {
  const req = request();
  const items = validateGenerationOutput(outputFor(req), req);
  assert.equal(items.length, 20);
  assert.ok(items.every((item) => SUPPORTED_TOPICS.some((topic) => topic.id === item.topicId)));

  const bad: [string, () => unknown][] = [
    ['wrong count', () => outputFor(req, (all) => all.slice(0, 19))],
    ['extra top-level key', () => ({ questions: outputFor(req).questions, extra: true })],
    ['unknown topic', () => outputFor(req, (all) => { all[0].topic_id = 'made_up'; return all; })],
    ['style/response mismatch', () => outputFor(req, (all) => { all[0].expected_response = 'abstain'; return all; })],
    ['fabricated money', () => outputFor(req, (all) => { all[0].question = 'Doanh thu hôm nay là 5.000.000 VND phải không?'; return all; })],
    ['duplicate question', () => outputFor(req, (all) => { all[1].question = all[0].question; return all; })],
    ['extra item key', () => outputFor(req, (all) => { all[0].verified = true; return all; })],
    ['unknown filter key', () => outputFor(req, (all) => { all[0].expected_filters = { secret: 'x' }; return all; })],
    ['filter with money', () => outputFor(req, (all) => { all[0].expected_filters = { item: '10 triệu' }; return all; })],
    ['not an object', () => 'nope'],
  ];
  for (const [label, build] of bad) {
    assert.throws(() => validateGenerationOutput(build(), req), (error: unknown) => error instanceof DataAdminError, label);
  }
});

test('generated provenance records model/prompt/source/run/pricing and no truth label', () => {
  const req = request({ idempotency_key: 'batch-0003' });
  const items = validateGenerationOutput(outputFor(req), req);
  const topic = SUPPORTED_TOPICS.find((entry) => entry.id === items[0].topicId)!;
  const provenance = generationItemProvenance({
    request: req, item: items[0], model: 'deepseek-flash', runId: 'job-1',
    generatedAt: `${TODAY}T00:00:00.000Z`, budgetUsd: 1, worstCaseCostUsd: 0.1, inputTokenBound: 3000,
    topic, pricing: { source: 'deepseek-official-pricing', modelId: 'deepseek-flash' },
  });
  assert.equal(provenance.model, 'deepseek-flash');
  assert.equal(provenance.runId, 'job-1');
  assert.equal(provenance.source, 'synthetic_builtin_example');
  assert.equal(provenance.generator, 'vnagent-generate');
  assert.equal(provenance.style, items[0].style);
  assert.equal(provenance.inputTokenBound, 3000);
  assert.deepEqual(provenance.pricing, { source: 'deepseek-official-pricing', modelId: 'deepseek-flash' });
  assert.match(String(provenance.seedSource), /not owner-approved/i);
  assert.ok(!('dataset_stage' in provenance) && !('evaluation_status' in provenance));
  assert.doesNotMatch(JSON.stringify(provenance), /verified|gold/i);
});

test('only final provider/payload failures are deterministic; timeouts and transport errors are not', () => {
  // A final answer from the provider: the durable outcome needs no read-back.
  for (const code of ['generation_http_error', 'generation_rate_limited', 'generation_insufficient_balance', 'generation_paid_credits_required', 'generation_invalid_response', 'generation_invalid_output', 'generation_duplicate_output']) {
    assert.equal(isDeterministicGenerationFailure(code), true, code);
  }
  // The paid call may have happened but the result was lost: the UI must reconcile.
  for (const code of ['generation_timeout', 'generation_unavailable', 'store_unavailable', 'generation_version_conflict', 'generation_budget_exceeded']) {
    assert.equal(isDeterministicGenerationFailure(code), false, code);
  }
});

test('the server-only credential helper ignores non-DeepSeek provider keys', () => {
  const env: Record<string, string> = { AI_GATEWAY_API_KEY: 'gw', OPENAI_API_KEY: 'sk', VERCEL_AI_GATEWAY_KEY: 'x' };
  assert.equal(generationApiKey({ get: (key) => env[key] }), '');
  env.DEEPSEEK_API_KEY = 'ds';
  assert.equal(generationApiKey({ get: (key) => env[key] }), 'ds');
});
