// Offline tests for the server-side Gateway generation client. The fetcher is
// always mocked: no real paid model call is made.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createGenerationClient,
  generationGatewayCost,
  providerDiagnosticOf,
  sanitizeProviderDiagnostic,
  classifyProviderFailure,
  GenerationProviderError,
  GENERATION_ENDPOINT,
  GENERATION_ERROR_BODY_LIMIT,
} from './generation-client.ts';
import { BUILT_IN_EXAMPLE_SEEDS, SUPPORTED_TOPICS, serializeGenerationRequest, validateGenerationRequest, type GenerationRequest } from './generation.ts';
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

// ── Provider error diagnostics (real HTTP-error-shaped fixtures) ──────────────

test('a real provider 400 keeps only the allowlisted status/code/parameter', async () => {
  const req = request();
  const secret = 'sk-live-DO-NOT-LEAK-0123456789';
  const providerMessage = `Unsupported parameter: 'max_tokens' is not supported with this model. prompt=${secret}`;
  // OpenAI-shaped provider error, exactly as the Gateway forwards it.
  const client = createGenerationClient({
    apiKey: 'gateway-key', model: 'openai/gpt-5.6-luna',
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

test('the DEFINITIVE production 403 (free tier / paid credits) maps to a fixed code with no message leak', async () => {
  const req = request();
  // Exact live provider body captured by the coordinator probe (message includes a
  // URL; only the fixed sentence is matched, and nothing from the body is returned).
  const liveMessage = 'Free tier users do not have access to this model. Upgrade to paid credits at https://vercel.com/d?to=%2F%5Bteam%5D%2F%7E%2Fai%3Fmodal%3Dtop-up for unrestricted access.';
  const client = createGenerationClient({
    apiKey: 'gateway-key', model: 'openai/gpt-5.6-luna',
    fetcher: (async () => new Response(JSON.stringify({
      error: { message: liveMessage, type: 'invalid_request_error', code: null, param: null },
    }), { status: 403, headers: { 'content-type': 'application/json' } })) as typeof fetch,
  });
  await assert.rejects(() => client(req, signal), (error: unknown) => {
    assert.ok(error instanceof GenerationProviderError);
    assert.equal(error.code, 'generation_paid_credits_required');
    assert.deepEqual(error.diagnostic, { status: 403, code: 'invalid_request_error', param: null });
    const serialized = JSON.stringify({ code: error.code, diagnostic: error.diagnostic, message: error.message });
    assert.ok(!serialized.includes('Free tier'), 'raw provider message leaked');
    assert.ok(!serialized.includes('vercel.com'), 'provider URL leaked');
    return true;
  });
});

test('classification matches the exact reviewed sentence only, never loose message tokens', () => {
  assert.equal(classifyProviderFailure(403, { error: { message: 'Free tier users do not have access to this model. Upgrade to paid credits at https://x.' } }), 'paid_credits_required');
  // Case/whitespace normalisation is allowed, but a token-only mention is not.
  assert.equal(classifyProviderFailure(403, { error: { message: 'FREE   TIER users do not have access to this model.' } }), 'paid_credits_required');
  assert.equal(classifyProviderFailure(403, { error: { message: 'credit card sk-live-secret declined' } }), null);
  assert.equal(classifyProviderFailure(403, { error: { message: 'Free tier users do not have access to this model.' } }), 'paid_credits_required');
  // Wrong status or no message is never classified.
  assert.equal(classifyProviderFailure(429, { error: { message: 'Free tier users do not have access to this model.' } }), null);
  assert.equal(classifyProviderFailure(403, { error: { code: 'forbidden' } }), null);
  assert.equal(classifyProviderFailure(403, null), null);
});

test('a provider rate-limit response maps to the rate-limit code and stays diagnostic-only', async () => {
  const req = request();
  const client = createGenerationClient({
    apiKey: 'k', model: 'm',
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
});

test('the provider error path sends the same serialized request and output bound', async () => {
  const req = request();
  let sent: string | null = null;
  const client = createGenerationClient({
    apiKey: 'k', model: 'openai/gpt-5.6-luna',
    fetcher: (async (_url: any, init: any) => {
      sent = init.body;
      return new Response(JSON.stringify({ error: { code: 'invalid_request_error', param: 'max_tokens' } }), { status: 400 });
    }) as typeof fetch,
  });
  await assert.rejects(() => client(req, signal));
  // The exact serialization is shared with the cost guard: no payload drift on failure.
  assert.equal(sent, serializeGenerationRequest(req, 'openai/gpt-5.6-luna'));
  const body = JSON.parse(sent!);
  assert.equal(body.max_tokens, 400 + req.count * 140);
  assert.equal(body.stream, false);
  assert.equal(body.model, 'openai/gpt-5.6-luna');
  assert.equal(body.response_format.type, 'json_schema');
  assert.equal(body.response_format.json_schema.strict, true);
  assert.equal(body.providerOptions.gateway.zeroDataRetention, true);
});


test('diagnostic values must be known, not just syntactically safe tokens', () => {
  assert.deepEqual(sanitizeProviderDiagnostic(403, { error: { code: 'sk-private-secret', param: 'private_customer_reference' } }), { status: 403, code: null, param: null });
  assert.deepEqual(sanitizeProviderDiagnostic(400, { error: { code: 'unknown_provider_code', type: 'invalid_request_error', param: 'max_tokens' } }), { status: 400, code: 'invalid_request_error', param: 'max_tokens' });
});
