// Real T09.2026 machine attendance (period bdc6d907…, read 2026-10-09) for two
// employees whose pay differed from the HR sheet. Verbatim rows: do not edit.
//
// Owner rules 2026-10-09:
// - 00025 Lưu Vĩnh An: 02/09 (paid holiday) was worked 12:58–18:01 (~5h) and
//   counts 0,5 công → NC thực tế 24 + 0,5 = 24,5; + 2 ngày lễ = NC tính lương 26,5.
// - 00011 Nguyễn Lê Huyền Trang: left after 13/09 ("chốt lương", end date
//   2026-09-13) → no paid holidays and no overtime pay; NC tính lương 9.
import type { AttendanceRow, PayrollEmployee } from "./types.ts";

export const T09_REAL_PERIOD_ID = "bdc6d907-b785-4c0c-8308-5b84c4dd0d70";

/** Catalogue rows as in the real period (Trang with the end date the owner confirmed). */
export const T09_REAL_EMPLOYEES: PayrollEmployee[] = [
  { code: "00025", name: "Lưu Vĩnh An", group: "Bếp bánh", employmentType: "official", monthlySalary: 13000000, hourlyRate: null, allowance: 500000, overtimeRate: 30000, standardDaysOverride: null, startDate: null, endDate: null, terminated: false },
  { code: "00011", name: "Nguyễn Lê Huyền Trang", group: "Bếp bánh", employmentType: "official", monthlySalary: 8000000, hourlyRate: null, allowance: null, overtimeRate: 30000, standardDaysOverride: null, startDate: null, endDate: "2026-09-13", terminated: false },
];

/** Expected results under the owner's rules (standard days Bếp bánh 26, holidays 01–02/09). */
export const T09_REAL_EXPECTED = {
  "00025": { actualWorkDays: 24.5, holidayPayDays: 2, workDays: 26.5, dayPay: 13250000, overtimePay: 1873000, netPay: 15623000 },
  "00011": { actualWorkDays: 9, holidayPayDays: 0, workDays: 9, overtimePay: 0, netPay: 2769000 },
} as const;

export const T09_REAL_ROWS: AttendanceRow[] = [
  { employeeCode: "00011", employeeName: "Trang", date: "2026-09-01", checkIn: null, checkOut: null, department: null },
  { employeeCode: "00011", employeeName: "Trang", date: "2026-09-02", checkIn: null, checkOut: null, department: null },
  { employeeCode: "00011", employeeName: "Trang", date: "2026-09-03", checkIn: "07:09:00", checkOut: "16:11:00", department: null },
  { employeeCode: "00011", employeeName: "Trang", date: "2026-09-04", checkIn: null, checkOut: null, department: null },
  { employeeCode: "00011", employeeName: "Trang", date: "2026-09-05", checkIn: null, checkOut: null, department: null },
  { employeeCode: "00011", employeeName: "Trang", date: "2026-09-06", checkIn: "07:01:00", checkOut: "16:10:00", department: null },
  { employeeCode: "00011", employeeName: "Trang", date: "2026-09-07", checkIn: "07:12:00", checkOut: "16:10:00", department: null },
  { employeeCode: "00011", employeeName: "Trang", date: "2026-09-08", checkIn: "07:10:00", checkOut: "16:27:00", department: null },
  { employeeCode: "00011", employeeName: "Trang", date: "2026-09-09", checkIn: "07:18:00", checkOut: "16:08:00", department: null },
  { employeeCode: "00011", employeeName: "Trang", date: "2026-09-10", checkIn: "07:11:00", checkOut: "16:08:00", department: null },
  { employeeCode: "00011", employeeName: "Trang", date: "2026-09-11", checkIn: "07:12:00", checkOut: "16:08:00", department: null },
  { employeeCode: "00011", employeeName: "Trang", date: "2026-09-12", checkIn: "07:07:00", checkOut: "16:14:00", department: null },
  { employeeCode: "00011", employeeName: "Trang", date: "2026-09-13", checkIn: "07:07:00", checkOut: "16:16:00", department: null },
  { employeeCode: "00011", employeeName: "Trang", date: "2026-09-14", checkIn: null, checkOut: null, department: null },
  { employeeCode: "00011", employeeName: "Trang", date: "2026-09-15", checkIn: null, checkOut: null, department: null },
  { employeeCode: "00011", employeeName: "Trang", date: "2026-09-16", checkIn: null, checkOut: null, department: null },
  { employeeCode: "00011", employeeName: "Trang", date: "2026-09-17", checkIn: null, checkOut: null, department: null },
  { employeeCode: "00011", employeeName: "Trang", date: "2026-09-18", checkIn: null, checkOut: null, department: null },
  { employeeCode: "00011", employeeName: "Trang", date: "2026-09-19", checkIn: null, checkOut: null, department: null },
  { employeeCode: "00011", employeeName: "Trang", date: "2026-09-20", checkIn: null, checkOut: null, department: null },
  { employeeCode: "00011", employeeName: "Trang", date: "2026-09-21", checkIn: null, checkOut: null, department: null },
  { employeeCode: "00011", employeeName: "Trang", date: "2026-09-22", checkIn: null, checkOut: null, department: null },
  { employeeCode: "00011", employeeName: "Trang", date: "2026-09-23", checkIn: null, checkOut: null, department: null },
  { employeeCode: "00011", employeeName: "Trang", date: "2026-09-24", checkIn: null, checkOut: null, department: null },
  { employeeCode: "00011", employeeName: "Trang", date: "2026-09-25", checkIn: null, checkOut: null, department: null },
  { employeeCode: "00011", employeeName: "Trang", date: "2026-09-26", checkIn: null, checkOut: null, department: null },
  { employeeCode: "00011", employeeName: "Trang", date: "2026-09-27", checkIn: null, checkOut: null, department: null },
  { employeeCode: "00011", employeeName: "Trang", date: "2026-09-28", checkIn: null, checkOut: null, department: null },
  { employeeCode: "00011", employeeName: "Trang", date: "2026-09-29", checkIn: null, checkOut: null, department: null },
  { employeeCode: "00011", employeeName: "Trang", date: "2026-09-30", checkIn: null, checkOut: null, department: null },
  { employeeCode: "00025", employeeName: "VinhAn", date: "2026-09-01", checkIn: null, checkOut: null, department: null },
  { employeeCode: "00025", employeeName: "VinhAn", date: "2026-09-02", checkIn: "12:58:00", checkOut: "18:01:00", department: null },
  { employeeCode: "00025", employeeName: "VinhAn", date: "2026-09-03", checkIn: "03:54:00", checkOut: "16:15:00", department: null },
  { employeeCode: "00025", employeeName: "VinhAn", date: "2026-09-04", checkIn: "04:58:00", checkOut: "17:02:00", department: null },
  { employeeCode: "00025", employeeName: "VinhAn", date: "2026-09-05", checkIn: "05:34:00", checkOut: "17:04:00", department: null },
  { employeeCode: "00025", employeeName: "VinhAn", date: "2026-09-06", checkIn: null, checkOut: null, department: null },
  { employeeCode: "00025", employeeName: "VinhAn", date: "2026-09-07", checkIn: null, checkOut: null, department: null },
  { employeeCode: "00025", employeeName: "VinhAn", date: "2026-09-08", checkIn: "04:53:00", checkOut: "16:06:00", department: null },
  { employeeCode: "00025", employeeName: "VinhAn", date: "2026-09-09", checkIn: "06:00:00", checkOut: "16:09:00", department: null },
  { employeeCode: "00025", employeeName: "VinhAn", date: "2026-09-10", checkIn: "04:49:00", checkOut: "16:06:00", department: null },
  { employeeCode: "00025", employeeName: "VinhAn", date: "2026-09-11", checkIn: "05:32:00", checkOut: "16:01:00", department: null },
  { employeeCode: "00025", employeeName: "VinhAn", date: "2026-09-12", checkIn: "04:26:00", checkOut: "16:02:00", department: null },
  { employeeCode: "00025", employeeName: "VinhAn", date: "2026-09-13", checkIn: "04:44:00", checkOut: "15:45:00", department: null },
  { employeeCode: "00025", employeeName: "VinhAn", date: "2026-09-14", checkIn: null, checkOut: null, department: null },
  { employeeCode: "00025", employeeName: "VinhAn", date: "2026-09-15", checkIn: "04:17:00", checkOut: "17:22:00", department: null },
  { employeeCode: "00025", employeeName: "VinhAn", date: "2026-09-16", checkIn: "03:55:00", checkOut: "16:34:00", department: null },
  { employeeCode: "00025", employeeName: "VinhAn", date: "2026-09-17", checkIn: "04:46:00", checkOut: "15:26:00", department: null },
  { employeeCode: "00025", employeeName: "VinhAn", date: "2026-09-18", checkIn: "03:19:00", checkOut: "16:29:00", department: null },
  { employeeCode: "00025", employeeName: "VinhAn", date: "2026-09-19", checkIn: "03:21:00", checkOut: "15:37:00", department: null },
  { employeeCode: "00025", employeeName: "VinhAn", date: "2026-09-20", checkIn: "05:35:00", checkOut: "16:32:00", department: null },
  { employeeCode: "00025", employeeName: "VinhAn", date: "2026-09-21", checkIn: "04:48:00", checkOut: "16:54:00", department: null },
  { employeeCode: "00025", employeeName: "VinhAn", date: "2026-09-22", checkIn: "04:16:00", checkOut: "16:36:00", department: null },
  { employeeCode: "00025", employeeName: "VinhAn", date: "2026-09-23", checkIn: "05:18:00", checkOut: "15:42:00", department: null },
  { employeeCode: "00025", employeeName: "VinhAn", date: "2026-09-24", checkIn: "03:51:00", checkOut: "16:00:00", department: null },
  { employeeCode: "00025", employeeName: "VinhAn", date: "2026-09-25", checkIn: "03:48:00", checkOut: "15:03:00", department: null },
  { employeeCode: "00025", employeeName: "VinhAn", date: "2026-09-26", checkIn: "06:58:00", checkOut: "17:24:00", department: null },
  { employeeCode: "00025", employeeName: "VinhAn", date: "2026-09-27", checkIn: "04:19:00", checkOut: "16:02:00", department: null },
  { employeeCode: "00025", employeeName: "VinhAn", date: "2026-09-28", checkIn: "04:32:00", checkOut: "16:11:00", department: null },
  { employeeCode: "00025", employeeName: "VinhAn", date: "2026-09-29", checkIn: null, checkOut: null, department: null },
  { employeeCode: "00025", employeeName: "VinhAn", date: "2026-09-30", checkIn: "03:50:00", checkOut: "15:47:00", department: null },
];
