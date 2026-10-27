import { useInfiniteQuery } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import {
  parseKhoAuditPage,
  type KhoAuditKind,
  type KhoAuditPage,
} from "@/lib/kho-audit";

export const KHO_AUDIT_QUERY_KEY = "kho-audit";

/** Paging cursor: rows written together share a timestamp, so the key breaks the tie. */
interface AuditCursor { before: string; key: string }

export interface KhoAuditLogFilters {
  from?: string | null;
  to?: string | null;
  actorId?: string | null;
  itemId?: string | null;
  kinds?: KhoAuditKind[] | null;
}

export interface UseKhoAuditLogOptions {
  pageSize?: number;
}

/**
 * One page of the normalised audit feed.  `p_before` + `p_before_key` are the occurred_at and key of the
 * last row of the previous page; the server returns newest first.
 */
const rpc = supabase.rpc.bind(supabase) as unknown as (
  fn: string,
  args?: Record<string, unknown>,
) => Promise<{ data: unknown; error: unknown }>;

function clean(value: string | null | undefined): string | null {
  const text = String(value ?? "").trim();
  return text === "" ? null : text;
}

export function useKhoAuditLog(
  filters: KhoAuditLogFilters = {},
  options: UseKhoAuditLogOptions = {},
) {
  const from = clean(filters.from);
  const to = clean(filters.to);
  const actorId = clean(filters.actorId);
  const itemId = clean(filters.itemId);
  const kinds = filters.kinds && filters.kinds.length > 0 ? [...filters.kinds] : null;
  const requestedPageSize = options.pageSize;
  const limit = typeof requestedPageSize === "number" && Number.isFinite(requestedPageSize)
    ? Math.max(1, Math.min(200, Math.trunc(requestedPageSize)))
    : 50;

  return useInfiniteQuery({
    queryKey: [KHO_AUDIT_QUERY_KEY, from, to, actorId, itemId, kinds, limit],
    initialPageParam: null as AuditCursor | null,
    queryFn: async ({ pageParam }): Promise<KhoAuditPage> => {
      const { data, error } = await rpc("kho_get_audit_log", {
        p_from: from,
        p_to: to,
        p_actor: actorId,
        p_item_id: itemId,
        p_kinds: kinds,
        p_limit: limit,
        p_before: pageParam?.before ?? null,
        p_before_key: pageParam?.key ?? null,
      });
      if (error) throw error;
      return parseKhoAuditPage(data);
    },
    getNextPageParam: (lastPage): AuditCursor | undefined => {
      if (!lastPage.has_more) return undefined;
      const last = lastPage.items[lastPage.items.length - 1];
      return last ? { before: last.occurred_at, key: last.key } : undefined;
    },
  });
}
