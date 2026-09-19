// CLI entry for the opt-in Jev benchmark. Nothing here runs automatically; execute it
// explicitly with Deno when the coordinator has approved paid provider calls:
//
//   BMQ_JEV_BENCH_ENABLED=true BMQ_JEV_BENCH_SPLIT=tune \
//   OPENAI_API_KEY=... AI_GATEWAY_API_KEY=... \
//   deno run --allow-net --allow-env \
//     apps/web/supabase/functions/bmq-analytics/jev-benchmark-cli.ts
//
// `BMQ_JEV_BENCH_ENABLED` must be exactly "true" or the harness stays in dry-run mode
// and makes no provider call. `BMQ_JEV_BENCH_MAX_REQUESTS` defaults to and is hard
// capped at 60. The printed report contains measured timings/tokens and the synthetic
// dataset only — never a credential.
import { main } from "./jev-benchmark.ts";

await main(Deno.env.toObject(), (line) => console.log(line));
