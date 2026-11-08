/**
 * Data-only hook for Bếp Q7 GPS attendance administration.
 *
 * No JSX and no layout: the Maestro builds the screen. Every write goes through
 * the SECURITY DEFINER admin RPCs (owner or payroll.edit is enforced inside the
 * database), never through direct table writes, and the query caches are
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

export interface PayrollAttendanceAdminClient {
  rpc(name: string, args?: Record<string, unknown>): PromiseLike<RpcResult>;
}

const client = supabase as unknown as PayrollAttendanceAdminClient;

export type PayrollAttendanceAdminDayStatus =
  | "complete"
  | "missing_in"
  | "missing_out"
  | "approved_override";

export interface PayrollAttendanceAdminEvent {
  id: string;
  employee_code: string;
  event_kind: "in" | "out";
  work_date: string;
  server_received_at: string;
  device_captured_at: string | null;
  latitude: number | null;
  longitude: number | null;
  accuracy_m: number | null;
  geofence_location_id: string | null;
  distance_m: number | null;
  decision: "accepted" | "rejected";
  reject_reason: string | null;
  suspected_proxy: boolean;
  device_hash: string | null;
  session_id: string | null;
  selfie_path: string | null;
  created_at: string;
}

export interface PayrollAttendanceAdminDay {
  employee_code: string;
  work_date: string;
  status: PayrollAttendanceAdminDayStatus;
  has_accepted_in: boolean;
  has_accepted_out: boolean;
  approved_override: boolean;
  suspected_proxy: boolean;
}

export interface PayrollAttendanceAdminGate {
  employee_code: string;
  enabled: boolean;
  geofence_location_id: string | null;
  updated_at: string;
}

export interface PayrollAttendanceAdminSite {
  id: string;
  code: string;
  name: string;
  latitude: number | null;
  longitude: number | null;
  radius_m: number;
  active: boolean;
  configured: boolean;
}

export interface PayrollAttendanceAdminConsent {
  employee_code: string;
  consent_version: string;
  accepted_at: string;
  withdrawn_at: string | null;
}

export interface PayrollAttendanceAdminList {
  from: string;
  to: string;
  events: PayrollAttendanceAdminEvent[];
  days: PayrollAttendanceAdminDay[];
  gates: PayrollAttendanceAdminGate[];
  consents: PayrollAttendanceAdminConsent[];
  site: PayrollAttendanceAdminSite | null;
}

export interface PayrollAttendanceAdminDevice {
  id: string;
  employee_code: string;
  device_hash: string;
  status: "active" | "pending" | "revoked";
  first_seen_at: string;
  approved_by: string | null;
  approved_at: string | null;
  user_agent_family: string | null;
}

export interface PayrollAttendanceAdminOptions {
  from?: string;
  to?: string;
  deviceEmployeeCode?: string | null;
  deviceStatus?: "active" | "pending" | "revoked" | null;
  enabled?: boolean;
}

const GENERIC_ERROR = "Không thực hiện được thao tác chấm công. Vui lòng thử lại.";

export function formatPayrollAttendanceAdminError(error: unknown): string {
  const message = (error as DbErrorLike | null)?.message;
  return typeof message === "string" && message.trim() !== "" ? message : GENERIC_ERROR;
}

function todayInVietnam(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function previousDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) - days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

async function callRpc(name: string, args: Record<string, unknown>): Promise<unknown> {
  const { data, error } = await client.rpc(name, args);
  if (error) throw new Error(formatPayrollAttendanceAdminError(error));
  return data;
}

export function usePayrollBnAttendanceAdmin(options: PayrollAttendanceAdminOptions = {}) {
  const queryClient = useQueryClient();
  const enabled = options.enabled ?? true;
  const to = options.to ?? todayInVietnam();
  const from = options.from ?? previousDate(to, 34);
  const deviceEmployeeCode = options.deviceEmployeeCode ?? null;
  const deviceStatus = options.deviceStatus ?? null;

  const attendanceQuery = useQuery({
    queryKey: ["payroll-bn-attendance", from, to],
    enabled,
    queryFn: async (): Promise<PayrollAttendanceAdminList> => {
      const data = await callRpc("list_payroll_bn_attendance", {
        p_from: from,
        p_to: to,
      });
      return (data || { from, to, events: [], days: [], gates: [], consents: [], site: null }) as PayrollAttendanceAdminList;
    },
  });

  const devicesQuery = useQuery({
    queryKey: ["payroll-bn-attendance-devices", deviceEmployeeCode, deviceStatus],
    enabled,
    queryFn: async (): Promise<PayrollAttendanceAdminDevice[]> => {
      const data = await callRpc("list_payroll_bn_attendance_devices", {
        p_employee_code: deviceEmployeeCode,
        p_status: deviceStatus,
      });
      const payload = (data || {}) as { devices?: PayrollAttendanceAdminDevice[] };
      return Array.isArray(payload.devices) ? payload.devices : [];
    },
  });

  const invalidate = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["payroll-bn-attendance"] }),
      queryClient.invalidateQueries({ queryKey: ["payroll-bn-attendance-devices"] }),
    ]);
  }, [queryClient]);

  const setGateMutation = useMutation({
    mutationFn: async (input: {
      employeeCode: string;
      enabled: boolean;
      geofenceLocationId?: string | null;
    }) =>
      callRpc("set_payroll_bn_attendance_gate", {
        p_employee_code: input.employeeCode,
        p_enabled: input.enabled,
        p_geofence_location_id: input.geofenceLocationId ?? null,
      }),
    onSuccess: invalidate,
  });

  const approveDeviceMutation = useMutation({
    mutationFn: async (input: { deviceId: string }) =>
      callRpc("approve_payroll_bn_attendance_device", { p_device_id: input.deviceId }),
    onSuccess: invalidate,
  });

  const revokeDeviceMutation = useMutation({
    mutationFn: async (input: { deviceId: string }) =>
      callRpc("revoke_payroll_bn_attendance_device", { p_device_id: input.deviceId }),
    onSuccess: invalidate,
  });

  const approveDayMutation = useMutation({
    mutationFn: async (input: { employeeCode: string; workDate: string; reason: string }) =>
      callRpc("approve_payroll_bn_attendance_day", {
        p_employee_code: input.employeeCode,
        p_work_date: input.workDate,
        p_reason: input.reason,
      }),
    onSuccess: invalidate,
  });

  const setKitchenSiteMutation = useMutation({
    mutationFn: async (input: { latitude: number; longitude: number; radiusM: number }) =>
      callRpc("set_payroll_bn_kitchen_q7_site", {
        p_latitude: input.latitude,
        p_longitude: input.longitude,
        p_radius_m: input.radiusM,
      }),
    onSuccess: invalidate,
  });

  return {
    from,
    to,
    attendanceQuery,
    consents: attendanceQuery.data?.consents ?? [],
    devicesQuery,
    setGate: setGateMutation,
    approveDevice: approveDeviceMutation,
    revokeDevice: revokeDeviceMutation,
    approveDay: approveDayMutation,
    setKitchenSite: setKitchenSiteMutation,
  };
}

export default usePayrollBnAttendanceAdmin;
