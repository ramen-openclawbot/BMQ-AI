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

export interface BepBnDataSource {
  periods: BepBnPeriodSummary[];
  periodsLoading: boolean;
  periodsError: string | null;
  data: BepBnPeriodData | null;
  dataLoading: boolean;
  dataError: string | null;
  importAttendance: (input: {
    periodId: string;
    fileName: string;
    sha256: string;
    rows: AttendanceRow[];
  }) => Promise<BepBnImportResult>;
  addAdjustment: (periodId: string, input: BepBnAdjustmentInput) => Promise<void>;
  lockPeriod: (periodId: string) => Promise<void>;
  /** Returns the new period id. */
  createPeriod: (input: BepBnPeriodInput) => Promise<string>;
  /** Insert or update one catalogue row of a draft period (unique per period + code). */
  upsertEmployee: (periodId: string, employee: PayrollEmployee) => Promise<void>;
}

export type UseBepBnData = (periodId: string | null) => BepBnDataSource;
