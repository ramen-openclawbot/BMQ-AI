/**
 * Data-only hook for monthly missions + surprise gifts (payroll_bn).
 *
 * No JSX and no layout: the Maestro builds the screens. Every write goes
 * through the SECURITY DEFINER mission RPCs (owner or payroll.edit is enforced
 * inside the database), never through direct table writes. Query caches are
 * invalidated only after a successful RPC.
 */

import { useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";

interface DbErrorLike {
  message?: string;
  code?: string | null;
}

interface RpcResult {
  data: unknown;
  error: DbErrorLike | null;
}

export interface PayrollMissionsAdminClient {
  rpc(name: string, args?: Record<string, unknown>): PromiseLike<RpcResult>;
}

const client = supabase as unknown as PayrollMissionsAdminClient;

export type PayrollMissionAdminStatus = "draft" | "active" | "closed";
export type PayrollMissionAdminOfferStatus = "pending" | "accepted" | "declined";
export type PayrollMissionAdminItemKind =
  | "attendance_regular"
  | "punctual"
  | "draw_ticket"
  | "manual";

export interface PayrollMissionAdminItem {
  key: string;
  label: string;
  detail: string | null;
  kind: PayrollMissionAdminItemKind;
  amount_vnd: number;
  params: Record<string, unknown> | null;
}

export interface PayrollMissionAdminProgressItem {
  key: string;
  kind: PayrollMissionAdminItemKind;
  met: boolean;
  detail: Record<string, unknown>;
}

export interface PayrollMissionAdminEarnedItem {
  key: string;
  amount_vnd: number;
}

export interface PayrollMissionAdminReview {
  earned: PayrollMissionAdminEarnedItem[];
  disqualified: boolean;
  disqualify_reason: string | null;
  reviewed_by: string | null;
  reviewed_at: string;
}

export interface PayrollMissionAdminTicket {
  quarter: string;
  issued_at: string;
  void_reason: string | null;
}

export interface PayrollMissionAdminOffer {
  id: string;
  campaign_id: string;
  employee_code: string;
  gift_enabled: boolean;
  status: PayrollMissionAdminOfferStatus;
  shift_start: string | null;
  offered_at: string;
  responded_at: string | null;
  progress: PayrollMissionAdminProgressItem[];
  review: PayrollMissionAdminReview | null;
  ticket: PayrollMissionAdminTicket | null;
}

export interface PayrollMissionAdminCampaign {
  id: string;
  code: string;
  title: string;
  summary: string | null;
  starts_on: string;
  ends_on: string;
  eligible_groups: string[];
  items: PayrollMissionAdminItem[];
  rules: string[];
  draw: Record<string, unknown> | null;
  status: PayrollMissionAdminStatus;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  offers: PayrollMissionAdminOffer[];
}

export interface PayrollMissionsAdminList {
  campaigns: PayrollMissionAdminCampaign[];
}

export interface PayrollMissionsAdminOptions {
  campaignId?: string | null;
  enabled?: boolean;
}

const GENERIC_ERROR = "Không thực hiện được thao tác nhiệm vụ. Vui lòng thử lại.";

export function formatPayrollMissionsAdminError(error: unknown): string {
  const message = (error as DbErrorLike | null)?.message;
  return typeof message === "string" && message.trim() !== "" ? message : GENERIC_ERROR;
}

async function callRpc(name: string, args: Record<string, unknown>): Promise<unknown> {
  const { data, error } = await client.rpc(name, args);
  if (error) throw new Error(formatPayrollMissionsAdminError(error));
  return data;
}

export function usePayrollMissionsAdmin(options: PayrollMissionsAdminOptions = {}) {
  const queryClient = useQueryClient();
  const enabled = options.enabled ?? true;
  const campaignId = options.campaignId ?? null;

  const missionsQuery = useQuery({
    queryKey: ["payroll-missions", campaignId],
    enabled,
    queryFn: async (): Promise<PayrollMissionsAdminList> => {
      const data = await callRpc("list_payroll_missions", {
        p_campaign_id: campaignId,
      });
      const payload = (data || {}) as { campaigns?: PayrollMissionAdminCampaign[] };
      return {
        campaigns: Array.isArray(payload.campaigns) ? payload.campaigns : [],
      };
    },
  });

  const invalidate = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ["payroll-missions"] });
  }, [queryClient]);

  const setGiftMutation = useMutation({
    mutationFn: async (input: {
      campaignId: string;
      employeeCode: string;
      enabled: boolean;
      shiftStart?: string | null;
    }) =>
      callRpc("set_payroll_mission_gift", {
        p_campaign_id: input.campaignId,
        p_employee_code: input.employeeCode,
        p_enabled: input.enabled,
        p_shift_start: input.shiftStart ?? null,
      }),
    onSuccess: invalidate,
  });

  const setGiftBulkMutation = useMutation({
    mutationFn: async (input: {
      campaignId: string;
      employeeCodes: string[];
      enabled: boolean;
    }) =>
      callRpc("set_payroll_mission_gift_bulk", {
        p_campaign_id: input.campaignId,
        p_employee_codes: input.employeeCodes,
        p_enabled: input.enabled,
      }),
    onSuccess: invalidate,
  });

  const reviewOfferMutation = useMutation({
    mutationFn: async (input: {
      offerId: string;
      earnedKeys: string[];
      disqualified: boolean;
      reason?: string | null;
    }) =>
      callRpc("review_payroll_mission_offer", {
        p_offer_id: input.offerId,
        p_earned_keys: input.earnedKeys,
        p_disqualified: input.disqualified,
        p_reason: input.reason ?? null,
      }),
    onSuccess: invalidate,
  });

  const setCampaignStatusMutation = useMutation({
    mutationFn: async (input: {
      campaignId: string;
      status: PayrollMissionAdminStatus;
    }) =>
      callRpc("set_payroll_mission_campaign_status", {
        p_campaign_id: input.campaignId,
        p_status: input.status,
      }),
    onSuccess: invalidate,
  });

  return {
    campaignId,
    missionsQuery,
    campaigns: missionsQuery.data?.campaigns ?? [],
    setGift: setGiftMutation,
    setGiftBulk: setGiftBulkMutation,
    reviewOffer: reviewOfferMutation,
    setCampaignStatus: setCampaignStatusMutation,
  };
}

export default usePayrollMissionsAdmin;
