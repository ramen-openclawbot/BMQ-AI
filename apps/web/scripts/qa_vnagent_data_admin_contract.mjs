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
const capture = read("supabase/functions/bmq-analytics/handler.ts");
const captureIndex = read("supabase/functions/bmq-analytics/index.ts");
const interactionLog = read("supabase/functions/bmq-analytics/interaction-log.ts");
const migration = read("supabase/migrations/20260920120000_vnagent_data_assets.sql");
const dataAssets = read("supabase/functions/vnagent-data-admin/data-assets.ts");
const clientDataAssets = read("src/lib/dataAssets.ts");
const handler = read("supabase/functions/vnagent-data-admin/handler.ts");
const store = read("supabase/functions/vnagent-data-admin/store.ts");

check("admin host is handled in App.tsx", app.includes('VNAGENT_ADMIN_HOST = "admin.vnagent.ai"'));
check("admin host sets a document title", app.includes("VNAGENT_ADMIN_TITLE"));
check("admin host route tree is owner-protected", routes.includes("VNAGENT_ADMIN_HOST") && routes.includes("OwnerRoute") && routes.includes("ProtectedRoute"));
check("local /data-admin route exists", routes.includes('location.pathname === "/data-admin"'));
check("existing BMQ routes preserved", ["/suppliers", "/payment-requests", "/material-master", "/finance-control/revenue"].every((path) => routes.includes(`"${path}`)));
check("stable admin marker present", shell.includes('data-vnagent-data-admin="v2"'));
check("header title has an English default label", shell.includes('"Data assets"'));
check("header has a prominent .md export CTA", shell.includes("data-da-export-cta") && page.includes('onExport={() => setActive("export")}'));
check("non-owner denial marker present", page.includes('data-da-denied="owner-only"'));
check("all six panels are wired", ["overview", "repository", "review", "contributions", "jev", "export"].every((key) => page.includes(`"${key}"`)));
for (const panel of ["OverviewPanel", "RepositoryPanel", "ReviewQueuePanel", "ContributionsPanel", "JevLogsPanel", "ExportPanel"]) {
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
check("manual form cannot submit operational_chat", dataAssets.includes('enumValue(raw.source_kind, ["contributor", "synthetic"]'));
check("no model-training promise in admin copy", !/train(ing)? (the )?model/i.test(page + shell + read("src/components/data-admin/ContributionsPanel.tsx") + read("src/components/data-admin/ExportPanel.tsx")));

console.log(`VNAgent data admin contract: ${checks.length - failures.length}/${checks.length} checks passed`);
for (const failure of failures) console.error(`FAIL: ${failure}`);
if (failures.length) process.exit(1);
console.log("PASS");
