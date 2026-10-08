// Data contract between the Bếp BN payroll panel and its data source.
//
// The panel only renders and collects input; reading periods and writing
// imports, adjustments and the period lock go through this contract, so the
// Supabase-backed hook and the QA fixture can be swapped without touching UI.

import type {
  AdjustmentField,
  AttendanceRow,
  PayrollAdjustment,
  PayrollEmployee,
  PayrollEmployeeMeasures,
  PayrollGroup,
  PayrollPeriod,
} from "@/lib/payroll-bn/types.ts";
import type { AnomalyCode } from "@/lib/payroll-bn/anomalies.ts";
import type { IssueDecision, IssueReview } from "@/lib/payroll-bn/issue-review.ts";

export interface BepBnPeriodSummary {
  id: string;
  code: string;
  name: string;
  dateFrom: string;
  dateTo: string;
  status: PayrollPeriod["status"];
}

export interface BepBnImportSummary {
  id: string;
  fileName: string;
  sha256: string;
  rowCount: number;
  importedAt: string;
}

export interface BepBnPeriodData {
  id: string;
  period: PayrollPeriod;
  employees: PayrollEmployee[];
  measures: Record<string, PayrollEmployeeMeasures>;
  rows: AttendanceRow[];
  adjustments: PayrollAdjustment[];
  imports: BepBnImportSummary[];
  /** When the attendance of this period was approved, or null. */
  attendanceApprovedAt: string | null;
}

export interface BepBnImportResult {
  alreadyImported: boolean;
  insertedRows: number;
}

export interface BepBnAdjustmentInput {
  employeeCode: string;
  field: AdjustmentField;
  value: number | null;
  /** Value shown on the draft before this adjustment, kept for the audit log. */
  oldValue?: number | null;
  reason: string;
}

export interface BepBnPeriodInput {
  code: string;
  name: string;
  dateFrom: string;
  dateTo: string;
  standardDaysByGroup: Record<PayrollGroup, number>;
  holidays: string[];
}

/** Upload without a preselected period: the period is derived from the rows. */
export interface BepBnImportFileInput {
  fileName: string;
  sha256: string;
  rows: AttendanceRow[];
}

export interface BepBnImportFileResult {
  periodId: string;
  alreadyImported: boolean;
  insertedRows: number;
  addedEmployees: number;
}

export interface BepBnIssueReviewInput {
  employeeCode: string;
  workDate: string;
  issueCode: AnomalyCode;
  decision: IssueDecision;
  /** Required (non-blank) when the decision is `excluded`. */
  note?: string | null;
}

export interface BepBnDataSource {
  periods: BepBnPeriodSummary[];
  periodsLoading: boolean;
  periodsError: string | null;
  data: BepBnPeriodData | null;
  dataLoading: boolean;
  dataError: string | null;
  /** Catalogue of the latest period before the selected one (for suggestions). */
  previousEmployees: PayrollEmployee[];
  issueReviews: IssueReview[];
  /** When the selected period's attendance was approved, or null. */
  attendanceApprovedAt: string | null;
  importAttendance: (input: {
    periodId: string;
    fileName: string;
    sha256: string;
    rows: AttendanceRow[];
  }) => Promise<BepBnImportResult>;
  /** Ensure the period for the rows, import them and add every new employee. */
  importFile: (input: BepBnImportFileInput) => Promise<BepBnImportFileResult>;
  addAdjustment: (periodId: string, input: BepBnAdjustmentInput) => Promise<void>;
  /** Accept or exclude one reviewable anomaly (upsert on the unique key). */
  reviewIssue: (periodId: string, input: BepBnIssueReviewInput) => Promise<void>;
  setAttendanceApproved: (periodId: string, approved: boolean) => Promise<void>;
  lockPeriod: (periodId: string) => Promise<void>;
  /** Returns the new period id. */
  createPeriod: (input: BepBnPeriodInput) => Promise<string>;
  /** Insert or update one catalogue row of a draft period (unique per period + code). */
  upsertEmployee: (periodId: string, employee: PayrollEmployee) => Promise<void>;
}

export type UseBepBnData = (periodId: string | null) => BepBnDataSource;
