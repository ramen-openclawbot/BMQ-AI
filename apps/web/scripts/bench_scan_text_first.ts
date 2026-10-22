#!/usr/bin/env node
/**
 * Compare today's DeepSeek image scan with the Indra text-first scan on
 * labelled samples. Not part of the automated checks.
 *
 * Usage:
 *   node --experimental-strip-types scripts/bench_scan_text_first.ts \
 *     --samples /path/to/images --truth /path/to/truth.json \
 *     --mode both --out report.json
 *
 * Truth file: JSON array of
 *   {id, kind: "po" | "unc", total, vat?, subtotal?,
 *    items?: [{name, qty?, price?, line_total?}]}
 *
 * Reads DEEPSEEK_API_KEY, INDRA_OCR_URL and INDRA_OCR_TOKEN from the
 * environment and never prints them.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { extractPurchaseOrder } from "../supabase/functions/scan-purchase-order/extract.ts";
import { callOpenAiVision } from "../supabase/functions/_shared/bank-slip-ocr.ts";

type Mode = "image" | "text" | "both";
type Kind = "po" | "unc";

interface TruthItem {
  name: string;
  qty?: number;
  price?: number;
  line_total?: number;
}

interface TruthDocument {
  id: string;
  kind: Kind;
  total: number;
  vat?: number;
  subtotal?: number;
  items?: TruthItem[];
}

interface Extracted {
  data: Record<string, unknown>;
  engine: string;
  fallbackReason: string | null;
}

interface Score {
  moneyOk: number;
  moneyTotal: number;
  qtyOk: number;
  qtyTotal: number;
  namesOk: number;
  namesTotal: number;
}

interface Row {
  id: string;
  kind: Kind;
  mode: Mode;
  ms: number;
  engine: string;
  fallbackReason: string | null;
  score: Score;
}

const env = (name: string): string | undefined => process.env[name];

function usage(): never {
  console.error(
    "Usage: node --experimental-strip-types scripts/bench_scan_text_first.ts " +
      "--samples <dir> --truth <json> [--mode image|text|both] [--only id1,id2] [--out report.json]",
  );
  process.exit(2);
}

function parseArgs(argv: string[]) {
  const values: Record<string, string> = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (!arg.startsWith("--")) usage();
    const key = arg.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) usage();
    values[key] = value;
    index++;
  }
  const samples = values.samples ? resolve(values.samples) : "";
  const truth = values.truth ? resolve(values.truth) : "";
  if (!samples || !truth) usage();

  const mode = (values.mode ?? "both") as Mode;
  if (!["image", "text", "both"].includes(mode)) usage();

  const only = values.only
    ? values.only.split(",").map((id) => id.trim()).filter(Boolean)
    : null;

  return { samples, truth, mode, only, out: values.out ? resolve(values.out) : null };
}

function removeDiacritics(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase();
}

function nameWords(value: string): Set<string> {
  return new Set(
    removeDiacritics(String(value ?? ""))
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  );
}

/** Share of the truth name's accent-free lowercase words present in the candidate. */
function nameOverlap(truthName: string, candidateName: string): number {
  const truth = nameWords(truthName);
  if (truth.size === 0) return 1;
  const candidate = nameWords(candidateName);
  let hits = 0;
  for (const word of truth) if (candidate.has(word)) hits++;
  return hits / truth.size;
}

function moneyMatches(actual: unknown, expected: number): boolean {
  const value = Number(actual);
  if (!Number.isFinite(value)) return false;
  if (Number.isInteger(expected)) return Math.round(value) === expected;
  return Math.abs(value - expected) <= 0.01;
}

function quantityMatches(actual: unknown, expected: number): boolean {
  const value = Number(actual);
  return Number.isFinite(value) && Math.abs(value - expected) <= 0.001;
}

function pairItems(truthItems: TruthItem[], actualItems: Record<string, unknown>[]) {
  const pairs: { truth: number; actual: number; overlap: number }[] = [];
  truthItems.forEach((truth, truthIndex) => {
    actualItems.forEach((actual, actualIndex) => {
      pairs.push({
        truth: truthIndex,
        actual: actualIndex,
        overlap: nameOverlap(truth.name, String(actual.product_name ?? actual.name ?? "")),
      });
    });
  });
  pairs.sort((a, b) => b.overlap - a.overlap);
  const usedTruth = new Set<number>();
  const usedActual = new Set<number>();
  const matched = new Map<number, { actual: Record<string, unknown>; overlap: number }>();
  for (const pair of pairs) {
    if (usedTruth.has(pair.truth) || usedActual.has(pair.actual)) continue;
    usedTruth.add(pair.truth);
    usedActual.add(pair.actual);
    matched.set(pair.truth, { actual: actualItems[pair.actual], overlap: pair.overlap });
  }
  return matched;
}

function scoreDocument(truth: TruthDocument, data: Record<string, unknown>): Score {
  const actualTotal = truth.kind === "unc" ? (data.amount ?? data.total_amount) : data.total_amount;
  const score: Score = { moneyOk: 0, moneyTotal: 0, qtyOk: 0, qtyTotal: 0, namesOk: 0, namesTotal: 0 };

  score.moneyTotal++;
  if (moneyMatches(actualTotal, truth.total)) score.moneyOk++;

  if (truth.vat !== undefined) {
    score.moneyTotal++;
    if (moneyMatches(data.vat_amount, truth.vat)) score.moneyOk++;
  }
  if (truth.subtotal !== undefined) {
    score.moneyTotal++;
    if (moneyMatches(data.subtotal_amount, truth.subtotal)) score.moneyOk++;
  }

  const truthItems = truth.items ?? [];
  const actualItems = Array.isArray(data.items)
    ? data.items as Record<string, unknown>[]
    : [];
  const matched = pairItems(truthItems, actualItems);

  for (let index = 0; index < truthItems.length; index++) {
    const item = truthItems[index];
    const pair = matched.get(index);

    score.namesTotal++;
    if (pair && pair.overlap >= 0.85) score.namesOk++;

    if (item.qty !== undefined) {
      score.qtyTotal++;
      if (pair && quantityMatches(pair.actual.quantity, item.qty)) score.qtyOk++;
    }
    if (item.price !== undefined) {
      score.moneyTotal++;
      if (pair && moneyMatches(pair.actual.unit_price, item.price)) score.moneyOk++;
    }
    if (item.line_total !== undefined) {
      score.moneyTotal++;
      if (pair && moneyMatches(pair.actual.line_total, item.line_total)) score.moneyOk++;
    }
  }

  return score;
}

async function extractOne(truth: TruthDocument, base64: string, engine: "indra" | "deepseek"): Promise<Extracted> {
  if (truth.kind === "po") {
    const result = await extractPurchaseOrder({
      imageBase64: base64,
      mimeType: "image/jpeg",
      env,
      engineOverride: engine,
    });
    return { data: result.data, engine: result.engine, fallbackReason: result.fallbackReason };
  }

  const result = await callOpenAiVision(base64, "image/jpeg", undefined, {
    readBeneficiary: false,
    env,
    engineOverride: engine,
  });
  return {
    data: result as unknown as Record<string, unknown>,
    engine: result.ocr_engine,
    fallbackReason: result.ocr_fallback_reason,
  };
}

function scoreLine(row: Row): string {
  const { score } = row;
  return [
    `[${row.kind}] ${row.id}`,
    `${row.ms}ms`,
    `money ${score.moneyOk}/${score.moneyTotal}`,
    `qty ${score.qtyOk}/${score.qtyTotal}`,
    `names ${score.namesOk}/${score.namesTotal}`,
    `engine=${row.engine}`,
    `fallback=${row.fallbackReason ?? "-"}`,
  ].join(" | ");
}

async function main(): Promise<void> {
  const { samples, truth: truthPath, mode, only, out } = parseArgs(process.argv.slice(2));
  const truth = JSON.parse(readFileSync(truthPath, "utf8")) as TruthDocument[];
  if (!Array.isArray(truth)) usage();

  const documents = only ? truth.filter((doc) => only.includes(doc.id)) : truth;
  if (documents.length === 0) {
    console.error("No documents matched --only");
    process.exit(1);
  }

  const modes: ("image" | "text")[] = mode === "both" ? ["image", "text"] : [mode];
  const rows: Row[] = [];

  for (const doc of documents) {
    const path = join(samples, `${doc.id}.jpg`);
    let base64: string;
    try {
      base64 = readFileSync(path).toString("base64");
    } catch {
      console.error(`Missing sample image: ${path}`);
      process.exit(1);
    }

    for (const currentMode of modes) {
      const engine = currentMode === "image" ? "deepseek" : "indra";
      const started = Date.now();
      try {
        const extracted = await extractOne(doc, base64, engine);
        const row: Row = {
          id: doc.id,
          kind: doc.kind,
          mode: currentMode,
          ms: Date.now() - started,
          engine: extracted.engine,
          fallbackReason: extracted.fallbackReason,
          score: scoreDocument(doc, extracted.data),
        };
        rows.push(row);
        console.log(scoreLine(row));
      } catch (error) {
        // Never print the provider response; it can contain document content.
        console.log(
          `[${doc.kind}] ${doc.id} | ${Date.now() - started}ms | ${currentMode} FAILED | ` +
            `${error instanceof Error ? error.name : "error"}`,
        );
      }
    }
  }

  const totals = modes.map((currentMode) => {
    const modeRows = rows.filter((row) => row.mode === currentMode);
    const sum = (key: keyof Score) => modeRows.reduce((total, row) => total + row.score[key], 0);
    return {
      mode: currentMode,
      documents: modeRows.length,
      moneyOk: sum("moneyOk"),
      moneyTotal: sum("moneyTotal"),
      qtyOk: sum("qtyOk"),
      qtyTotal: sum("qtyTotal"),
      namesOk: sum("namesOk"),
      namesTotal: sum("namesTotal"),
      avgMs: modeRows.length
        ? Math.round(modeRows.reduce((total, row) => total + row.ms, 0) / modeRows.length)
        : 0,
    };
  });

  for (const total of totals) {
    console.log(
      `TOTAL ${total.mode}: money ${total.moneyOk}/${total.moneyTotal}, ` +
        `qty ${total.qtyOk}/${total.qtyTotal}, names ${total.namesOk}/${total.namesTotal}, ` +
        `avg ${total.avgMs}ms (${total.documents} docs)`,
    );
  }

  if (out) {
    writeFileSync(out, `${JSON.stringify({ generated_at: new Date().toISOString(), rows, totals }, null, 2)}\n`);
    console.log(`Report written to ${out}`);
  }
}

await main();
