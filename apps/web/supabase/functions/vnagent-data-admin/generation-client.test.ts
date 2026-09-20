// Offline tests for the server-side Gateway generation client. The fetcher is
// always mocked: no real paid model call is made.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGenerationClient, generationGatewayCost, GENERATION_ENDPOINT } from './generation-client.ts';
import { BUILT_IN_EXAMPLE_SEEDS, SUPPORTED_TOPICS, validateGenerationRequest, type GenerationRequest } from './generation.ts';
import { DataAdminError } from './data-assets.ts';

const signal = new AbortController().signal;

function request(overrides: Record<string, unknown> = {}): GenerationRequest {
  return validateGenerationRequest({ topic: 'controlled_revenue', count: 20, target_language: 'vi', budget_usd: 1, ...overrides });
}

function validOutput(req: GenerationRequest) {
  const styles = ['variant', 'typo', 'ambiguous', 'out_of_scope'] as const;
  const response: Record<string, string> = { variant: 'answer', typo: 'answer', ambiguous: 'clarify', out_of_scope: 'abstain' };
  return {
    questions: Array.from({ length: req.count }, (_, index) => {
      const style = styles[index % styles.length];
      return { question: `Câu hỏi kiểm thử số ${index} cho doanh thu?`, style, topic_id: req.topicId === 'mixed' ? SUPPORTED_TOPICS[0].id : req.topicId, expected_response: response[style], expected_filters: {} };
    }),
  };
}

function gatewayResponse(content: string, extra: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({
    choices: [{ message: { role: 'assistant', content } }],
    usage: { prompt_tokens: 900, completion_tokens: 640 },
    providerMetadata: { gateway: { cost: '0.0123' } },
    ...extra,
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

test('a valid batch is sent with ZDR and the strict schema, then parsed', async () => {
  const req = request();
  let seen: { url: string; body: any } | null = null;
  const client = createGenerationClient({
    apiKey: 'gateway-key', model: 'openai/gpt-test',
    fetcher: (async (url: any, init: any) => {
      seen = { url: String(url), body: JSON.parse(init.body) };
      return gatewayResponse(JSON.stringify(validOutput(req)));
    }) as typeof fetch,
  });
  const outcome = await client(req, signal);
  assert.equal(outcome.items.length, 20);
  assert.equal(outcome.model, 'openai/gpt-test');
  assert.equal(outcome.cost, 0.0123);
  assert.deepEqual(outcome.usage, { input: 900, output: 640 });
  assert.equal(seen!.url, GENERATION_ENDPOINT);
  assert.equal(seen!.body.providerOptions.gateway.zeroDataRetention, true);
  assert.equal(seen!.body.stream, false);
  assert.equal(seen!.body.model, 'openai/gpt-test');
  assert.equal(seen!.body.response_format.type, 'json_schema');
  assert.equal(seen!.body.response_format.json_schema.strict, true);
  assert.equal(seen!.body.max_tokens, 400 + 20 * 140);
  // Only definition/example material is sent: no caller token, no answer.
  const sent = JSON.stringify(seen!.body);
  for (const seed of BUILT_IN_EXAMPLE_SEEDS.filter((entry) => entry.topicId === 'controlled_revenue')) assert.ok(sent.includes(seed.question));
  assert.ok(!sent.includes('gateway-key'));
  assert.ok(sent.includes('not owner-approved'));
  assert.ok(!/owner-approved seed/i.test(sent));
});

test('missing provider usage is null, never a fabricated zero', async () => {
  const req = request();
  const client = createGenerationClient({
    apiKey: 'k', model: 'm',
    fetcher: (async () => new Response(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: JSON.stringify(validOutput(req)) } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch,
  });
  const outcome = await client(req, signal);
  assert.deepEqual(outcome.usage, { input: null, output: null });
  assert.equal(outcome.cost, null);
});

test('an invalid model batch is rejected as a whole with a stable error', async () => {
  const req = request();
  const wrongCount = { questions: validOutput(req).questions.slice(0, 19) };
  const client = createGenerationClient({
    apiKey: 'k', model: 'm',
    fetcher: (async () => gatewayResponse(JSON.stringify(wrongCount))) as typeof fetch,
  });
  await assert.rejects(() => client(req, signal), (error: unknown) => error instanceof DataAdminError && error.code === 'generation_invalid_output');
});

test('HTTP errors, malformed bodies and non-JSON content fail closed', async () => {
  const req = request();
  const rateLimited = createGenerationClient({ apiKey: 'k', model: 'm', fetcher: (async () => new Response('no', { status: 429 })) as typeof fetch });
  await assert.rejects(() => rateLimited(req, signal), (error: unknown) => error instanceof DataAdminError && error.code === 'generation_rate_limited');
  const httpError = createGenerationClient({ apiKey: 'k', model: 'm', fetcher: (async () => new Response('no', { status: 500 })) as typeof fetch });
  await assert.rejects(() => httpError(req, signal), (error: unknown) => error instanceof DataAdminError && error.code === 'generation_http_error');
  const badContent = createGenerationClient({ apiKey: 'k', model: 'm', fetcher: (async () => gatewayResponse('not json')) as typeof fetch });
  await assert.rejects(() => badContent(req, signal), (error: unknown) => error instanceof DataAdminError && error.code === 'generation_invalid_response');
  const badShape = createGenerationClient({ apiKey: 'k', model: 'm', fetcher: (async () => new Response(JSON.stringify({ choices: [] }))) as typeof fetch });
  await assert.rejects(() => badShape(req, signal), (error: unknown) => error instanceof DataAdminError && error.code === 'generation_invalid_response');
});

test('a missing key is refused before any request', () => {
  assert.throws(() => createGenerationClient({ apiKey: '', model: 'm' }), (error: unknown) => error instanceof DataAdminError && error.code === 'generation_unconfigured');
  assert.throws(() => createGenerationClient({ apiKey: 'k', model: '' }), (error: unknown) => error instanceof DataAdminError && error.code === 'generation_unconfigured');
});

test('gateway cost is read from providerMetadata or usage and stays null when absent', () => {
  assert.equal(generationGatewayCost({ providerMetadata: { gateway: { cost: '0.5' } } }), 0.5);
  assert.equal(generationGatewayCost({ usage: { cost: 0.25 } }), 0.25);
  assert.equal(generationGatewayCost({ usage: {} }), null);
  assert.equal(generationGatewayCost({ providerMetadata: { gateway: { cost: 'abc' } } }), null);
  assert.equal(generationGatewayCost(null), null);
});
