// Offline behavioral tests for the server-side DeepSeek generation client. The
// fetcher is always mocked: no real paid model call is made. The tests inspect the
// EXACT host/path, the auth header and the exact request body, and prove that the
// Jev/Vercel Gateway key is never used as a fallback.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createGenerationClient,
  classifyProviderFailure,
  providerDiagnosticOf,
  sanitizeProviderDiagnostic,
  GenerationProviderError,
  GENERATION_ENDPOINT,
  GENERATION_ERROR_BODY_LIMIT,
} from './generation-client.ts';
import {
  BUILT_IN_EXAMPLE_SEEDS,
  generationApiKey,
  serializeGenerationRequest,
  validateGenerationRequest,
  type GenerationRequest,
} from './generation.ts';
import { DataAdminError } from './data-assets.ts';

const signal = new AbortController().signal;

// Peak DeepSeek flash prices, exactly as reviewed in generation-pricing.ts.
const DEEPSEEK_PRICES = { inputPer1kUsd: 0.0003, cachedInputPer1kUsd: 0.000006, outputPer1kUsd: 0.0012 };

function request(overrides: Record<string, unknown> = {}): GenerationRequest {
  return validateGenerationRequest({ topic: 'controlled_revenue', count: 20, target_language: 'vi', budget_usd: 1, ...overrides });
}

function validOutput(req: GenerationRequest) {
  const styles = ['variant', 'typo', 'ambiguous', 'out_of_scope'] as const;
  const response: Record<string, string> = { variant: 'answer', typo: 'answer', ambiguous: 'clarify', out_of_scope: 'abstain' };
  return {
    questions: Array.from({ length: req.count }, (_, index) => {
      const style = styles[index % styles.length];
      return { question: `Câu hỏi kiểm thử số ${index} cho doanh thu?`, style, topic_id: req.topicId === 'mixed' ? 'controlled_revenue' : req.topicId, expected_response: response[style], expected_filters: {} };
    }),
  };
}

function deepseekResponse(content: string, extra: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({
    id: 'chat-1',
    object: 'chat.completion',
    choices: [{ finish_reason: 'stop', index: 0, message: { role: 'assistant', content } }],
    usage: {
      prompt_tokens: 900,
      completion_tokens: 640,
      prompt_cache_hit_tokens: 400,
      prompt_cache_miss_tokens: 500,
      total_tokens: 1540,
    },
    ...extra,
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

test('a valid batch is POSTed to the exact DeepSeek host with the DeepSeek key and json_object body', async () => {
  const req = request();
  let seen: { url: string; init: any; body: any } | null = null;
  const client = createGenerationClient({
    apiKey: 'ds-secret-key', model: 'deepseek-flash', prices: DEEPSEEK_PRICES,
    fetcher: (async (url: any, init: any) => {
      seen = { url: String(url), init, body: JSON.parse(init.body) };
      return deepseekResponse(JSON.stringify(validOutput(req)));
    }) as typeof fetch,
  });
  const outcome = await client(req, signal);

  // Exact host + path, auth header and content type.
  assert.equal(seen!.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(seen!.url, GENERATION_ENDPOINT);
  assert.equal(seen!.init.method, 'POST');
  assert.equal(seen!.init.redirect, 'error');
  assert.equal(seen!.init.headers.Authorization, 'Bearer ds-secret-key');
  assert.equal(seen!.init.headers['Content-Type'], 'application/json');
  assert.equal(seen!.init.headers.authorization, undefined);

  // Exact body contract for DeepSeek's official OpenAI-compatible API.
  assert.equal(seen!.body.model, 'deepseek-flash');
  assert.equal(seen!.body.stream, false);
  assert.equal(seen!.body.max_tokens, 400 + 20 * 140);
  assert.deepEqual(seen!.body.thinking, { type: 'disabled' });
  assert.deepEqual(seen!.body.response_format, { type: 'json_object' });
  assert.equal(Array.isArray(seen!.body.messages), true);
  assert.equal(seen!.body.messages[0].role, 'system');
  // DeepSeek JSON Output requires the word "json" in the prompt.
  assert.match(seen!.body.messages[0].content, /json/);
  assert.match(seen!.body.messages[1].content, /json/);
  assert.match(seen!.body.messages[1].content, /"questions"/);

  // No Gateway-only payload, no ZDR claim, no Gateway key.
  const serialized = JSON.stringify(seen!.body);
  assert.equal('providerOptions' in seen!.body, false);
  assert.ok(!serialized.includes('zeroDataRetention'));
  assert.ok(!serialized.includes('ai-gateway'));
  assert.ok(!serialized.includes('ds-secret-key'));

  // Only definition/example material is sent: no caller token, no fabricated owner approval.
  for (const seed of BUILT_IN_EXAMPLE_SEEDS.filter((entry) => entry.topicId === 'controlled_revenue')) assert.ok(serialized.includes(seed.question));
  assert.ok(serialized.includes('not owner-approved'));
  assert.ok(!/owner-approved seed/i.test(serialized));

  assert.equal(outcome.items.length, 20);
  assert.equal(outcome.model, 'deepseek-flash');
  assert.deepEqual(outcome.usage, { input: 900, output: 640 });
  // DeepSeek reports no dollar cost, so the billed cost is genuinely unknown.
  assert.equal(outcome.cost, null);
  // The conservative peak-rate UPPER BOUND is kept separate, never labelled actual:
  // 500 miss * 0.0003/1k + 400 hit * 0.000006/1k + 640 out * 0.0012/1k.
  assert.equal(outcome.usageCostUpperBoundUsd, 0.000921);
});

test('the DeepSeek key is the only credential and the Gateway key is never a fallback', () => {
  const gatewayOnly: Record<string, string> = { AI_GATEWAY_API_KEY: 'gw-secret', OPENAI_API_KEY: 'sk-secret' };
  assert.equal(generationApiKey({ get: (key) => gatewayOnly[key] }), '');
  assert.throws(
    () => createGenerationClient({ apiKey: generationApiKey({ get: (key) => gatewayOnly[key] }), model: 'deepseek-flash' }),
    (error: unknown) => error instanceof DataAdminError && error.code === 'generation_unconfigured',
  );
  gatewayOnly.DEEPSEEK_API_KEY = 'ds-key';
  assert.equal(generationApiKey({ get: (key) => gatewayOnly[key] }), 'ds-key');
});

test('the billed cost is always null and unknown usage/prices keeps the upper bound null', async () => {
  const req = request();
  const noUsage = createGenerationClient({
    apiKey: 'k', model: 'deepseek-flash', prices: DEEPSEEK_PRICES,
    fetcher: (async () => new Response(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(validOutput(req)) } }],
    }), { status: 200 })) as typeof fetch,
  });
  const noUsageOutcome = await noUsage(req, signal);
  assert.deepEqual(noUsageOutcome.usage, { input: null, output: null });
  assert.equal(noUsageOutcome.cost, null);
  assert.equal(noUsageOutcome.usageCostUpperBoundUsd, null);

  const noPrices = createGenerationClient({
    apiKey: 'k', model: 'deepseek-flash',
    fetcher: (async () => deepseekResponse(JSON.stringify(validOutput(req)))) as typeof fetch,
  });
  const noPricesOutcome = await noPrices(req, signal);
  assert.deepEqual(noPricesOutcome.usage, { input: 900, output: 640 });
  // Usage is known but no reviewed price is configured: reported cost stays null
  // and no upper bound is invented.
  assert.equal(noPricesOutcome.cost, null);
  assert.equal(noPricesOutcome.usageCostUpperBoundUsd, null);
});

test('the usage upper bound prices a cache-hit-free prompt conservatively as all cache miss', async () => {
  const req = request();
  const client = createGenerationClient({
    apiKey: 'k', model: 'deepseek-flash', prices: DEEPSEEK_PRICES,
    fetcher: (async () => new Response(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(validOutput(req)) } }],
      usage: { prompt_tokens: 1000, completion_tokens: 1000 },
    }), { status: 200 })) as typeof fetch,
  });
  const outcome = await client(req, signal);
  assert.equal(outcome.cost, null);
  // 1000 miss * 0.0003/1k + 1000 out * 0.0012/1k = 0.0015.
  assert.equal(outcome.usageCostUpperBoundUsd, 0.0015);
});

test('an invalid model batch is rejected as a whole with a stable error', async () => {
  const req = request();
  const wrongCount = { questions: validOutput(req).questions.slice(0, 19) };
  const client = createGenerationClient({
    apiKey: 'k', model: 'deepseek-flash',
    fetcher: (async () => deepseekResponse(JSON.stringify(wrongCount))) as typeof fetch,
  });
  await assert.rejects(() => client(req, signal), (error: unknown) => error instanceof DataAdminError && error.code === 'generation_invalid_output');
});

test('a truncated JSON answer (finish_reason length) fails closed as an invalid response', async () => {
  const req = request();
  const client = createGenerationClient({
    apiKey: 'k', model: 'deepseek-flash',
    fetcher: (async () => new Response(JSON.stringify({
      choices: [{ finish_reason: 'length', message: { role: 'assistant', content: JSON.stringify(validOutput(req)) } }],
      usage: { prompt_tokens: 100, completion_tokens: 7400 },
    }), { status: 200 })) as typeof fetch,
  });
  await assert.rejects(() => client(req, signal), (error: unknown) => error instanceof DataAdminError && error.code === 'generation_invalid_response');
});

test('HTTP errors, malformed bodies and non-JSON content fail closed', async () => {
  const req = request();
  const rateLimited = createGenerationClient({ apiKey: 'k', model: 'm', fetcher: (async () => new Response('no', { status: 429 })) as typeof fetch });
  await assert.rejects(() => rateLimited(req, signal), (error: unknown) => error instanceof DataAdminError && error.code === 'generation_rate_limited');
  const httpError = createGenerationClient({ apiKey: 'k', model: 'm', fetcher: (async () => new Response('no', { status: 500 })) as typeof fetch });
  await assert.rejects(() => httpError(req, signal), (error: unknown) => error instanceof DataAdminError && error.code === 'generation_http_error');
  const badContent = createGenerationClient({ apiKey: 'k', model: 'm', fetcher: (async () => deepseekResponse('not json')) as typeof fetch });
  await assert.rejects(() => badContent(req, signal), (error: unknown) => error instanceof DataAdminError && error.code === 'generation_invalid_response');
  const badShape = createGenerationClient({ apiKey: 'k', model: 'm', fetcher: (async () => new Response(JSON.stringify({ choices: [] }))) as typeof fetch });
  await assert.rejects(() => badShape(req, signal), (error: unknown) => error instanceof DataAdminError && error.code === 'generation_invalid_response');
});

test('the documented DeepSeek 402 insufficient balance maps to a fixed code', async () => {
  const req = request();
  const client = createGenerationClient({
    apiKey: 'k', model: 'deepseek-flash',
    fetcher: (async () => new Response(JSON.stringify({
      error: { message: 'Insufficient Balance', type: 'insufficient_balance_error', param: null, code: null },
    }), { status: 402 })) as typeof fetch,
  });
  await assert.rejects(() => client(req, signal), (error: unknown) => {
    assert.ok(error instanceof GenerationProviderError);
    assert.equal(error.code, 'generation_insufficient_balance');
    assert.deepEqual(error.diagnostic, { status: 402, code: 'insufficient_balance_error', param: null });
    assert.ok(!JSON.stringify(error).includes('Insufficient Balance'));
    return true;
  });
});

test('classification is by documented HTTP status only, never by message tokens', () => {
  assert.equal(classifyProviderFailure(402, { error: { message: 'Insufficient Balance' } }), 'insufficient_balance');
  assert.equal(classifyProviderFailure(402, null), 'insufficient_balance');
  // A message that merely mentions money is never a classification.
  assert.equal(classifyProviderFailure(400, { error: { message: 'Insufficient Balance' } }), null);
  assert.equal(classifyProviderFailure(403, { error: { message: 'insufficient balance' } }), null);
  assert.equal(classifyProviderFailure(500, { error: { code: 'insufficient_balance_error' } }), null);
});

// ── Provider error diagnostics (real HTTP-error-shaped fixtures) ──────────────

test('a real provider 400 keeps only the allowlisted status/code/parameter', async () => {
  const req = request();
  const secret = 'sk-live-DO-NOT-LEAK-0123456789';
  const providerMessage = `Unsupported parameter: 'max_tokens' is not supported with this model. prompt=${secret}`;
  const client = createGenerationClient({
    apiKey: 'ds-secret-key', model: 'deepseek-flash',
    fetcher: (async () => new Response(JSON.stringify({
      error: { message: providerMessage, type: 'invalid_request_error', param: 'max_tokens', code: null },
    }), { status: 400, headers: { 'content-type': 'application/json' } })) as typeof fetch,
  });
  await assert.rejects(() => client(req, signal), (error: unknown) => {
    assert.ok(error instanceof GenerationProviderError);
    assert.equal(error.code, 'generation_http_error');
    assert.deepEqual(error.diagnostic, { status: 400, code: 'invalid_request_error', param: 'max_tokens' });
    assert.deepEqual(providerDiagnosticOf(error), { status: 400, code: 'invalid_request_error', param: 'max_tokens' });
    const serialized = JSON.stringify({ code: error.code, diagnostic: error.diagnostic, message: error.message });
    assert.ok(!serialized.includes('is not supported'), 'raw provider message leaked');
    assert.ok(!serialized.includes(secret), 'provider message secret leaked');
    assert.ok(!serialized.includes('prompt='), 'prompt fragment leaked');
    return true;
  });
});

test('a provider rate-limit response maps to the rate-limit code and stays diagnostic-only', async () => {
  const req = request();
  const client = createGenerationClient({
    apiKey: 'k', model: 'deepseek-flash',
    fetcher: (async () => new Response(JSON.stringify({
      error: { message: 'Rate limit reached', type: 'rate_limit_error', code: 'rate_limit_exceeded', param: null },
    }), { status: 429 })) as typeof fetch,
  });
  await assert.rejects(() => client(req, signal), (error: unknown) => {
    assert.ok(error instanceof GenerationProviderError);
    assert.equal(error.code, 'generation_rate_limited');
    assert.deepEqual(error.diagnostic, { status: 429, code: 'rate_limit_exceeded', param: null });
    return true;
  });
});

test('a non-JSON or oversized provider error body never throws or leaks', async () => {
  const req = request();
  const plainText = createGenerationClient({
    apiKey: 'k', model: 'm',
    fetcher: (async () => new Response('upstream exploded with sk-secret', { status: 500 })) as typeof fetch,
  });
  await assert.rejects(() => plainText(req, signal), (error: unknown) => {
    assert.ok(error instanceof DataAdminError);
    assert.equal(error.code, 'generation_http_error');
    assert.deepEqual(providerDiagnosticOf(error), { status: 500, code: null, param: null });
    assert.equal(error.message, 'generation_http_error');
    return true;
  });

  const oversized = createGenerationClient({
    apiKey: 'k', model: 'm',
    fetcher: (async () => new Response(JSON.stringify({
      error: { message: 'x'.repeat(GENERATION_ERROR_BODY_LIMIT + 1024), type: 'invalid_request_error', param: 'max_tokens' },
    }), { status: 400 })) as typeof fetch,
  });
  await assert.rejects(() => oversized(req, signal), (error: unknown) => {
    // The body is read only up to the bound, so nothing from it is trusted.
    assert.deepEqual(providerDiagnosticOf(error), { status: 400, code: null, param: null });
    return true;
  });
});

test('sanitizeProviderDiagnostic rejects hostile payloads', () => {
  assert.deepEqual(sanitizeProviderDiagnostic(400, { error: { code: 'bad code!', type: 'invalid_request_error', param: 'x'.repeat(200) } }), { status: 400, code: 'invalid_request_error', param: null });
  assert.deepEqual(sanitizeProviderDiagnostic(400, { error: { code: { nested: true }, param: ['max_tokens'] } }), { status: 400, code: null, param: null });
  assert.deepEqual(sanitizeProviderDiagnostic(400, 'raw string'), { status: 400, code: null, param: null });
  assert.deepEqual(sanitizeProviderDiagnostic(400, { error: { code: 'invalid_request_error', param: 'max_completion_tokens' } }), { status: 400, code: 'invalid_request_error', param: 'max_completion_tokens' });
  // A Gateway-only parameter name is no longer allowlisted for this lane.
  assert.deepEqual(sanitizeProviderDiagnostic(400, { error: { code: 'invalid_request_error', param: 'providerOptions.gateway.zeroDataRetention' } }), { status: 400, code: 'invalid_request_error', param: null });
});

test('the provider error path sends the same serialized DeepSeek request and output bound', async () => {
  const req = request();
  let sent: string | null = null;
  const client = createGenerationClient({
    apiKey: 'k', model: 'deepseek-flash',
    fetcher: (async (_url: any, init: any) => {
      sent = init.body;
      return new Response(JSON.stringify({ error: { code: 'invalid_request_error', param: 'max_tokens' } }), { status: 400 });
    }) as typeof fetch,
  });
  await assert.rejects(() => client(req, signal));
  // The exact serialization is shared with the cost guard: no payload drift on failure.
  assert.equal(sent, serializeGenerationRequest(req, 'deepseek-flash'));
  const body = JSON.parse(sent!);
  assert.equal(body.max_tokens, 400 + req.count * 140);
  assert.equal(body.stream, false);
  assert.equal(body.model, 'deepseek-flash');
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.deepEqual(body.thinking, { type: 'disabled' });
  assert.equal('providerOptions' in body, false);
});

test('diagnostic values must be known, not just syntactically safe tokens', () => {
  assert.deepEqual(sanitizeProviderDiagnostic(403, { error: { code: 'sk-private-secret', param: 'private_customer_reference' } }), { status: 403, code: null, param: null });
  assert.deepEqual(sanitizeProviderDiagnostic(400, { error: { code: 'unknown_provider_code', type: 'invalid_request_error', param: 'max_tokens' } }), { status: 400, code: 'invalid_request_error', param: 'max_tokens' });
});
