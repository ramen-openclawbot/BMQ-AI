/**
 * Data-only hooks for the live Bếp BN attendance board.
 *
 * No JSX and no layout: the Maestro builds the screen. Both RPCs are read-only
 * and enforce owner / payroll.edit inside the database. The board polls only
 * while it is showing today in Asia/Ho_Chi_Minh; a past day is fetched once and
 * refreshed on window focus.
 */

import { useQuery } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import {
  mapAttendanceBoard,
  mapPunctualityRanking,
  type AttendanceBoard,
  type PunctualityRanking,
} from "@/lib/payroll-bn/attendance-board.ts";

interface DbErrorLike {
  message?: string;
  code?: string | null;
}

interface RpcResult {
  data: unknown;
  error: DbErrorLike | null;
}

export interface PayrollBnAttendanceBoardClient {
  rpc(name: string, args?: Record<string, unknown>): PromiseLike<RpcResult>;
}

const client = supabase as unknown as PayrollBnAttendanceBoardClient;

const GENERIC_ERROR = "Không tải được bảng chấm công. Vui lòng thử lại.";

export function formatPayrollBnAttendanceBoardError(error: unknown): string {
  const message = (error as DbErrorLike | null)?.message;
  return typeof message === "string" && message.trim() !== "" ? message : GENERIC_ERROR;
}

async function callRpc(name: string, args: Record<string, unknown>): Promise<unknown> {
  const { data, error } = await client.rpc(name, args);
  if (error) throw new Error(formatPayrollBnAttendanceBoardError(error));
  return data;
}

/** Today's date in Asia/Ho_Chi_Minh as YYYY-MM-DD, without relying on the host zone. */
export function ictToday(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);

  const pick = (type: "year" | "month" | "day"): string =>
    parts.find((part) => part.type === type)?.value ?? "";

  return `${pick("year")}-${pick("month")}-${pick("day")}`;
}

/** The board polls only for today; a null date means the RPC's own "today". */
export function isAttendanceBoardToday(date: string | null | undefined, now: Date = new Date()): boolean {
  if (!date) return true;
  return date.slice(0, 10) === ictToday(now);
}

/** One-day manager board. Passing null asks the server for today in Vietnam. */
export function useAttendanceBoard(
  date: string | null,
  options: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: ["payroll-bn-attendance-board", date],
    enabled: options.enabled ?? true,
    refetchInterval: isAttendanceBoardToday(date) ? 20_000 : false,
    refetchOnWindowFocus: true,
    queryFn: async (): Promise<AttendanceBoard> => {
      const data = await callRpc("get_payroll_bn_attendance_board", { p_date: date });
      return mapAttendanceBoard(data);
    },
  });
}

/** Punctuality ranking for a past range; the server clamps the end date. */
export function usePunctualityRanking(
  from: string | null,
  to: string | null,
  options: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: ["payroll-bn-punctuality-ranking", from, to],
    enabled: (options.enabled ?? true) && Boolean(from && to),
    refetchOnWindowFocus: true,
    queryFn: async (): Promise<PunctualityRanking> => {
      const data = await callRpc("get_payroll_bn_punctuality_ranking", {
        p_from: from,
        p_to: to,
      });
      return mapPunctualityRanking(data);
    },
  });
}

export default useAttendanceBoard;
