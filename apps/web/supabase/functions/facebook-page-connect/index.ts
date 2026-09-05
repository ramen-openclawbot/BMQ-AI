import { createClient } from "npm:@supabase/supabase-js@2.90.1";
import { constantTimeStringEqual } from "../_shared/facebook-messenger.ts";

export type FacebookPageConnectEnv = {
  META_APP_ID?: string;
  META_APP_SECRET?: string;
  META_LOGIN_CONFIG_ID?: string;
  META_GRAPH_VERSION?: string;
  FACEBOOK_OAUTH_STATE_SECRET?: string;
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
};
export type VerifiedUser = { id: string };
export type OAuthStateCreateInput = {
  stateHash: string;
  actorId: string;
  redirectUrl: string;
  expectedPageId: string | null;
  expiresAt: string;
};
export type ConsumedOAuthState = {
  actorId: string;
  redirectUrl: string;
  expectedPageId: string | null;
};
export type FacebookPageCandidate = {
  id: string;
  name: string;
  accessToken: string;
  tasks?: string[];
  perms?: string[];
};
export type SafePageCandidate = {
  candidateId: string;
  pageName: string;
  pageIdSuffix: string;
  permissions?: string[];
  expiresAt?: string;
};
export type ConsumedPageCandidate = {
  pageId: string;
  pageName: string;
  pageAccessToken: string;
  permissions: string[];
};
export type FacebookPageConnectionStatus = {
  connected: boolean;
  featureEnabled: boolean;
  pageName: string | null;
  pageIdSuffix: string | null;
  connectedAt: string | null;
  connectionStatus?: string | null;
  pendingPageCandidates?: SafePageCandidate[];
};
export type FacebookPageConnectDeps = {
  now: () => Date;
  randomNonce: () => string;
  verifyJwt: (token: string) => Promise<VerifiedUser | null>;
  hasModulePermission: (userId: string, moduleKey: string, mode: "view" | "edit") => Promise<boolean>;
  isOwner: (userId: string) => Promise<boolean>;
  createOAuthState: (input: OAuthStateCreateInput) => Promise<void>;
  consumeOAuthState: (stateHash: string) => Promise<ConsumedOAuthState | null>;
  exchangeCode: (input: { code: string; redirectUri: string }) => Promise<{ accessToken: string }>;
  exchangeLongLivedUserToken: (input: { accessToken: string }) => Promise<{ accessToken: string }>;
  fetchPages: (input: { accessToken: string }) => Promise<FacebookPageCandidate[]>;
  storePageSelectionCandidates: (input: { actorId: string; candidates: FacebookPageCandidate[]; expiresAt: string }) => Promise<SafePageCandidate[]>;
  listPendingPageSelection: (userId: string) => Promise<SafePageCandidate[]>;
  consumePageSelectionCandidate: (input: { actorId: string; candidateId: string }) => Promise<ConsumedPageCandidate | null>;
  subscribePageWebhooks: (input: { pageId: string; pageAccessToken: string }) => Promise<void>;
  commitPageConnection: (input: { pageId: string; pageName: string; pageAccessToken: string; actorId: string; permissions: string[]; connectedAt: string }) => Promise<void>;
  getConnectionStatus: () => Promise<FacebookPageConnectionStatus>;
};

type OAuthStatePayload = {
  v: "facebook-page-connect-v1";
  nonce: string;
  actorId: string;
  redirectUrl: string;
  expectedPageId: string | null;
  iat: number;
  exp: number;
};

const STATE_VERSION = "facebook-page-connect-v1";
const DEFAULT_GRAPH_VERSION = "v26.0";
const STATE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_APP_REDIRECT = "https://ai.banhmique.vn/marketing-sales/facebook-page";
const ALLOWED_REDIRECT_ORIGINS = new Set([
  "https://bmqvn.lovable.app",
  "https://bmq-ai.vercel.app",
  "https://ai.banhmique.vn",
  "http://localhost:5173",
  "http://localhost:8080",
]);
const CORS_FIX_VERSION = "cors-retry-fix-v1";
const CORS_ALLOW_HEADERS = "authorization, x-client-info, apikey, content-type";
const REQUIRED_PAGE_TASKS = new Set(["MESSAGING", "MANAGE"]);
const SAFE_ERROR_RE = /^[a-z0-9_:-]{1,80}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PAGE_ID_RE = /^[0-9]{5,32}$/;
const CANDIDATE_ID_RE = /^[A-Za-z0-9_-]{8,80}$/;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const jsonResponse = (body: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function corsHeadersForRequest(request: Request): Record<string, string> {
  const origin = request.headers.get("origin") || "";
  if (!ALLOWED_REDIRECT_ORIGINS.has(origin)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": CORS_ALLOW_HEADERS,
    "access-control-max-age": "86400",
    "vary": "Origin",
    "x-bmq-facebook-connect-version": CORS_FIX_VERSION,
  };
}

function withCors(response: Response, request: Request): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(corsHeadersForRequest(request))) {
    headers.set(name, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export async function handleFacebookPageConnect(
  request: Request,
  env: FacebookPageConnectEnv = Deno.env.toObject(),
  deps?: FacebookPageConnectDeps,
): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeadersForRequest(request) });
  }
  if (request.method === "POST") {
    try {
      return withCors(await handlePost(request, env, deps), request);
    } catch {
      return withCors(jsonResponse({ error: "request_failed" }, 500), request);
    }
  }
  if (request.method === "GET") return handleCallback(request, env, deps);
  return withCors(jsonResponse({ error: "method_not_allowed" }, 405), request);
}

async function handlePost(request: Request, env: FacebookPageConnectEnv, deps?: FacebookPageConnectDeps): Promise<Response> {
  const token = bearer(request);
  if (!token) return jsonResponse({ error: "unauthorized" }, 401);
  let active: FacebookPageConnectDeps;
  try {
    active = deps ?? createDeps(env);
  } catch {
    return jsonResponse({ error: "service_not_configured" }, 503);
  }
  const user = await active.verifyJwt(token);
  if (!user) return jsonResponse({ error: "unauthorized" }, 401);

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "invalid_json" }, 400);
  }

  if (body.action === "status") {
    if (!(await active.hasModulePermission(user.id, "facebook_messenger", "view"))) {
      return jsonResponse({ error: "forbidden" }, 403);
    }
    const [status, pendingPageCandidates] = await Promise.all([
      active.getConnectionStatus(),
      active.listPendingPageSelection(user.id),
    ]);
    return jsonResponse({ ...minimizeStatus(status), pendingPageCandidates: minimizeCandidates(pendingPageCandidates) });
  }

  if (body.action === "finalize_candidate") {
    const candidateId = typeof body.candidate_id === "string" ? body.candidate_id.trim() : "";
    if (!CANDIDATE_ID_RE.test(candidateId)) return jsonResponse({ error: "invalid_candidate_id" }, 422);
    if (!(await isApprovedActor(active, user.id))) return jsonResponse({ error: "forbidden" }, 403);
    const candidate = await active.consumePageSelectionCandidate({ actorId: user.id, candidateId });
    if (!candidate) return jsonResponse({ error: "candidate_not_found" }, 404);
    const finished = await finishPageConnection(active, {
      id: candidate.pageId,
      name: candidate.pageName,
      accessToken: candidate.pageAccessToken,
      tasks: candidate.permissions,
    }, user.id);
    if (!finished.ok) return jsonResponse({ error: finished.reason }, finished.reason === "subscription_failed" ? 502 : 500);
    return jsonResponse({
      connected: true,
      pageName: candidate.pageName,
      pageIdSuffix: candidate.pageId.slice(-4),
    });
  }

  if (body.action !== "start") return jsonResponse({ error: "invalid_action" }, 422);
  if (!(await isApprovedActor(active, user.id))) return jsonResponse({ error: "forbidden" }, 403);

  if (!env.META_APP_ID || !env.META_LOGIN_CONFIG_ID || !env.FACEBOOK_OAUTH_STATE_SECRET || env.FACEBOOK_OAUTH_STATE_SECRET.length < 32 || !env.SUPABASE_URL) {
    return jsonResponse({ error: "service_not_configured" }, 503);
  }

  const redirectUrl = normalizeAppRedirect(body.redirect);
  const expectedPageId = normalizeExpectedPageId(body.expected_page_id);
  if (body.expected_page_id !== undefined && expectedPageId === null) {
    return jsonResponse({ error: "invalid_expected_page_id" }, 422);
  }

  const now = active.now();
  const expiresAt = new Date(now.getTime() + STATE_TTL_MS).toISOString();
  const payload: OAuthStatePayload = {
    v: STATE_VERSION,
    nonce: active.randomNonce(),
    actorId: user.id,
    redirectUrl,
    expectedPageId,
    iat: Math.floor(now.getTime() / 1000),
    exp: Math.floor((now.getTime() + STATE_TTL_MS) / 1000),
  };
  const state = await signOAuthState(payload, env.FACEBOOK_OAUTH_STATE_SECRET);
  const stateHash = await sha256Hex(state);
  await active.createOAuthState({ stateHash, actorId: user.id, redirectUrl, expectedPageId, expiresAt });

  const graphVersion = normalizeGraphVersion(env.META_GRAPH_VERSION);
  const authUrl = new URL(`https://www.facebook.com/${graphVersion}/dialog/oauth`);
  authUrl.searchParams.set("client_id", env.META_APP_ID);
  authUrl.searchParams.set("config_id", env.META_LOGIN_CONFIG_ID);
  authUrl.searchParams.set("redirect_uri", `${env.SUPABASE_URL}/functions/v1/facebook-page-connect`);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("override_default_response_type", "true");
  authUrl.searchParams.set("auth_type", "rerequest");
  authUrl.searchParams.set("state", state);

  return jsonResponse({ authUrl: authUrl.toString(), expiresAt });
}

async function handleCallback(request: Request, env: FacebookPageConnectEnv, deps?: FacebookPageConnectDeps): Promise<Response> {
  const url = new URL(request.url);
  const state = url.searchParams.get("state") || "";
  const secret = env.FACEBOOK_OAUTH_STATE_SECRET || "";
  const payload = secret ? await verifyOAuthState(state, secret, deps ? deps.now().getTime() : Date.now()) : null;
  if (!payload) {
    return redirectWith(DEFAULT_APP_REDIRECT, { facebook_connect_error: "invalid_state" });
  }
  let active: FacebookPageConnectDeps;
  try {
    active = deps ?? createDeps(env);
  } catch {
    return redirectWith(payload.redirectUrl, { facebook_connect_error: "service_not_configured" });
  }
  const stateHash = await sha256Hex(state);
  const consumed = await active.consumeOAuthState(stateHash);
  if (!consumed) {
    return redirectWith(payload.redirectUrl, { facebook_connect_error: "invalid_or_expired_state" });
  }
  const redirectUrl = normalizeAppRedirect(consumed.redirectUrl);
  if (consumed.actorId !== payload.actorId || consumed.expectedPageId !== payload.expectedPageId) {
    return redirectWith(redirectUrl, { facebook_connect_error: "state_mismatch" });
  }

  const metaError = url.searchParams.get("error");
  if (metaError) {
    return redirectWith(redirectUrl, { facebook_connect_error: safeErrorCode(`meta_${metaError}`) });
  }

  const code = url.searchParams.get("code") || "";
  if (!code) return redirectWith(redirectUrl, { facebook_connect_error: "missing_code" });
  if (!env.META_APP_ID || !env.META_APP_SECRET || !env.SUPABASE_URL) {
    return redirectWith(redirectUrl, { facebook_connect_error: "service_not_configured" });
  }
  if (!(await isApprovedActor(active, consumed.actorId))) {
    return redirectWith(redirectUrl, { facebook_connect_error: "forbidden" });
  }

  try {
    const redirectUri = `${env.SUPABASE_URL}/functions/v1/facebook-page-connect`;
    let shortToken: { accessToken: string };
    let longToken: { accessToken: string };
    try {
      shortToken = await active.exchangeCode({ code, redirectUri });
      longToken = await active.exchangeLongLivedUserToken({ accessToken: shortToken.accessToken });
    } catch {
      return redirectWith(redirectUrl, { facebook_connect_error: "token_exchange_failed" });
    }

    let pages: FacebookPageCandidate[];
    try {
      pages = await active.fetchPages({ accessToken: longToken.accessToken });
    } catch {
      return redirectWith(redirectUrl, { facebook_connect_error: "page_lookup_failed" });
    }

    const selected = selectPage(pages, consumed.expectedPageId);
    if (!selected.ok) {
      if (selected.reason === "multiple_pages_select_page_id") {
        const expiresAt = new Date(active.now().getTime() + STATE_TTL_MS).toISOString();
        const pendingPageCandidates = await active.storePageSelectionCandidates({
          actorId: consumed.actorId,
          candidates: selected.pages || [],
          expiresAt,
        });
        if (pendingPageCandidates.length > 0) {
          return redirectWith(redirectUrl, { facebook_connect: "select_page" });
        }
        return redirectWith(redirectUrl, { facebook_connect_error: "page_selection_unavailable" });
      }
      return redirectWith(redirectUrl, { facebook_connect_error: selected.reason });
    }

    const finished = await finishPageConnection(active, selected.page, consumed.actorId);
    if (!finished.ok) {
      return redirectWith(redirectUrl, { facebook_connect_error: finished.reason });
    }
    return redirectWith(redirectUrl, {
      facebook_connect: "success",
      facebook_page: selected.page.name.slice(0, 80),
      facebook_page_id_suffix: selected.page.id.slice(-4),
    });
  } catch {
    return redirectWith(redirectUrl, { facebook_connect_error: "provider_exchange_failed" });
  }
}

async function isApprovedActor(active: FacebookPageConnectDeps, userId: string): Promise<boolean> {
  const [owner, canEdit] = await Promise.all([
    active.isOwner(userId),
    active.hasModulePermission(userId, "facebook_messenger", "edit"),
  ]);
  return owner || canEdit;
}

async function finishPageConnection(
  active: FacebookPageConnectDeps,
  page: FacebookPageCandidate,
  actorId: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await active.subscribePageWebhooks({ pageId: page.id, pageAccessToken: page.accessToken });
  } catch {
    return { ok: false, reason: "subscription_failed" };
  }
  try {
    await active.commitPageConnection({
      pageId: page.id,
      pageName: page.name,
      pageAccessToken: page.accessToken,
      actorId,
      permissions: normalizedPermissions(page),
      connectedAt: active.now().toISOString(),
    });
  } catch {
    return { ok: false, reason: "provider_storage_failed" };
  }
  return { ok: true };
}

function createDeps(env: FacebookPageConnectEnv): FacebookPageConnectDeps {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("missing_supabase_config");
  const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const graphVersion = normalizeGraphVersion(env.META_GRAPH_VERSION);
  return {
    now: () => new Date(),
    randomNonce: () => crypto.randomUUID(),
    verifyJwt: async (token) => {
      const { data, error } = await admin.auth.getUser(token);
      return error || !data.user ? null : { id: data.user.id };
    },
    hasModulePermission: async (userId, moduleKey, mode) => hasPermission(admin, userId, moduleKey, mode),
    isOwner: async (userId) => isOwner(admin, userId),
    createOAuthState: async (input) => {
      const { error } = await admin.rpc("facebook_begin_page_oauth_state", {
        p_state_hash: input.stateHash,
        p_actor_id: input.actorId,
        p_redirect_url: input.redirectUrl,
        p_expected_page_id: input.expectedPageId,
        p_expires_at: input.expiresAt,
      });
      if (error) throw error;
    },
    consumeOAuthState: async (stateHash) => {
      const { data, error } = await admin.rpc("facebook_consume_page_oauth_state", { p_state_hash: stateHash });
      if (error || !data) return null;
      const row = Array.isArray(data) ? data[0] : data;
      if (!row) return null;
      return {
        actorId: row.actor_id,
        redirectUrl: row.redirect_url,
        expectedPageId: row.expected_page_id ?? null,
      };
    },
    exchangeCode: async ({ code, redirectUri }) => {
      const payload = await graphPost(`https://graph.facebook.com/${graphVersion}/oauth/access_token`, {
        client_id: env.META_APP_ID || "",
        client_secret: env.META_APP_SECRET || "",
        redirect_uri: redirectUri,
        code,
      });
      if (typeof payload.access_token !== "string" || !payload.access_token) throw new Error("token_exchange_failed");
      return { accessToken: payload.access_token };
    },
    exchangeLongLivedUserToken: async ({ accessToken }) => {
      const payload = await graphPost(`https://graph.facebook.com/${graphVersion}/oauth/access_token`, {
        grant_type: "fb_exchange_token",
        client_id: env.META_APP_ID || "",
        client_secret: env.META_APP_SECRET || "",
        fb_exchange_token: accessToken,
      });
      if (typeof payload.access_token !== "string" || !payload.access_token) throw new Error("long_token_exchange_failed");
      return { accessToken: payload.access_token };
    },
    fetchPages: async ({ accessToken }) => {
      const pagesUrl = new URL(`https://graph.facebook.com/${graphVersion}/me/accounts`);
      pagesUrl.searchParams.set("fields", "id,name,access_token,tasks,perms");
      const response = await fetch(pagesUrl, { headers: { authorization: `Bearer ${accessToken}` } });
      const payload = await safeGraphJson(response);
      if (!response.ok || !Array.isArray(payload.data)) throw new Error("page_list_failed");
      return payload.data.map((page: Record<string, unknown>) => ({
        id: typeof page.id === "string" ? page.id : "",
        name: typeof page.name === "string" ? page.name : "",
        accessToken: typeof page.access_token === "string" ? page.access_token : "",
        tasks: Array.isArray(page.tasks) ? page.tasks.filter((item) => typeof item === "string") as string[] : undefined,
        perms: Array.isArray(page.perms) ? page.perms.filter((item) => typeof item === "string") as string[] : undefined,
      }));
    },
    storePageSelectionCandidates: async ({ actorId, candidates, expiresAt }) => {
      const { data, error } = await admin.rpc("facebook_store_page_oauth_candidates", {
        p_actor_id: actorId,
        p_candidates: candidates.map((candidate) => ({
          page_id: candidate.id,
          page_name: candidate.name,
          page_access_auth: candidate.accessToken,
          permissions: normalizedPermissions(candidate),
        })),
        p_expires_at: expiresAt,
      });
      if (error) throw error;
      return mapSafeCandidates(data);
    },
    listPendingPageSelection: async (userId) => {
      const { data, error } = await admin.rpc("facebook_list_page_oauth_candidates", { p_actor_id: userId });
      if (error) throw error;
      return mapSafeCandidates(data);
    },
    consumePageSelectionCandidate: async ({ actorId, candidateId }) => {
      const { data, error } = await admin.rpc("facebook_consume_page_oauth_candidate", {
        p_actor_id: actorId,
        p_candidate_id: candidateId,
      });
      if (error || !data) return null;
      const row = Array.isArray(data) ? data[0] : data;
      if (!row || typeof row.page_id !== "string" || typeof row.page_access_auth !== "string") return null;
      return {
        pageId: row.page_id,
        pageName: typeof row.page_name === "string" ? row.page_name : "Facebook Page",
        pageAccessToken: row.page_access_auth,
        permissions: Array.isArray(row.permissions) ? row.permissions.filter((item: unknown) => typeof item === "string") : [],
      };
    },
    subscribePageWebhooks: async ({ pageId, pageAccessToken }) => {
      const response = await fetch(`https://graph.facebook.com/${graphVersion}/${encodeURIComponent(pageId)}/subscribed_apps`, {
        method: "POST",
        headers: { authorization: `Bearer ${pageAccessToken}`, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          subscribed_fields: "messages,message_deliveries,message_reads,messaging_postbacks,messaging_referrals,messaging_policy_enforcement",
        }),
      });
      const payload = await safeGraphJson(response);
      if (!response.ok || payload.success === false) throw new Error("page_subscription_failed");
    },
    commitPageConnection: async (input) => {
      const { error } = await admin.rpc("facebook_commit_page_oauth_connection", {
        p_page_id: input.pageId,
        p_page_name: input.pageName,
        p_auth_material: input.pageAccessToken,
        p_actor_id: input.actorId,
        p_permissions: input.permissions,
        p_connected_at: input.connectedAt,
      });
      if (error) throw error;
    },
    getConnectionStatus: async () => {
      const { data, error } = await admin.rpc("facebook_page_connection_status");
      if (error) throw error;
      const row = data || {};
      return {
        connected: row.connected === true,
        featureEnabled: row.feature_enabled === true,
        pageName: typeof row.page_name === "string" ? row.page_name : null,
        pageIdSuffix: typeof row.page_id_suffix === "string" ? row.page_id_suffix : null,
        connectedAt: typeof row.connected_at === "string" ? row.connected_at : null,
        connectionStatus: typeof row.connection_status === "string" ? row.connection_status : null,
      };
    },
  };
}

async function hasPermission(admin: any, userId: string, moduleKey: string, mode: "view" | "edit"): Promise<boolean> {
  const [{ data: roles }, { data: perms }] = await Promise.all([
    admin.from("user_roles").select("role").eq("user_id", userId),
    admin.from("user_module_permissions").select("can_view,can_edit").eq("user_id", userId).eq("module_key", moduleKey),
  ]);
  if ((roles || []).some((row: { role?: string }) => row.role === "owner")) return true;
  return (perms || []).some((row: { can_view?: boolean; can_edit?: boolean }) => mode === "edit" ? row.can_edit === true : row.can_view === true || row.can_edit === true);
}

async function isOwner(admin: any, userId: string): Promise<boolean> {
  const { data } = await admin.from("user_roles").select("role").eq("user_id", userId).eq("role", "owner");
  return (data || []).length > 0;
}

function bearer(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length).trim() || null;
}

function normalizeAppRedirect(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_APP_REDIRECT;
  try {
    const url = new URL(value);
    if (!ALLOWED_REDIRECT_ORIGINS.has(url.origin)) return DEFAULT_APP_REDIRECT;
    return `${url.origin}/marketing-sales/facebook-page`;
  } catch {
    return DEFAULT_APP_REDIRECT;
  }
}

function normalizeExpectedPageId(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") return null;
  const clean = value.trim();
  return PAGE_ID_RE.test(clean) ? clean : null;
}

function normalizeGraphVersion(value: unknown): string {
  return typeof value === "string" && /^v[0-9]+\.[0-9]+$/.test(value) ? value : DEFAULT_GRAPH_VERSION;
}

function minimizeStatus(status: FacebookPageConnectionStatus): Record<string, unknown> {
  return {
    connected: status.connected === true,
    featureEnabled: status.featureEnabled === true,
    pageName: status.pageName || null,
    pageIdSuffix: status.pageIdSuffix || null,
    connectedAt: status.connectedAt || null,
    connectionStatus: status.connectionStatus || null,
    pendingPageCandidates: minimizeCandidates(status.pendingPageCandidates || []),
  };
}

function minimizeCandidates(candidates: SafePageCandidate[]): SafePageCandidate[] {
  return candidates.map((candidate) => ({
    candidateId: candidate.candidateId,
    pageName: candidate.pageName,
    pageIdSuffix: candidate.pageIdSuffix,
    permissions: Array.isArray(candidate.permissions) ? candidate.permissions.slice(0, 20) : [],
    expiresAt: candidate.expiresAt,
  }));
}

function redirectWith(redirectUrl: string, params: Record<string, string>): Response {
  const url = new URL(normalizeAppRedirect(redirectUrl));
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  return Response.redirect(url.toString(), 302);
}

async function signOAuthState(payload: OAuthStatePayload, secret: string): Promise<string> {
  const encoded = base64UrlEncode(encoder.encode(JSON.stringify(payload)));
  return `${encoded}.${await hmacSha256Hex(secret, encoded)}`;
}

async function verifyOAuthState(state: string, secret: string, nowMs = Date.now()): Promise<OAuthStatePayload | null> {
  const parts = state.split(".");
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]{20,2048}$/.test(parts[0]) || !/^[0-9a-f]{64}$/.test(parts[1])) return null;
  const expected = await hmacSha256Hex(secret, parts[0]);
  if (!constantTimeStringEqual(expected, parts[1])) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(decoder.decode(base64UrlDecode(parts[0])));
  } catch {
    return null;
  }
  if (!isStatePayload(payload)) return null;
  if (payload.exp * 1000 < nowMs) return null;
  if (normalizeAppRedirect(payload.redirectUrl) !== payload.redirectUrl) return null;
  return payload;
}

function isStatePayload(value: unknown): value is OAuthStatePayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return row.v === STATE_VERSION &&
    typeof row.nonce === "string" &&
    row.nonce.length >= 16 &&
    typeof row.actorId === "string" &&
    UUID_RE.test(row.actorId) &&
    typeof row.redirectUrl === "string" &&
    (row.expectedPageId === null || PAGE_ID_RE.test(String(row.expectedPageId))) &&
    typeof row.iat === "number" &&
    Number.isSafeInteger(row.iat) &&
    typeof row.exp === "number" &&
    Number.isSafeInteger(row.exp);
}

function selectPage(
  pages: FacebookPageCandidate[],
  expectedPageId: string | null,
): { ok: true; page: FacebookPageCandidate } | { ok: false; reason: string; pages?: FacebookPageCandidate[] } {
  const eligible = pages.filter((page) => page.id && page.name && page.accessToken && hasRequiredPageAccess(page));
  if (expectedPageId) {
    const page = eligible.find((candidate) => candidate.id === expectedPageId);
    return page ? { ok: true, page } : { ok: false, reason: "page_not_authorized" };
  }
  if (eligible.length === 0) return { ok: false, reason: "no_eligible_pages" };
  if (eligible.length > 1) return { ok: false, reason: "multiple_pages_select_page_id", pages: eligible };
  return { ok: true, page: eligible[0] };
}

function hasRequiredPageAccess(page: FacebookPageCandidate): boolean {
  const rawPermissions = normalizedPermissions(page);
  if (rawPermissions.length === 0) return false;
  const permissions = new Set(rawPermissions);
  for (const required of REQUIRED_PAGE_TASKS) {
    if (!permissions.has(required)) return false;
  }
  return true;
}

function normalizedPermissions(page: FacebookPageCandidate): string[] {
  return [...(page.tasks || []), ...(page.perms || [])]
    .map((item) => item.trim().toUpperCase().replace(/[^A-Z0-9_:-]/g, "_"))
    .filter((item, index, items) => item && items.indexOf(item) === index)
    .slice(0, 50);
}

function mapSafeCandidates(data: unknown): SafePageCandidate[] {
  const rows = Array.isArray(data) ? data : [];
  return rows.map((row: Record<string, unknown>) => ({
    candidateId: typeof row.candidate_id === "string" ? row.candidate_id : "",
    pageName: typeof row.page_name === "string" ? row.page_name : "Facebook Page",
    pageIdSuffix: typeof row.page_id_suffix === "string" ? row.page_id_suffix : "",
    permissions: Array.isArray(row.permissions) ? row.permissions.filter((item) => typeof item === "string") as string[] : [],
    expiresAt: typeof row.expires_at === "string" ? row.expires_at : undefined,
  })).filter((candidate) => candidate.candidateId && candidate.pageIdSuffix);
}

async function graphPost(url: string, body: Record<string, string>): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  const payload = await safeGraphJson(response);
  if (!response.ok) throw new Error("graph_request_failed");
  return payload;
}

async function safeGraphJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const data = await response.json();
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

async function hmacSha256Hex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return bytesToHex(new Uint8Array(signature));
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return bytesToHex(new Uint8Array(digest));
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function safeErrorCode(value: string): string {
  const safe = value.toLowerCase().replace(/[^a-z0-9_:-]/g, "_").slice(0, 80);
  return SAFE_ERROR_RE.test(safe) ? safe : "provider_error";
}

if (import.meta.main) Deno.serve((request) => handleFacebookPageConnect(request));
