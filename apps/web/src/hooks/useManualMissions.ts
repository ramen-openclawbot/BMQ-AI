import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import {
  evidencePhotoPath,
  parseCreateManualMissionResult,
  parseManualBatches,
  parseManualMissionActionResult,
  parseManualStaff,
  parseManualSubmissions,
  parseMyManualMissions,
  parseReviewManualMissionResult,
  type CreateManualMissionResult,
  type ManualBatch,
  type ManualEvidenceSpec,
  type ManualLocation,
  type ManualMissionActionResult,
  type ManualPriority,
  type ManualStaffMember,
  type ManualSubmission,
  type MyManualMission,
  type ReviewManualMissionResult,
} from "@/lib/manual-missions";
import { MISSIONS_QUERY_KEY } from "./useMissions";

export const MY_MANUAL_MISSIONS_QUERY_KEY = "my-manual-missions";
export const MANUAL_MISSIONS_OVERVIEW_QUERY_KEY = "manual-missions-overview";
export const MANUAL_MISSION_STAFF_QUERY_KEY = "manual-mission-staff";
export const MANUAL_MISSION_SUBMISSIONS_QUERY_KEY = "manual-mission-submissions";

/** One request id per click so the server can ignore a replay. */
function newRequestId(): string {
  return crypto.randomUUID();
}

/** A manual-mission change moves the board, the owner overview and the staff list. */
function invalidateManualMissions(queryClient: QueryClient): void {
  for (const key of [
    MISSIONS_QUERY_KEY,
    MY_MANUAL_MISSIONS_QUERY_KEY,
    MANUAL_MISSIONS_OVERVIEW_QUERY_KEY,
    MANUAL_MISSION_STAFF_QUERY_KEY,
    MANUAL_MISSION_SUBMISSIONS_QUERY_KEY,
  ]) {
    void queryClient.invalidateQueries({ queryKey: [key] });
  }
}

/** The caller's open / completed manual missions with their latest submission. */
export function useMyManualMissions() {
  return useQuery({
    queryKey: [MY_MANUAL_MISSIONS_QUERY_KEY],
    queryFn: async (): Promise<MyManualMission[]> => {
      const { data, error } = await supabase.rpc("get_my_manual_missions" as never);
      if (error) throw error;
      return parseMyManualMissions(data);
    },
  });
}

/** Every non-cancelled batch, newest first (owner only). */
export function useManualMissionsOverview(enabled = true) {
  return useQuery({
    queryKey: [MANUAL_MISSIONS_OVERVIEW_QUERY_KEY],
    enabled,
    queryFn: async (): Promise<ManualBatch[]> => {
      const { data, error } = await supabase.rpc(
        "get_manual_missions_overview" as never,
        { p_limit: 60 } as never,
      );
      if (error) throw error;
      return parseManualBatches(data);
    },
  });
}

/** Staff with a user_roles row, excluding the caller (owner only). */
export function useManualMissionStaff(enabled = true) {
  return useQuery({
    queryKey: [MANUAL_MISSION_STAFF_QUERY_KEY],
    enabled,
    queryFn: async (): Promise<ManualStaffMember[]> => {
      const { data, error } = await supabase.rpc("get_manual_mission_staff" as never);
      if (error) throw error;
      return parseManualStaff(data);
    },
  });
}

/** All submissions of one mission, newest first (assignee or owner). */
export function useManualMissionSubmissions(missionId: string | null) {
  return useQuery({
    queryKey: [MANUAL_MISSION_SUBMISSIONS_QUERY_KEY, missionId],
    enabled: Boolean(missionId),
    queryFn: async (): Promise<ManualSubmission[]> => {
      const { data, error } = await supabase.rpc(
        "get_mission_submissions" as never,
        { p_mission_id: missionId } as never,
      );
      if (error) throw error;
      return parseManualSubmissions(data);
    },
  });
}

export interface CreateManualMissionInput {
  title: string;
  description?: string | null;
  assigneeIds: string[];
  dueAt?: string | null;
  priority: ManualPriority;
  location?: ManualLocation | null;
  evidence: ManualEvidenceSpec;
  /** Generated per click when omitted. */
  requestId?: string;
}

/** Create one manual batch and one mission row per assignee (owner only). */
export function useCreateManualMission() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateManualMissionInput): Promise<CreateManualMissionResult> => {
      const { data, error } = await supabase.rpc("create_manual_mission" as never, {
        p_title: input.title,
        p_description: input.description ?? null,
        p_assignee_ids: input.assigneeIds,
        p_due_at: input.dueAt ?? null,
        p_priority: input.priority,
        p_location: input.location ?? null,
        p_evidence: input.evidence,
        p_request_id: input.requestId ?? newRequestId(),
      } as never);
      if (error) throw error;
      return parseCreateManualMissionResult(data);
    },
    onSuccess: () => invalidateManualMissions(queryClient),
  });
}

export interface AddManualMissionAssigneeInput {
  batchId: string;
  userId: string;
}

/** Add one assignee to an existing batch (owner only). */
export function useAddManualMissionAssignee() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: AddManualMissionAssigneeInput): Promise<ManualMissionActionResult> => {
      const { data, error } = await supabase.rpc("add_manual_mission_assignee" as never, {
        p_batch_id: input.batchId,
        p_user_id: input.userId,
      } as never);
      if (error) throw error;
      return parseManualMissionActionResult(data);
    },
    onSuccess: () => invalidateManualMissions(queryClient),
  });
}

export interface CancelManualMissionInput {
  missionId: string;
}

/** Cancel one manual mission (owner only; no Zalo notice). */
export function useCancelManualMission() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CancelManualMissionInput): Promise<ManualMissionActionResult> => {
      const { data, error } = await supabase.rpc("cancel_manual_mission" as never, {
        p_mission_id: input.missionId,
      } as never);
      if (error) throw error;
      return parseManualMissionActionResult(data);
    },
    onSuccess: () => invalidateManualMissions(queryClient),
  });
}

export interface SubmitManualMissionInput {
  missionId: string;
  note?: string | null;
  numberValue?: number | null;
  /** New local photos; uploaded to mission-evidence before the RPC call. */
  files?: File[];
  /** Already-uploaded paths (for example a retried submit). */
  photoPaths?: string[];
  checklist?: boolean[];
  /** Generated once per submit attempt when omitted. */
  requestId?: string;
}

/** Upload the evidence photos, then submit the mission for owner review. */
export function useSubmitManualMission() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: SubmitManualMissionInput): Promise<ManualSubmission> => {
      const requestId = input.requestId ?? newRequestId();
      const photoPaths = [...(input.photoPaths ?? [])];

      for (const file of input.files ?? []) {
        const path = evidencePhotoPath(input.missionId, file.name);
        const { error: uploadError } = await supabase.storage
          .from("mission-evidence")
          .upload(path, file, {
            contentType: file.type || undefined,
            upsert: false,
          });
        if (uploadError) throw uploadError;
        photoPaths.push(path);
      }

      const { data, error } = await supabase.rpc("submit_manual_mission" as never, {
        p_mission_id: input.missionId,
        p_note: input.note ?? null,
        p_number: input.numberValue ?? null,
        p_photo_paths: photoPaths,
        p_checklist: input.checklist ?? [],
        p_request_id: requestId,
      } as never);
      if (error) throw error;
      const parsed = parseManualSubmissions([data])[0];
      if (!parsed) throw new Error("invalid_submission_result");
      return parsed;
    },
    onSuccess: () => invalidateManualMissions(queryClient),
  });
}

export interface ReviewManualMissionInput {
  submissionId: string;
  approve: boolean;
  rating?: number | null;
  note?: string | null;
}

/** Approve (optionally with a 1-5 rating) or return a submission (owner only). */
export function useReviewManualMission() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: ReviewManualMissionInput): Promise<ReviewManualMissionResult> => {
      const { data, error } = await supabase.rpc("review_manual_mission" as never, {
        p_submission_id: input.submissionId,
        p_approve: input.approve,
        p_rating: input.rating ?? null,
        p_note: input.note ?? null,
      } as never);
      if (error) throw error;
      return parseReviewManualMissionResult(data);
    },
    onSuccess: () => invalidateManualMissions(queryClient),
  });
}
