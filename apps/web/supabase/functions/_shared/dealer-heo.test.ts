import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  computeHeoSummary,
  heoSpinShortfall,
  type HeoSpinInput,
  previewOrderExtra,
} from "./dealer-heo.ts";

const spin = (overrides: Partial<HeoSpinInput> = {}): HeoSpinInput => ({
  amount_vnd: 0,
  bread_qty: 0,
  prize_kind: "none",
  is_jackpot: false,
  created_at: "2026-12-02T03:00:00.000Z",
  order_id: "00000000-0000-0000-0000-000000000001",
  ...overrides,
});

Deno.test("a day below the November baseline never produces a negative amount", () => {
  const summary = computeHeoSummary({
    baselineAvgPerDay: 5,
    dailyQuantities: [
      { date: "2026-12-01", quantity: 2 },
      { date: "2026-12-02", quantity: 4 },
    ],
    spins: [],
    ratePerExtraQue: 500,
    windowStart: "2026-12-01",
    windowEnd: "2026-12-31",
    breakOn: "2027-01-15",
    today: "2026-12-20",
  });

  assertEquals(summary.extra_que, 0);
  assertEquals(summary.from_extra_vnd, 0);
  assertEquals(summary.total_vnd, 0);
});

Deno.test("multiple orders on the same day are summed before subtracting the baseline", () => {
  const summary = computeHeoSummary({
    baselineAvgPerDay: 4,
    dailyQuantities: [
      { date: "2026-12-02", quantity: 2 },
      { date: "2026-12-02", quantity: "3" },
    ],
    spins: [],
    ratePerExtraQue: 500,
    windowStart: "2026-12-01",
    windowEnd: "2026-12-31",
    breakOn: "2027-01-15",
    today: "2026-12-02",
  });

  assertEquals(summary.extra_que, 1);
  assertEquals(summary.from_extra_vnd, 500);
});

Deno.test("only days inside the campaign window count", () => {
  const summary = computeHeoSummary({
    baselineAvgPerDay: 2,
    dailyQuantities: [
      { date: "2026-11-30", quantity: 100 },
      { date: "2026-12-01", quantity: 5 },
      { date: "2026-12-02", quantity: 4 },
      { date: "2027-01-01", quantity: 100 },
    ],
    spins: [],
    ratePerExtraQue: 500,
    windowStart: "2026-12-01",
    windowEnd: "2026-12-31",
    breakOn: "2027-01-15",
    today: "2026-12-02",
  });

  assertEquals(summary.extra_que, 5);
  assertEquals(summary.from_extra_vnd, 2500);
});

Deno.test("baseline zero makes every que extra and requires at least one que to spin", () => {
  const summary = computeHeoSummary({
    baselineAvgPerDay: 0,
    dailyQuantities: [{ date: "2026-12-01", quantity: 2 }],
    spins: [],
    ratePerExtraQue: 500,
    windowStart: "2026-12-01",
    windowEnd: "2026-12-31",
    breakOn: "2027-01-15",
    today: "2026-12-01",
  });

  assertEquals(summary.extra_que, 2);
  assertEquals(summary.from_extra_vnd, 1000);
  assertEquals(previewOrderExtra({
    baselineAvgPerDay: 0,
    existingDayQuantity: 0,
    orderQuantity: 0,
    ratePerExtraQue: 500,
  }).spin_eligible, false);
});

Deno.test("summary adds spin money and bread, keeps the 5 latest spins and clamps days to break", () => {
  const spins: HeoSpinInput[] = [
    spin({
      amount_vnd: 5000,
      bread_qty: 0,
      prize_kind: "coin",
      created_at: "2026-12-01T03:00:00.000Z",
      order_id: "00000000-0000-0000-0000-000000000001",
    }),
    spin({
      amount_vnd: 10000,
      bread_qty: 0,
      prize_kind: "coin",
      created_at: "2026-12-02T03:00:00.000Z",
      order_id: "00000000-0000-0000-0000-000000000002",
    }),
    spin({
      amount_vnd: 0,
      bread_qty: 10,
      prize_kind: "bread",
      created_at: "2026-12-03T03:00:00.000Z",
      order_id: "00000000-0000-0000-0000-000000000003",
    }),
    spin({
      amount_vnd: 500000,
      prize_kind: "coin",
      is_jackpot: true,
      created_at: "2026-12-04T03:00:00.000Z",
      order_id: "00000000-0000-0000-0000-000000000004",
    }),
    spin({
      amount_vnd: 0,
      prize_kind: "none",
      created_at: "2026-12-05T03:00:00.000Z",
      order_id: "00000000-0000-0000-0000-000000000005",
    }),
    spin({
      amount_vnd: 20000,
      prize_kind: "coin",
      created_at: "2026-12-06T03:00:00.000Z",
      order_id: "00000000-0000-0000-0000-000000000006",
    }),
  ];

  const summary = computeHeoSummary({
    baselineAvgPerDay: 5,
    dailyQuantities: [
      { date: "2026-12-01", quantity: 3 },
      { date: "2026-12-02", quantity: 8 },
      { date: "2026-12-03", quantity: 5 },
      { date: "2026-12-04", quantity: 12 },
    ],
    spins,
    ratePerExtraQue: 500,
    windowStart: "2026-12-01",
    windowEnd: "2026-12-31",
    breakOn: "2027-01-15",
    today: "2026-12-20",
  });

  assertEquals(summary.extra_que, 10);
  assertEquals(summary.from_extra_vnd, 5000);
  assertEquals(summary.from_spins_vnd, 535000);
  assertEquals(summary.bread_qty, 10);
  assertEquals(summary.total_vnd, 540000);
  assertEquals(summary.spin_count, 6);
  assertEquals(summary.days_to_break, 26);
  assertEquals(summary.recent_spins.map((item) => item.order_id), [
    "00000000-0000-0000-0000-000000000006",
    "00000000-0000-0000-0000-000000000005",
    "00000000-0000-0000-0000-000000000004",
    "00000000-0000-0000-0000-000000000003",
    "00000000-0000-0000-0000-000000000002",
  ]);
  assertEquals(summary.recent_spins[1], {
    amount_vnd: 0,
    bread_qty: 0,
    prize_kind: "none",
    is_jackpot: false,
    created_at: "2026-12-05T03:00:00.000Z",
    order_id: "00000000-0000-0000-0000-000000000005",
  });

  assertEquals(computeHeoSummary({
    baselineAvgPerDay: 0,
    dailyQuantities: [],
    spins: [],
    ratePerExtraQue: 500,
    windowStart: "2026-12-01",
    windowEnd: "2026-12-31",
    breakOn: "2027-01-15",
    today: "2027-01-20",
  }).days_to_break, 0);
  assertEquals(computeHeoSummary({
    baselineAvgPerDay: 0,
    dailyQuantities: [],
    spins: [],
    ratePerExtraQue: 500,
    windowStart: "2026-12-01",
    windowEnd: "2026-12-31",
    breakOn: "2027-01-15",
    today: "2027-01-15",
  }).days_to_break, 0);
});

Deno.test("previewOrderExtra only prices the newly crossed part and checks the order threshold", () => {
  assertEquals(previewOrderExtra({
    baselineAvgPerDay: 4,
    existingDayQuantity: 3,
    orderQuantity: 2,
    ratePerExtraQue: 500,
  }), { extra_que: 1, extra_vnd: 500, spin_eligible: false });

  assertEquals(previewOrderExtra({
    baselineAvgPerDay: 4,
    existingDayQuantity: 6,
    orderQuantity: 3,
    ratePerExtraQue: 500,
  }), { extra_que: 3, extra_vnd: 1500, spin_eligible: false });

  assertEquals(previewOrderExtra({
    baselineAvgPerDay: 0,
    existingDayQuantity: 5,
    orderQuantity: 1,
    ratePerExtraQue: 500,
  }), { extra_que: 1, extra_vnd: 500, spin_eligible: true });

  assertEquals(previewOrderExtra({
    baselineAvgPerDay: 0,
    existingDayQuantity: 0,
    orderQuantity: 0,
    ratePerExtraQue: 500,
  }), { extra_que: 0, extra_vnd: 0, spin_eligible: false });

  assert(previewOrderExtra({
    baselineAvgPerDay: 2,
    existingDayQuantity: 0,
    orderQuantity: 2,
    ratePerExtraQue: 500,
  }).spin_eligible);
});

Deno.test("joinedOn only counts deliveries from the join date onward", () => {
  const summary = computeHeoSummary({
    baselineAvgPerDay: 2,
    dailyQuantities: [
      { date: "2026-12-09", quantity: 10 },
      { date: "2026-12-10", quantity: 5 },
      { date: "2026-12-11", quantity: 4 },
    ],
    spins: [],
    ratePerExtraQue: 500,
    windowStart: "2026-12-01",
    windowEnd: "2026-12-31",
    breakOn: "2027-01-15",
    today: "2026-12-20",
    joinedOn: "2026-12-10",
  });

  // 9/12 is before the join date and must not earn; 10/12 itself does.
  assertEquals(summary.extra_que, 5);
  assertEquals(summary.from_extra_vnd, 2500);
});

Deno.test("joinedOn after windowEnd earns no extra que", () => {
  const summary = computeHeoSummary({
    baselineAvgPerDay: 2,
    dailyQuantities: [{ date: "2026-12-20", quantity: 10 }],
    spins: [],
    ratePerExtraQue: 500,
    windowStart: "2026-12-01",
    windowEnd: "2026-12-31",
    breakOn: "2027-01-15",
    today: "2026-12-20",
    joinedOn: "2027-01-01",
  });

  assertEquals(summary.extra_que, 0);
  assertEquals(summary.from_extra_vnd, 0);
});

Deno.test("joinedOn null keeps the legacy calculation", () => {
  const input = {
    baselineAvgPerDay: 2,
    dailyQuantities: [
      { date: "2026-12-02", quantity: 5 },
      { date: "2026-12-03", quantity: 4 },
    ],
    spins: [],
    ratePerExtraQue: 500,
    windowStart: "2026-12-01",
    windowEnd: "2026-12-31",
    breakOn: "2027-01-15",
    today: "2026-12-20",
  };

  assertEquals(computeHeoSummary({ ...input, joinedOn: null }), computeHeoSummary(input));
});

Deno.test("heoSpinShortfall rounds the baseline up and reports missing que", () => {
  assertEquals(heoSpinShortfall({ baselineAvgPerDay: 123.4, orderQuantity: 0 }), {
    required_quantity: 124,
    missing_quantity: 124,
  });
  assertEquals(heoSpinShortfall({ baselineAvgPerDay: 0, orderQuantity: 0 }), {
    required_quantity: 1,
    missing_quantity: 1,
  });
  assertEquals(heoSpinShortfall({ baselineAvgPerDay: 123.4, orderQuantity: 130 }), {
    required_quantity: 124,
    missing_quantity: 0,
  });
});
