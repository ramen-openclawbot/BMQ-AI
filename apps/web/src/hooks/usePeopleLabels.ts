import { usePeopleCopy } from "./usePeopleCopy";
import type { PeopleKey } from "@/i18n/people";

// Explicit code-to-copy maps for render boundaries only. Never pass names, notes or export rows.
const statuses: Record<string, PeopleKey> = {
  missing_both: "missingBoth", missing_check_in: "missingIn", missing_check_out: "missingOut",
  late_early_leave: "lateEarly", late: "late", early_leave: "earlyLeave", present: "present",
  draft: "draft", calculated: "calculated", approved: "approved", locked: "locked",
};
const roles: Record<string, PeopleKey> = { owner: "owner", staff: "staff", warehouse: "warehouse", viewer: "viewer" };
const wages: Record<string, PeopleKey> = { monthly: "monthly", hourly: "hourly", per_shift: "perShift2" };
const sources: Record<string, PeopleKey> = { qr: "qrSource", manual: "manualSource", mobile: "mobileSource", report_staff: "kioskStaff", delivery_staff: "deliveryStaff", check_in: "checkIn", check_out: "checkOut" };
const reasons: Record<string, PeopleKey> = {
  within_geofence: "withinGeofence", accuracy_too_low: "lowAccuracy", outside_geofence: "outsideRadius",
  report_session_required: "reportSessionRequired", invalid_latitude: "invalidLatitude", invalid_longitude: "invalidLongitude",
  invalid_accuracy: "invalidAccuracy", invalid_captured_at: "invalidCapturedAt", captured_at_stale: "capturedAtStale", captured_at_future: "capturedAtFuture",
};
const locations: Record<string, PeopleKey> = { kiosk: "kioskLocation", warehouse: "warehouseLocation" };
export function usePeopleLabels() {
  const pc = usePeopleCopy();
  const label = (map: Record<string, PeopleKey>, code: string) => map[code] ? pc(map[code]) : code;
  return { reason: (code: string) => label(reasons, code), location: (code: string) => label(locations, code), status: (code: string) => label(statuses, code), role: (code: string) => label(roles, code), wage: (code: string) => label(wages, code), source: (code: string) => label(sources, code) };
}
