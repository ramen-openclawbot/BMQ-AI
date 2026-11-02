#!/usr/bin/env node
/**
 * Dealer location geocoding proposal tool.
 *
 * Default is a dry run: read active dealers that are missing coordinates, call
 * Photon (OpenStreetMap) with region=vn and write a CSV for a human to review.
 * Only `--apply <reviewed.csv>` writes location_* and requires an `approved`
 * column with yes/true/1 on each row.
 *
 * This script is never run by the Harness against production.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const PHOTON_URL = "https://photon.komoot.io/api/";
const USER_AGENT = "BMQ-dealer-signup/1.0 (+https://dathang.banhmique.vn)";
const BBOX_VIETNAM = "102,8,110,24";
const MIN_INTERVAL_MS = 1100;

const args = process.argv.slice(2);
const applyIndex = args.indexOf("--apply");
const outIndex = args.indexOf("--out");
const applyFile = applyIndex >= 0 ? args[applyIndex + 1] : null;
const outFile = outIndex >= 0 ? args[outIndex + 1] : null;

const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

function fail(message) {
  console.error(`[dealer-location-geocode] ${message}`);
  process.exit(1);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(rows, columns) {
  return [
    columns.join(","),
    ...rows.map((row) => columns.map((column) => csvCell(row[column])).join(",")),
  ].join("\n") + "\n";
}

/** Small CSV parser that handles quotes and embedded commas/newlines. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (char !== "\r") {
      cell += char;
    }
  }

  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }

  if (!rows.length) return [];
  const header = rows[0].map((value) => value.trim());
  return rows.slice(1)
    .filter((values) => values.some((value) => value.trim() !== ""))
    .map((values) => Object.fromEntries(header.map((key, index) => [key, values[index] ?? ""])));
}

function supabaseHeaders() {
  return {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
  };
}

async function readMissingDealers() {
  const query = new URLSearchParams({
    select: "id,customer_name,address,location_lat,location_lng",
    is_active: "eq.true",
    customer_group: "in.(banhmi_agency,banhmi_point)",
    or: "(location_lat.is.null,location_lng.is.null)",
    order: "customer_name.asc",
  });
  const response = await fetch(`${SUPABASE_URL}/rest/v1/mini_crm_customers?${query}`, {
    headers: supabaseHeaders(),
  });
  if (!response.ok) fail(`Không đọc được danh sách đại lý (HTTP ${response.status}).`);
  return await response.json();
}

async function geocodeOne(address) {
  const query = new URLSearchParams({
    q: address,
    limit: "1",
    bbox: BBOX_VIETNAM,
  });

  let response;
  try {
    response = await fetch(`${PHOTON_URL}?${query.toString().replace(/%2C/g, ",")}`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": USER_AGENT,
      },
    });
  } catch {
    return { status: "NETWORK_ERROR" };
  }

  if (!response.ok) return { status: `HTTP_${response.status}` };

  let payload;
  try {
    payload = await response.json();
  } catch {
    return { status: "INVALID_RESPONSE" };
  }

  const feature = Array.isArray(payload?.features) ? payload.features[0] : null;
  if (!feature) return { status: "NO_RESULT" };

  const coordinates = feature?.geometry?.coordinates;
  const lat = Number(coordinates?.[1]);
  const lng = Number(coordinates?.[0]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return { status: "NO_COORDINATES" };
  }

  const properties = feature?.properties || {};
  const accuracy = [properties.osm_value, properties.type]
    .filter((value) => typeof value === "string" && value.trim())
    .join("/") || "UNKNOWN";

  return { status: "OK", lat, lng, accuracy };
}

async function dryRun() {
  const dealers = await readMissingDealers();
  const rows = [];
  let ok = 0;
  let failed = 0;
  let apiCalls = 0;

  for (const dealer of dealers) {
    const address = String(dealer.address || "").trim();
    const query = address || String(dealer.customer_name || "").trim();
    if (!query) {
      rows.push({
        customer_id: dealer.id,
        customer_name: dealer.customer_name || "",
        address: address || "(chưa có địa chỉ)",
        lat: "",
        lng: "",
        accuracy: "MISSING_ADDRESS",
        approved: "",
      });
      failed += 1;
      continue;
    }

    if (apiCalls > 0) await sleep(MIN_INTERVAL_MS);
    apiCalls += 1;
    const result = await geocodeOne(query);

    if (result.status === "OK") {
      ok += 1;
      rows.push({
        customer_id: dealer.id,
        customer_name: dealer.customer_name || "",
        address: address || dealer.customer_name || "",
        lat: result.lat.toFixed(6),
        lng: result.lng.toFixed(6),
        accuracy: result.accuracy,
        approved: "",
      });
    } else {
      failed += 1;
      rows.push({
        customer_id: dealer.id,
        customer_name: dealer.customer_name || "",
        address: address || dealer.customer_name || "",
        lat: "",
        lng: "",
        accuracy: result.status,
        approved: "",
      });
    }
  }

  const target = outFile || `dealer-location-proposals-${new Date().toISOString().slice(0, 10)}.csv`;
  const resolved = path.resolve(target);
  await writeFile(
    resolved,
    toCsv(rows, ["customer_id", "customer_name", "address", "lat", "lng", "accuracy", "approved"]),
    "utf8",
  );

  console.log(`[dealer-location-geocode] Đã đọc ${dealers.length} đại lý thiếu tọa độ.`);
  console.log(`[dealer-location-geocode] Geocode OK: ${ok}; lỗi/không có kết quả: ${failed}.`);
  console.log(`[dealer-location-geocode] CSV đề xuất: ${resolved}`);
  console.log("[dealer-location-geocode] Chưa ghi DB. Duyệt CSV, đánh dấu approved=yes rồi chạy lại với --apply <file>.");
}

function isApproved(value) {
  return /^(yes|true|1|y|approved|đồng ý|dong y)$/i.test(String(value || "").trim());
}

async function applyReviewed(file) {
  const text = await readFile(path.resolve(file), "utf8");
  const rows = parseCsv(text);
  if (!rows.length) fail("CSV rỗng.");
  if (!Object.prototype.hasOwnProperty.call(rows[0], "customer_id")) {
    fail("CSV phải có cột customer_id.");
  }
  if (!Object.prototype.hasOwnProperty.call(rows[0], "approved")) {
    fail("CSV phải có cột approved; chỉ các dòng approved=yes mới được ghi.");
  }

  let updated = 0;
  let skipped = 0;

  for (const row of rows) {
    if (!isApproved(row.approved)) {
      skipped += 1;
      continue;
    }

    const id = String(row.customer_id || "").trim();
    const lat = Number(row.lat);
    const lng = Number(row.lng);
    if (!/^[0-9a-fA-F-]{36}$/.test(id) || !Number.isFinite(lat) || !Number.isFinite(lng) ||
      lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      skipped += 1;
      continue;
    }

    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/mini_crm_customers?id=eq.${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        headers: { ...supabaseHeaders(), Prefer: "return=minimal" },
        body: JSON.stringify({
          location_lat: lat,
          location_lng: lng,
          location_source: "geocode_reviewed",
          location_verified_at: new Date().toISOString(),
        }),
      },
    );

    if (!response.ok) {
      fail(`Cập nhật đại lý ${id} thất bại (HTTP ${response.status}).`);
    }
    updated += 1;
  }

  if (!updated) fail("Không có dòng nào được duyệt để ghi.");
  console.log(`[dealer-location-geocode] Đã ghi ${updated} đại lý với location_source=geocode_reviewed; bỏ qua ${skipped}.`);
}

async function main() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    fail("Thiếu SUPABASE_URL hoặc SUPABASE_SERVICE_ROLE_KEY.");
  }

  if (applyFile) {
    await applyReviewed(applyFile);
    return;
  }

  await dryRun();
}

main().catch(() => {
  fail("Chạy thất bại. Kiểm tra biến môi trường và quyền truy cập.");
});
