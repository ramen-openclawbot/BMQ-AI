#!/usr/bin/env node
// Scoped static QA for the VNAgent data-assets admin.
//
// This is a contract check over the real source (not a substitute for running
// the app): routing/host handling, owner gating, design tokens, responsive
// rules, no raw-HTML injection, the real client/server wire contract and the
// hardened mutation/capture wiring. Run:
//   node apps/web/scripts/qa_vnagent_data_admin_contract.mjs
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFileSync(join(web, relative), "utf8");
const failures = [];
const checks = [];
function check(name, condition, detail = "") {
  checks.push(name);
  if (!condition) failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

const app = read("src/App.tsx");
const routes = read("src/components/AppRoutes.tsx");
const shell = read("src/components/data-admin/DataAdminShell.tsx");
const page = read("src/pages/VNAgentDataAdmin.tsx");
const css = read("src/styles/data-admin.css");
const overview = read("src/components/data-admin/OverviewPanel.tsx");
const chart = read("src/components/data-admin/GrowthChart.tsx");
const shared = read("src/components/data-admin/shared.tsx");
const jev = read("src/components/data-admin/JevLogsPanel.tsx");
const exportPanel = read("src/components/data-admin/ExportPanel.tsx");
const repository = read("src/components/data-admin/RepositoryPanel.tsx");
const reviewQueue = read("src/components/data-admin/ReviewQueuePanel.tsx");
const contributions = read("src/components/data-admin/ContributionsPanel.tsx");
const generatePanel = read("src/components/data-admin/GeneratePanel.tsx");
const capture = read("supabase/functions/bmq-analytics/handler.ts");
const captureIndex = read("supabase/functions/bmq-analytics/index.ts");
const interactionLog = read("supabase/functions/bmq-analytics/interaction-log.ts");
const migration = read("supabase/migrations/20260920120000_vnagent_data_assets.sql");
const dataAssets = read("supabase/functions/vnagent-data-admin/data-assets.ts");
const clientDataAssets = read("src/lib/dataAssets.ts");
const handler = read("supabase/functions/vnagent-data-admin/handler.ts");
const store = read("supabase/functions/vnagent-data-admin/store.ts");
const hostLanguage = read("src/lib/adminHostLanguage.ts");
const authPage = read("src/pages/Auth.tsx");
const authTimeout = read("src/lib/authTimeout.ts");
const authContext = read("src/contexts/AuthContext.tsx");
const generation = read("supabase/functions/vnagent-data-admin/generation.ts");
const generationClient = read("supabase/functions/vnagent-data-admin/generation-client.ts");
const generationPricing = read("supabase/functions/vnagent-data-admin/generation-pricing.ts");
const generationMigration = read("supabase/migrations/20260921100000_vnagent_generation_jobs.sql");

check("admin host is handled in App.tsx via the shared exact predicate", app.includes("isVnagentAdminHostname") && !app.includes('"admin.vnagent.ai"'));
check("admin host sets a document title", app.includes("VNAGENT_ADMIN_TITLE"));
check("shared predicate pins the primary host and keeps the alias", hostLanguage.includes('ADMIN_PRIMARY_HOST = "admin.banhmique.vn"') && hostLanguage.includes('VNAGENT_ADMIN_HOST = "admin.vnagent.ai"') && hostLanguage.includes("ADMIN_HOSTS.includes(hostname)"));
check("admin host route tree enforces sign-in", routes.includes("isVnagentAdminHostname") && routes.includes("ProtectedRoute"));
// The admin branch must NOT use the shared OwnerRoute: it redirects to "/", and
// on the admin host "/" re-enters the same "*" branch, so a denied non-owner
// would loop on a blank screen instead of seeing the page's English denial.
const adminBranchStart = routes.indexOf("isVnagentAdminHostname(window.location.hostname))");
const adminBranchEnd = routes.indexOf("if (loading) {", adminBranchStart);
const adminBranch = adminBranchStart >= 0 && adminBranchEnd > adminBranchStart ? routes.slice(adminBranchStart, adminBranchEnd) : "";
check("admin route branch does not use the redirecting shared OwnerRoute", adminBranch.length > 0 && !adminBranch.includes("OwnerRoute"));
check("BMQ owner routes still use the shared OwnerRoute unchanged", ["<OwnerRoute><UserManagement /></OwnerRoute>", "<OwnerRoute><BmqDataSources /></OwnerRoute>"].every((marker) => routes.includes(marker)));
check("admin page waits for authzLoaded and handles authzError", page.includes("authzLoaded") && page.includes("authzError") && page.includes("refreshRoles"));
// The legacy /data-admin entry on non-admin hosts was removed entirely
// (2026-09-21): admin is host-only, so that path must not appear anywhere in the
// routing or language surface (it falls through to the normal NotFound route).
check(
  "legacy /data-admin admin entry removed from routing and language",
  !routes.includes("dataAdminPath") &&
    !routes.includes("DATA_ADMIN_PATH") &&
    !hostLanguage.includes("DATA_ADMIN_PATH") &&
    !hostLanguage.includes("isDataAdminPathname"),
);
check(
  "admin route branch is host-only, never path-based",
  adminBranch.includes("isVnagentAdminHostname(window.location.hostname)") && !adminBranch.includes("dataAdminPath"),
);
check(
  "English admin surface is host-only",
  hostLanguage.includes("return isVnagentAdminHostname(host)") && !hostLanguage.includes("isDataAdminPathname"),
);
// Login heading is host-scoped: admin reads BMQ Administration, every other BMQ
// host keeps BMQ Procurement byte-for-byte.
check(
  "admin login heading is host-scoped copy",
  hostLanguage.includes('title: "BMQ Administration"') &&
    hostLanguage.includes('title: "BMQ Procurement"') &&
    authPage.includes("{copy.auth.title}") &&
    !authPage.includes("BMQ Procurement"),
);
// Bounded auth awaits: a stuck SDK call must not leave a permanent spinner.
check(
  "callback awaits are bounded against SDK hangs",
  authPage.includes("withAuthTimeout(supabase.auth.exchangeCodeForSession") &&
    authPage.includes("withAuthTimeout(supabase.auth.setSession"),
);
check(
  "auth bootstrap watchdog recovery read is bounded",
  authContext.includes("withAuthTimeout(") && authTimeout.includes("AUTH_CALL_TIMEOUT_MS"),
);
check("existing BMQ routes preserved", ["/suppliers", "/payment-requests", "/material-master", "/finance-control/revenue"].every((path) => routes.includes(`"${path}`)));
check("stable admin marker present", shell.includes('data-vnagent-data-admin="v2"'));
check("header title has an English default label", shell.includes('"Data assets"'));
check("header has a prominent .md export CTA", shell.includes("data-da-export-cta") && page.includes('onExport={() => setActive("export")}'));
check("non-owner denial marker present", page.includes('data-da-denied="owner-only"'));
check("all seven panels are wired", ["overview", "repository", "review", "contributions", "generate", "jev", "export"].every((key) => page.includes(`"${key}"`)));
for (const panel of ["OverviewPanel", "RepositoryPanel", "ReviewQueuePanel", "ContributionsPanel", "GeneratePanel", "JevLogsPanel", "ExportPanel"]) {
  check(`${panel} component exists`, existsSync(join(web, `src/components/data-admin/${panel}.tsx`)));
}
check("growth chart component exists with stock/new toggle and 7/30/90 range", existsSync(join(web, "src/components/data-admin/GrowthChart.tsx")) && chart.includes("TIMESERIES_DAYS") && chart.includes('"stock"') && chart.includes('"new"'));
check("chart is rendered from the daily timeseries and shows source contributions", chart.includes("action: \"timeseries\"") && chart.includes("contributionRows") && chart.includes("da-contribution"));
check("overview shows current inventory, created-today and capture status honestly", overview.includes("createdToday") && overview.includes("data-da-capture"));
check("account switch remounts the owner subtree", page.includes("key={user.id}"));
check("single selected case can be exported from the repository", read("src/components/data-admin/RepositoryPanel.tsx").includes("asset_ids: [asset.id]"));
check("no raw HTML injection in admin UI", !/dangerouslySetInnerHTML/.test([shell, page].join("\n") + read("src/components/data-admin/RepositoryPanel.tsx") + read("src/components/data-admin/ExportPanel.tsx")));
check("design tokens present", ["--da-paper", "--da-teal", "--da-indigo", "--da-amber"].every((token) => css.includes(token)));
check("no horizontal page scroll", css.includes("overflow-x: clip"));
check("mobile and tablet breakpoints defined", css.includes("max-width: 900px") && css.includes("max-width: 640px"));
check("focus-visible styling present", css.includes("focus-visible"));
check("loading, error and empty states implemented", ["LoadingBlock", "ErrorBlock", "EmptyBlock"].every((name) => read("src/components/data-admin/shared.tsx").includes(name)));
check("export preview is plain text", exportPanel.includes('className="da-preview"'));

// ── English-default and language independence ───────────────────────────────
check("admin language is the English ADMIN_LANGUAGE constant", clientDataAssets.includes('export const ADMIN_LANGUAGE: Language = "en"') && page.includes("ADMIN_LANGUAGE") && page.includes("const language = ADMIN_LANGUAGE"));
check("admin never reads the BMQ LanguageContext or the app-language key", !page.includes("useLanguage") && !/import[^;]*LanguageContext/.test(page) && !/localStorage\s*\./.test(page));
check("admin shell exposes its default language for QA", shell.includes("data-da-language={language}"));
check("no hardcoded Vietnamese error fallback in shared UI state", shared.includes('"Unknown error."') && !shared.includes("Lỗi không xác định"));
check("Jev token column is localized through the English default", jev.includes('t(language, "Tokens (vào / ra)", "Tokens (in / out)")'));
check("export preview truncation note is English", exportPanel.includes("(preview truncated)") && !exportPanel.includes("đã rút gọn phần xem trước"));
check("admin numbers use English en-US grouping by default", shared.includes("formatNumber(value)") && clientDataAssets.includes('language === "vi" ? "vi-VN" : "en-US"'));
check("raw question/answer/evidence stay verbatim in the repository", repository.includes("{asset.question}") && repository.includes("{selected.question}") && repository.includes("selected.source_answer") && !/translat/i.test(repository));
check("review queue shows the captured question and answer verbatim", reviewQueue.includes("{asset.question}") && reviewQueue.includes("{asset.source_answer"));
check("the transport sends the pinned admin language", read("src/lib/dataAssetsApi.ts").includes("language") && read("src/lib/dataAssetsApi.ts").includes('"Accept-Language": language'));
check("handler error defaults are English-first", handler.includes("!/^vi(?:[-,;]|$)/i.test"));
check("generated Markdown headings are English", dataAssets.includes('lines.push("# VNAgent dataset export")') && dataAssets.includes('lines.push("## Full cases")'));

// ── Owner-only Generate Data ─────────────────────────────────────────────────
check("generate panel is owner-gated and reachable from the admin shell", page.includes("GeneratePanel") && page.includes('active === "generate"'));
check("generate form exposes topic/count/language/budget", ["data-da-generation-topic", "data-da-generation-count", "data-da-generation-language", "data-da-generation-budget", "data-da-generation-run"].every((marker) => generatePanel.includes(marker)));
check("generate panel reconciles an uncertain outcome by reading the durable job", generatePanel.includes("data-da-generation-reconcile") && generatePanel.includes("reconcileKey") && generatePanel.includes('action: "generate_status"'));
check("generate panel recovers the EXACT key, persists the exact request and cancels stale reads", generatePanel.includes("idempotency_key: run.key") && generatePanel.includes("vnagent-generate-pending:") && generatePanel.includes("serializePendingGeneration") && generatePanel.includes("data-da-generation-safe-retry") && generatePanel.includes("controller.abort()"));
check("generate panel keeps uncertainty on running/absent and releases only verified terminal states", generatePanel.includes("generationRecoveryDecision") && clientDataAssets.includes("abandoned: z.boolean().optional()") && generatePanel.includes("result.abandoned === true") && generatePanel.includes("isDefinitiveGenerationDenial"));
check("generate panel preserves terminal failure copy instead of a success banner", generatePanel.includes('result.status === "failed"') && generatePanel.includes("nothing was stored") && generatePanel.includes("không có câu nào được lưu"));
check("generate panel reports progress and results", generatePanel.includes("data-da-generation-results") && generatePanel.includes("Recent runs"));
check("supported definitions and curated built-in examples are source constants", generation.includes("SUPPORTED_TOPICS") && generation.includes("BUILT_IN_EXAMPLE_SEEDS") && generation.includes("seed-payment-supplier") && generation.includes("SEED_SOURCE_LABEL") && /not owner-approved/i.test(generation));
check("generation output has no stage/evaluation/truth label field", !/dataset_stage|evaluation_status|reviewer_id|verified_intent/.test(generation) && generation.includes("STYLE_RESPONSE"));
check("generation rejects fabricated money claims in questions", generation.includes("MONEY_CLAIM") && generation.includes("generation_duplicate_output"));
check("generation is Raw synthetic/llm_generated only", handler.includes('sourceKind: "synthetic"') && handler.includes('sourceDesignation: "llm_generated"'));
check("gateway generation preserves zero data retention", generationClient.includes("zeroDataRetention: true") && generationClient.includes("ai-gateway.vercel.sh/v1/chat/completions") && generationClient.includes('redirect: "error"'));
check("gateway call is bounded by max_tokens and a deadline", generationClient.includes("GENERATION_BODY_LIMIT") && generation.includes("max_tokens") && generationClient.includes("AbortSignal.timeout"));
check("generation fails closed when the cost cannot be bounded", handler.includes("generation_cost_unbounded") && handler.includes("estimateWorstCaseCostUsd") && generationPricing.includes("inputPer1kUsd"));
check("the input bound is measured from the ACTUAL serialized request", generation.includes("serializeGenerationRequest") && generation.includes("generationInputTokenBound") && generation.includes("GENERATION_MAX_INPUT_TOKENS") && generation.includes("TextEncoder"));
check("verified gateway pricing carries provenance and keeps ZDR", generationPricing.includes("openai/gpt-5.6-luna") && generationPricing.includes("gateway-models.json") && generationPricing.includes("pricingTier") && generation.includes("zeroDataRetention"));
check("hard budget is checked before the model call and after the reported cost", handler.includes("worstCaseCostUsd > request.budgetUsd") && handler.includes("outcome.cost > request.budgetUsd"));
check("generation job is durable and idempotent on one real key", handler.includes("generationStart") && handler.includes("idempotencyKey") && handler.includes("requestFingerprint") && generationMigration.includes("idempotency_key") && generationMigration.includes("unique (tenant, created_by, idempotency_key)"));
check("same key with a different payload is a conflict, not a silent reuse", generationMigration.includes("idempotency_conflict") && generationMigration.includes("request_fingerprint is distinct from") && store.includes("generation_idempotency_conflict"));
check("one running generation job per owner (advisory lock + unique index) prevents double spend", generationMigration.includes("pg_advisory_xact_lock") && generationMigration.includes("vnagent_generation_jobs_one_running_idx") && generationMigration.includes("generation_busy"));
check("generation jobs are owner-only and direct writes are revoked", generationMigration.includes("vnagent_generation_jobs_owner_select") && generationMigration.includes("revoke all on public.vnagent_generation_jobs from anon, authenticated") && generationMigration.includes("security definer"));
check("generation RPCs re-derive the owner from auth.uid()", generationMigration.includes("auth.uid()") && generationMigration.includes("has_role(v_actor, 'owner')"));
check("generate_status supports exact-key recovery", generationMigration.includes("p_idempotency_key") && store.includes("p_idempotency_key"));
check("expired lease is surfaced as a server-evaluated abandoned outcome", generationMigration.includes("'abandoned'") && generationMigration.includes("lease_expires_at <= now()") && handler.includes("abandoned?: boolean"));
check("provider diagnostics are bounded and keep only allowlisted status/code/parameter", generationClient.includes("sanitizeProviderDiagnostic") && generationClient.includes("GENERATION_ERROR_BODY_LIMIT") && generationClient.includes("GenerationProviderError") && generationClient.includes("providerDiagnosticOf") && !generationClient.includes("message:"));
check("known provider failures map to fixed codes, never loose message-token matching", generationClient.includes("classifyProviderFailure") && generationClient.includes("PROVIDER_PAID_CREDITS_SENTENCE") && generationClient.includes("generation_paid_credits_required") && !/message.*\.(match|test)\(/.test(generationClient));
check("definitive provider failures return the durable failed job envelope", generation.includes("GENERATION_DETERMINISTIC_FAILURES") && generation.includes("generation_paid_credits_required") && handler.includes("isDeterministicGenerationFailure") && /status: "failed"/.test(handler) && handler.includes("diagnostic"));
check("primary generation failure copy is friendly and code-free; diagnostics stay on the saved job", clientDataAssets.includes("generationDiagnosticSchema") && clientDataAssets.includes("generationFailureReason") && clientDataAssets.includes("generationJobDiagnostic") && clientDataAssets.includes("paid Gateway credits") && !clientDataAssets.includes("safe codes") && !/generationFailureReason[\s\S]*?parts\.push/.test(clientDataAssets) && generatePanel.includes("generationFailureReason") && !generatePanel.includes("data-da-generation-reason"));
check("no scheduler, autoGold or fine-tune path added", !/cron|scheduler|autoGold|auto_gold|fine[_-]?tune/i.test(generation + generationClient + generatePanel + generationMigration));

// ── Capture correctness ──────────────────────────────────────────────────────
check("known/unknown usage separated in capture", interactionLog.includes("unknown_usage") && interactionLog.includes("known_usage"));
check("unknown numbers stay null, never a fabricated zero", interactionLog.includes("function usageTokens") && interactionLog.includes("finiteOrNull(usage.input)"));
check("capture cannot corrupt the reply", capture.includes("bmq_interaction_capture_failed") && /try\s*\{[^}]*config\.capture/s.test(capture));
check("failed requests keep a unique per-event identity", capture.includes("err-${crypto.randomUUID()}") && !interactionLog.includes("deterministicErrorId"));
check("capture is service-role only and atomic through one RPC", captureIndex.includes('rpc("vnagent_capture_chat"') && migration.includes("vnagent_capture_chat"));
check("capture has its own bounded deadline", captureIndex.includes("CAPTURE_BUDGET_MS") && captureIndex.includes("AbortSignal.timeout"));
check("page input filters are separate from executed filters", migration.includes("page_filters") && migration.includes("executed_filters") && interactionLog.includes("executedFilters"));
check("original answer is captured for reviewer reference", migration.includes("answer_text") && interactionLog.includes("answer_text"));
check("nested metadata is sanitized, not only the question", interactionLog.includes("export function sanitizeNested") && interactionLog.includes("SENSITIVE_KEY"));
check("real Jev telemetry fields are used, not invented option ids", migration.includes("metric_probability") && migration.includes("prompt_version") && migration.includes("registry_version") && migration.includes("token_counts") && !migration.includes("option_ids"));
check("Jev cost unknown stays null", migration.includes("cost numeric") && interactionLog.includes("cost: finiteOrNull(jev.cost)"));

// ── Migration security ───────────────────────────────────────────────────────
check("interaction capture is owner-read only", migration.includes("vnagent_interactions_owner_select") && !/for insert to authenticated/.test(migration));
check("direct authenticated writes are revoked on assets", migration.includes("revoke all on public.vnagent_data_assets from anon, authenticated") && !/vnagent_data_assets[\s\S]{0,400}for update to authenticated/.test(migration));
check("direct authenticated writes are revoked on the audit trail", migration.includes("revoke all on public.vnagent_data_asset_events from anon, authenticated") && !/vnagent_data_asset_events[\s\S]{0,400}for insert to authenticated/.test(migration));
check("mutations run through SECURITY DEFINER routines", migration.includes("security definer") && migration.includes("vnagent_transition_data_asset") && migration.includes("vnagent_create_data_asset"));
check("capture RPC is granted to service_role only", /grant execute on function public\.vnagent_capture_chat\(jsonb, jsonb\) to service_role/.test(migration) && /revoke all on function public\.vnagent_capture_chat\(jsonb, jsonb\) from public, anon, authenticated/.test(migration));
check("gold requires reviewer and meaningful evidence", migration.includes("vnagent_data_assets_gold_check") && migration.includes("reviewer_id is not null") && migration.includes("vnagent_evidence_is_meaningful"));
check("created_by is derived server-side", migration.includes("v_key, v_actor") || migration.includes("dedupe_key, created_by"));
check("optimistic version conflict enforced", migration.includes("version_conflict") && migration.includes("for update"));
check("tenant scope is pinned to bmq", migration.includes("check (tenant = 'bmq')"));
check("daily timeseries reconstructs from creation + transitions", migration.includes("vnagent_data_admin_timeseries") && migration.includes("generate_series") && migration.includes("vnagent_data_asset_events ev"));

// ── Client/server contract ───────────────────────────────────────────────────
check("asset filter echo is snake_case", handler.includes("assetFiltersWire") && dataAssets.includes("export function assetFiltersWire"));
check("export filter echo is snake_case", handler.includes("exportFiltersWire") && dataAssets.includes("export function exportFiltersWire"));
check("export applies date predicates in SQL before the limit", store.includes("listExportAssets") && store.includes('gte("effective_at"') && store.includes('lt("effective_at"'));
check("export truncation uses the filtered total", dataAssets.includes("total > filters.limit"));
check("contribution dedupe includes the expected scope", dataAssets.includes("canonicalJson") && /dedupeKey\([\s\S]*expectedIntent/.test(dataAssets));
check("uncertain mutation failures lock retry until reconciliation", read("src/lib/dataAssetsApi.ts").includes("isUncertainMutationStatus") && read("src/components/data-admin/ContributionsPanel.tsx").includes("data-da-reconcile") && read("src/components/data-admin/ContributionsPanel.tsx").includes("disabled={busy || uncertain !== null}"));
check("CORS allow-list pins the exact admin hosts and exact-matches the origin", handler.includes('"https://admin.banhmique.vn"') && handler.includes('"https://admin.vnagent.ai"') && handler.includes("origins.has(origin)"));
check("manual form cannot submit operational_chat", dataAssets.includes('enumValue(raw.source_kind, ["contributor", "synthetic"]'));
check("no model-training promise in admin copy", !/train(ing)? (the )?model/i.test(page + shell + read("src/components/data-admin/ContributionsPanel.tsx") + generatePanel + read("src/components/data-admin/ExportPanel.tsx")));

console.log(`VNAgent data admin contract: ${checks.length - failures.length}/${checks.length} checks passed`);
for (const failure of failures) console.error(`FAIL: ${failure}`);
if (failures.length) process.exit(1);
console.log("PASS");
