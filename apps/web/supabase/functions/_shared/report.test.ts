import assert from "node:assert/strict";

import { publicVerifiedReportOtpPayload, resolvePostOtpAttendanceEnabled } from "./report.ts";

function makeSupabase(gateValue: boolean, gateError: Record<string, unknown> | null = null) {
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  return {
    rpcCalls,
    supabase: {
      rpc(name: string, args: Record<string, unknown>) {
        rpcCalls.push({ name, args });
        return Promise.resolve({ data: gateValue, error: gateError });
      },
    },
  };
}

Deno.test("post-OTP attendance resolver returns true for enabled delivery actor and uses exact actor ID", async () => {
  const deps = makeSupabase(true);
  const enabled = await resolvePostOtpAttendanceEnabled(deps.supabase as never, {
    actor_type: "delivery_staff",
    delivery_staff: { id: "22222222-2222-2222-2222-222222222222" },
    staff: { id: "11111111-1111-1111-1111-111111111111" },
  });

  assert.equal(enabled, true);
  assert.equal(deps.rpcCalls.length, 1);
  assert.equal(deps.rpcCalls[0].args.p_actor_type, "delivery_staff");
  assert.equal(deps.rpcCalls[0].args.p_actor_id, "22222222-2222-2222-2222-222222222222");
});

Deno.test("post-OTP attendance resolver returns false for disabled report actor and uses exact staff ID", async () => {
  const deps = makeSupabase(false);
  const enabled = await resolvePostOtpAttendanceEnabled(deps.supabase as never, {
    actor_type: "report_staff",
    staff: { id: "11111111-1111-1111-1111-111111111111" },
    delivery_staff: { id: "22222222-2222-2222-2222-222222222222" },
  });

  assert.equal(enabled, false);
  assert.equal(deps.rpcCalls.length, 1);
  assert.equal(deps.rpcCalls[0].args.p_actor_type, "report_staff");
  assert.equal(deps.rpcCalls[0].args.p_actor_id, "11111111-1111-1111-1111-111111111111");
});

Deno.test("post-OTP attendance resolver fails closed on missing actor ID and lookup error", async () => {
  const missing = makeSupabase(true);
  assert.equal(await resolvePostOtpAttendanceEnabled(missing.supabase as never, { actor_type: "delivery_staff", delivery_staff: null }), false);
  assert.equal(missing.rpcCalls.length, 0);

  const failing = makeSupabase(true, { code: "XX000", message: "unsafe detail omitted from response" });
  assert.equal(await resolvePostOtpAttendanceEnabled(failing.supabase as never, { actor_type: "report_staff", staff: { id: "11111111-1111-1111-1111-111111111111" } }), false);
  assert.equal(failing.rpcCalls.length, 1);
});

Deno.test("report-auth-verify immediate post-OTP response can receive attendance_enabled true without session reload", async () => {
  const deps = makeSupabase(true);
  const attendanceEnabled = await resolvePostOtpAttendanceEnabled(deps.supabase as never, {
    actor_type: "delivery_staff",
    delivery_staff: { id: "22222222-2222-2222-2222-222222222222" },
  });
  const responsePayload = {
    success: true,
    report_token: "krp_token",
    actor_type: "delivery_staff",
    delivery_staff: { full_name: "Delivery Staff" },
    staff: undefined,
    location: null,
    attendance_enabled: attendanceEnabled === true,
  };

  assert.equal(responsePayload.attendance_enabled, true);
  assert.equal(deps.rpcCalls[0].args.p_actor_id, "22222222-2222-2222-2222-222222222222");
});


Deno.test("public post-OTP payload strips internal actor IDs while preserving safe profile and location allowlist", () => {
  const reportPayload = publicVerifiedReportOtpPayload({
    actor_type: "report_staff",
    staff: { id: "11111111-1111-1111-1111-111111111111", full_name: "Report Staff", actor_type: "report_staff" },
    location: { id: "loc-id", code: "K01", name: "Kiosk 01", address: "Address", active: true },
  } as never);
  assert.deepEqual(reportPayload.staff, { full_name: "Report Staff", actor_type: "report_staff" });
  assert.deepEqual(reportPayload.location, { code: "K01", name: "Kiosk 01", address: "Address" });
  assert.equal(JSON.stringify(reportPayload).includes("11111111-1111-1111-1111-111111111111"), false);
  assert.equal(JSON.stringify(reportPayload).includes("loc-id"), false);

  const deliveryPayload = publicVerifiedReportOtpPayload({
    actor_type: "delivery_staff",
    delivery_staff: { id: "22222222-2222-2222-2222-222222222222", full_name: "Delivery Staff", actor_type: "delivery_staff" },
  } as never);
  assert.deepEqual(deliveryPayload.delivery_staff, { full_name: "Delivery Staff", actor_type: "delivery_staff" });
  assert.equal(deliveryPayload.location, null);
  assert.equal(JSON.stringify(deliveryPayload).includes("22222222-2222-2222-2222-222222222222"), false);
});
