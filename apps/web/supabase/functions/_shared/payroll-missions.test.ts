import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateMissionProgress,
  evaluateMissionReview,
  missionCutoff,
  missionEarnedAmounts,
  missionProgressWindow,
  missionTicketEligibility,
  respondToMissionOffer,
  validateMissionItems,
  vietnamDate,
  vietnamMinutesOfDay,
  type MissionAttendanceEvent,
  type MissionCampaignDefinition,
  type MissionCampaignItem,
} from "./payroll-missions.ts";

const ITEMS: MissionCampaignItem[] = [
  {
    key: "regular",
    label: "Chấm công đều",
    detail: "Đủ ngày, không thiếu giờ ra",
    kind: "attendance_regular",
    amount_vnd: 100_000,
    params: { min_days: 2 },
  },
  {
    key: "punctual",
    label: "Đúng giờ",
    detail: "Vào ca trước 07:00",
    kind: "punctual",
    amount_vnd: 50_000,
    params: { cutoff: "07:00", grace_minutes: 5 },
  },
  {
    key: "ticket",
    label: "Phiếu bốc thăm",
    detail: "Một phiếu quý",
    kind: "draw_ticket",
    amount_vnd: 0,
    params: {},
  },
];

const CAMPAIGN: MissionCampaignDefinition = {
  starts_on: "2026-11-01",
  ends_on: "2026-11-30",
  items: ITEMS,
  draw: { quarter: "2026-Q4", prize_vnd: 5_000_000, draw_after: "2027-01-05" },
};

function event(
  workDate: string,
  kind: "in" | "out",
  localTime: string,
): MissionAttendanceEvent {
  return {
    eventKind: kind,
    // 2026-11-03T07:05:00+07:00 is 2026-11-03T00:05:00Z.
    serverReceivedAt: `${workDate}T${localTime}:00+07:00`,
    workDate,
    decision: "accepted",
  };
}

test("validateMissionItems accepts data-driven items and rejects bad shapes", () => {
  assert.deepEqual(validateMissionItems(ITEMS), { ok: true, error: null });
  assert.equal(validateMissionItems(null).ok, false);
  assert.equal(validateMissionItems({}).ok, false);
  assert.match(validateMissionItems([{ ...ITEMS[0], key: "" }]).error!, /key_required/);
  assert.match(validateMissionItems([ITEMS[0], ITEMS[0]]).error!, /duplicate_key/);
  assert.match(validateMissionItems([{ ...ITEMS[0], kind: "bonus" }]).error!, /invalid_kind/);
  assert.match(validateMissionItems([{ ...ITEMS[0], amount_vnd: -1 }]).error!, /invalid_amount/);
  assert.match(validateMissionItems([{ ...ITEMS[0], params: [] }]).error!, /params_must_be_object/);
});

test("an offer can be accepted or declined exactly once", () => {
  const accepted = respondToMissionOffer(
    { status: "pending" },
    "accept",
    "2026-11-10T01:00:00.000Z",
  );
  assert.equal(accepted.ok, true);
  assert.equal(accepted.changed, true);
  assert.equal(accepted.status, "accepted");
  assert.equal(accepted.respondedAt, "2026-11-10T01:00:00.000Z");

  // Repeating the same request is idempotent and must not overwrite the time.
  const repeated = respondToMissionOffer(
    { status: "accepted", responded_at: accepted.respondedAt },
    "accept",
    "2026-11-11T01:00:00.000Z",
  );
  assert.equal(repeated.ok, true);
  assert.equal(repeated.changed, false);
  assert.equal(repeated.respondedAt, "2026-11-10T01:00:00.000Z");

  const flip = respondToMissionOffer(
    { status: "accepted", responded_at: accepted.respondedAt },
    "decline",
  );
  assert.equal(flip.ok, false);
  assert.equal(flip.error, "already_responded");
  assert.equal(flip.status, "accepted");

  const declined = respondToMissionOffer({ status: "pending" }, "decline");
  assert.equal(declined.ok, true);
  assert.equal(declined.status, "declined");

  const declineAgain = respondToMissionOffer(
    { status: "declined", responded_at: declined.respondedAt },
    "decline",
  );
  assert.equal(declineAgain.ok, true);
  assert.equal(declineAgain.changed, false);
});

test("attendance_regular is met only with enough days and no missing check-out", () => {
  const offer = { status: "accepted" as const, responded_at: "2026-11-03T01:00:00.000Z" };
  const complete = [
    event("2026-11-03", "in", "07:00"),
    event("2026-11-03", "out", "17:00"),
    event("2026-11-04", "in", "07:00"),
    event("2026-11-04", "out", "17:00"),
  ];
  const progress = evaluateMissionProgress(CAMPAIGN, offer, complete, "2026-11-30");
  const regular = progress.find((item) => item.key === "regular")!;

  assert.equal(regular.met, true);
  assert.equal(regular.detail.days_with_in, 2);
  assert.equal(regular.detail.days_complete, 2);
  assert.equal(regular.detail.days_missing_out, 0);

  const missingOut = complete.filter((item) => !(item.workDate === "2026-11-04" && item.eventKind === "out"));
  const missingProgress = evaluateMissionProgress(CAMPAIGN, offer, missingOut, "2026-11-30");
  const missingRegular = missingProgress.find((item) => item.key === "regular")!;
  assert.equal(missingRegular.met, false);
  assert.equal(missingRegular.detail.days_missing_out, 1);
});

test("punctual respects cutoff and grace, including an offer shift_start override", () => {
  const offer = { status: "accepted" as const, responded_at: "2026-11-03T01:00:00.000Z" };
  const onTime = [
    event("2026-11-03", "in", "07:05"),
    event("2026-11-03", "out", "17:00"),
    event("2026-11-04", "in", "06:55"),
    event("2026-11-04", "out", "17:00"),
  ];
  const progress = evaluateMissionProgress(CAMPAIGN, offer, onTime, "2026-11-30");
  const punctual = progress.find((item) => item.key === "punctual")!;
  assert.equal(punctual.met, true);
  assert.equal(punctual.detail.on_time_days, 2);
  assert.equal(punctual.detail.cutoff, "07:00");
  assert.equal(punctual.detail.grace_minutes, 5);

  // 07:06 is past 07:00 + 5 minutes, so the punctual item fails.
  const late = onTime.map((item) =>
    item.workDate === "2026-11-03" ? event("2026-11-03", "in", "07:06") : item
  );
  const lateProgress = evaluateMissionProgress(CAMPAIGN, offer, late, "2026-11-30");
  assert.equal(lateProgress.find((item) => item.key === "punctual")!.met, false);

  // A per-employee shift_start overrides the item cutoff.
  const override = missionCutoff(ITEMS[1], { status: "accepted", shift_start: "08:00:00" });
  assert.equal(override.cutoff, "08:00");
  const overrideProgress = evaluateMissionProgress(
    CAMPAIGN,
    { ...offer, shift_start: "08:00:00" },
    late,
    "2026-11-30",
  );
  assert.equal(overrideProgress.find((item) => item.key === "punctual")!.met, true);
});

test("punctual uses the employee shift between the offer override and item cutoff", () => {
  const offer = { status: "accepted" as const, responded_at: "2026-11-03T01:00:00.000Z" };
  const events = [
    event("2026-11-04", "in", "07:45"),
    event("2026-11-04", "out", "17:00"),
  ];

  const withoutShift = evaluateMissionProgress(CAMPAIGN, offer, events, "2026-11-30");
  const withoutShiftPunctual = withoutShift.find((item) => item.key === "punctual")!;
  assert.equal(withoutShiftPunctual.detail.cutoff, "07:00");
  assert.equal(withoutShiftPunctual.met, false);

  // The manual employee shift start 08:00 makes 07:45 on time.
  const withShift = evaluateMissionProgress(CAMPAIGN, offer, events, "2026-11-30", "08:00");
  const withShiftPunctual = withShift.find((item) => item.key === "punctual")!;
  assert.equal(withShiftPunctual.detail.cutoff, "08:00");
  assert.equal(withShiftPunctual.met, true);

  // offer.shift_start still wins over the employee shift start.
  const withOffer = evaluateMissionProgress(
    CAMPAIGN,
    { ...offer, shift_start: "07:30:00" },
    events,
    "2026-11-30",
    "08:00",
  );
  const withOfferPunctual = withOffer.find((item) => item.key === "punctual")!;
  assert.equal(withOfferPunctual.detail.cutoff, "07:30");
  assert.equal(withOfferPunctual.met, false);
  assert.equal(missionCutoff(ITEMS[1], offer, "08:00").cutoff, "08:00");
});

test("progress window starts at the accepted date and ignores earlier events", () => {
  const offer = { status: "accepted" as const, responded_at: "2026-11-10T01:00:00.000Z" };
  const events = [
    event("2026-11-05", "in", "07:00"),
    event("2026-11-05", "out", "17:00"),
    event("2026-11-10", "in", "07:00"),
    event("2026-11-10", "out", "17:00"),
  ];
  const window = missionProgressWindow(CAMPAIGN, offer, "2026-11-30");
  assert.equal(window.from, "2026-11-10");
  assert.equal(window.to, "2026-11-30");

  const progress = evaluateMissionProgress(CAMPAIGN, offer, events, "2026-11-30");
  const regular = progress.find((item) => item.key === "regular")!;
  assert.equal(regular.detail.days_with_in, 1);
  assert.equal(regular.met, false);
  assert.equal(regular.detail.window_from, "2026-11-10");
});

test("review amounts are taken from campaign items, never from caller input", () => {
  const result = evaluateMissionReview({
    items: ITEMS,
    earnedKeys: ["regular", "punctual"],
    disqualified: false,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.earned, [
    { key: "punctual", amount_vnd: 50_000 },
    { key: "regular", amount_vnd: 100_000 },
  ]);
  assert.deepEqual(result.ticket, { issue: true, voidReason: null });

  const unknown = evaluateMissionReview({
    items: ITEMS,
    earnedKeys: ["regular", "not-an-item"],
    disqualified: false,
  });
  assert.equal(unknown.ok, false);
  assert.match(unknown.error!, /unknown_item/);

  const onlyKeys = missionEarnedAmounts(ITEMS, ["ticket", "ticket"]);
  assert.deepEqual(onlyKeys.earned, [{ key: "ticket", amount_vnd: 0 }]);
  assert.deepEqual(onlyKeys.unknownKeys, []);
});

test("disqualified review gives zero and no ticket", () => {
  const result = evaluateMissionReview({
    items: ITEMS,
    earnedKeys: ["regular", "punctual"],
    disqualified: true,
  });
  assert.deepEqual(result.earned, []);
  assert.deepEqual(result.ticket, { issue: false, voidReason: "disqualified" });
  assert.deepEqual(missionTicketEligibility(ITEMS, []), {
    issue: false,
    voidReason: "no_earned_items",
  });
});

test("a ticket is issued only with at least one earned item and a draw_ticket item", () => {
  const withoutDrawItem = ITEMS.filter((item) => item.kind !== "draw_ticket");
  assert.deepEqual(
    missionTicketEligibility(withoutDrawItem, [{ key: "regular", amount_vnd: 100_000 }]),
    { issue: false, voidReason: "no_draw_item" },
  );
  assert.deepEqual(
    missionTicketEligibility(ITEMS, [{ key: "regular", amount_vnd: 100_000 }]),
    { issue: true, voidReason: null },
  );
  assert.deepEqual(
    missionTicketEligibility(ITEMS, [{ key: "regular", amount_vnd: 100_000 }], true),
    { issue: true, voidReason: "employee_left_before_draw" },
  );
});

test("Vietnam-local date/time helpers do not depend on the host timezone", () => {
  assert.equal(vietnamDate("2026-11-09T18:00:00.000Z"), "2026-11-10");
  assert.equal(vietnamMinutesOfDay("2026-11-09T18:00:00.000Z"), 60);
});
