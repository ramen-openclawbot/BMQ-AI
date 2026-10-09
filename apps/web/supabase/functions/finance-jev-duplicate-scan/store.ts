// Service-role data access for the finance Jev duplicate scan.
//
// Every read is a fixed SELECT from the service-role client; the client never
// supplies SQL, table names or filters. Writes happen only through the `run`
// path and only ever upsert public.finance_jev_duplicate_checks by pair_key,
// with the review_* columns deliberately absent so a stored CEO decision is
// never overwritten. Nothing here updates or deletes a business row.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.90.1";
import type { CandidateRequest } from "./candidates.ts";
import { JEV_SCAN_LOOKBACK_LIMIT, JevScanError, type ExistingCheck, type JevCheckRow, type JevDuplicateDataSource, type JevDuplicateSink } from "./handler.ts";
import type { RequestStateInput, StateItem } from "./state.ts";

const MAX_ITEMS = 2_000;

function fail(): never {
  throw new JevScanError("scan_failed", 503);
}

export function createServiceDataSource(admin: SupabaseClient): JevDuplicateDataSource {
  return {
    async listRequests({ sinceIso, ids }) {
      let query = admin
        .from("payment_requests")
        .select("id,request_number,supplier_id,purchase_order_id,status,total_amount,created_at")
        .neq("status", "rejected")
        .gt("total_amount", 0);
      if (ids && ids.length > 0) {
        query = query.in("id", ids);
      } else {
        query = query.gte("created_at", sinceIso).not("supplier_id", "is", null);
      }
      const { data, error } = await query.order("created_at", { ascending: false }).limit(JEV_SCAN_LOOKBACK_LIMIT);
      if (error) fail();
      return (data ?? []) as unknown as CandidateRequest[];
    },

    async listExistingChecks(pairKeys) {
      let query = admin
        .from("finance_jev_duplicate_checks")
        .select("pair_key,pr_older,pr_newer,state_hash");
      if (pairKeys && pairKeys.length > 0) query = query.in("pair_key", pairKeys);
      const { data, error } = await query.limit(pairKeys?.length ?? 5_000);
      if (error) fail();
      return (data ?? []) as unknown as ExistingCheck[];
    },

    async loadContext({ requestIds, supplierIds }) {
      const requests: Record<string, RequestStateInput> = {};
      const supplierNames: Record<string, string | null> = {};
      if (requestIds.length === 0) return { requests, supplierNames };

      const { data: base, error: baseError } = await admin
        .from("payment_requests")
        .select("id,request_number,created_at,total_amount,title,description,purchase_order_id,goods_receipt_id,invoice_id")
        .in("id", requestIds);
      if (baseError) fail();

      const { data: items, error: itemsError } = await admin
        .from("payment_request_items")
        .select("payment_request_id,product_name,quantity,unit,unit_price,line_total,created_at")
        .in("payment_request_id", requestIds)
        .order("created_at", { ascending: true })
        .limit(MAX_ITEMS);
      if (itemsError) fail();

      const rows = (base ?? []) as Record<string, unknown>[];
      const poIds = [...new Set(rows.map((row) => row.purchase_order_id).filter((id): id is string => typeof id === "string"))];
      const grIds = [...new Set(rows.map((row) => row.goods_receipt_id).filter((id): id is string => typeof id === "string"))];
      const invIds = [...new Set(rows.map((row) => row.invoice_id).filter((id): id is string => typeof id === "string"))];

      const poNumbers = new Map<string, string>();
      if (poIds.length > 0) {
        const { data, error } = await admin.from("purchase_orders").select("id,po_number").in("id", poIds);
        if (error) fail();
        for (const row of (data ?? []) as Record<string, unknown>[]) poNumbers.set(row.id as string, row.po_number as string);
      }

      const receipts = new Map<string, { receipt_number: string | null; receipt_date: string | null }>();
      if (grIds.length > 0) {
        const { data, error } = await admin.from("goods_receipts").select("id,receipt_number,receipt_date").in("id", grIds);
        if (error) fail();
        for (const row of (data ?? []) as Record<string, unknown>[]) {
          receipts.set(row.id as string, {
            receipt_number: (row.receipt_number as string) ?? null,
            receipt_date: (row.receipt_date as string) ?? null,
          });
        }
      }

      const invoiceNumbers = new Map<string, string>();
      if (invIds.length > 0) {
        const { data, error } = await admin.from("invoices").select("id,invoice_number").in("id", invIds);
        if (error) fail();
        for (const row of (data ?? []) as Record<string, unknown>[]) invoiceNumbers.set(row.id as string, row.invoice_number as string);
      }

      if (supplierIds.length > 0) {
        const { data, error } = await admin.from("suppliers").select("id,name").in("id", supplierIds);
        if (error) fail();
        for (const row of (data ?? []) as Record<string, unknown>[]) supplierNames[row.id as string] = (row.name as string) ?? null;
      }

      const itemsByRequest = new Map<string, StateItem[]>();
      for (const row of (items ?? []) as Record<string, unknown>[]) {
        const key = row.payment_request_id as string;
        const list = itemsByRequest.get(key) ?? [];
        list.push({
          product_name: (row.product_name as string) ?? "",
          quantity: (row.quantity as number) ?? null,
          unit: (row.unit as string) ?? null,
          unit_price: (row.unit_price as number) ?? null,
          line_total: (row.line_total as number) ?? null,
        });
        itemsByRequest.set(key, list);
      }

      for (const row of rows) {
        const id = row.id as string;
        const poId = typeof row.purchase_order_id === "string" ? row.purchase_order_id : null;
        const grId = typeof row.goods_receipt_id === "string" ? row.goods_receipt_id : null;
        const invId = typeof row.invoice_id === "string" ? row.invoice_id : null;
        requests[id] = {
          id,
          request_number: (row.request_number as string) ?? "",
          created_at: (row.created_at as string) ?? "",
          total_amount: (row.total_amount as number) ?? null,
          title: (row.title as string) ?? null,
          description: (row.description as string) ?? null,
          po_number: poId ? poNumbers.get(poId) ?? null : null,
          goods_receipt_number: grId ? receipts.get(grId)?.receipt_number ?? null : null,
          receipt_date: grId ? receipts.get(grId)?.receipt_date ?? null : null,
          invoice_number: invId ? invoiceNumbers.get(invId) ?? null : null,
          items: itemsByRequest.get(id) ?? [],
        };
      }

      return { requests, supplierNames };
    },
  };
}

export function createServiceSink(admin: SupabaseClient): JevDuplicateSink {
  return {
    async upsertChecks(rows: JevCheckRow[]) {
      if (rows.length === 0) return;
      const { error } = await admin
        .from("finance_jev_duplicate_checks")
        .upsert(rows, { onConflict: "pair_key" });
      if (error) fail();
    },
  };
}
