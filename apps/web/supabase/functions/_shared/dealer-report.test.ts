import {
  assert,
  assertAlmostEquals,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildDealerReport,
  type DealerReportRow,
} from "./dealer-report.ts";

const row = (
  overrides: Partial<DealerReportRow> & Pick<DealerReportRow, "order_number">,
): DealerReportRow => ({
  status: "submitted",
  requested_delivery_date: "2026-11-02",
  submitted_at: "2026-11-01T00:00:00Z",
  route_customer_name: null,
  quantity: 0,
  exchange_quantity: 0,
  makeup_quantity: 0,
  line_total_vnd: 0,
  ...overrides,
});

const retailRows: DealerReportRow[] = [
  row({
    order_number: "DH-100",
    requested_delivery_date: "2026-11-02",
    route_customer_name: "Điểm A",
    quantity: 10,
    exchange_quantity: 1,
    makeup_quantity: 2,
    line_total_vnd: 100000,
  }),
  row({
    order_number: "DH-100",
    requested_delivery_date: "2026-11-02",
    route_customer_name: "Điểm A",
    quantity: 5,
    makeup_quantity: 1,
    line_total_vnd: 50000,
  }),
  row({
    order_number: "DH-095",
    requested_delivery_date: "2026-11-05",
    route_customer_name: "Điểm B",
    quantity: 7,
    line_total_vnd: 70000,
  }),
  // Missing requested date: 18:00Z on 2026-11-01 is 2026-11-02 in Vietnam.
  row({
    order_number: "DH-200",
    requested_delivery_date: null,
    submitted_at: "2026-11-01T18:00:00Z",
    route_customer_name: "",
    quantity: 3,
    line_total_vnd: 30000,
  }),
  // Cancelled lines never count, even with a large quantity.
  row({
    order_number: "DH-101",
    status: "cancelled",
    requested_delivery_date: "2026-11-06",
    quantity: 100,
    line_total_vnd: 1000000,
  }),
  row({
    order_number: "DH-090",
    requested_delivery_date: "2026-10-03",
    route_customer_name: "Điểm A",
    quantity: 20,
    line_total_vnd: 200000,
  }),
  row({
    order_number: "DH-089",
    requested_delivery_date: "2026-10-20",
    route_customer_name: "Điểm B",
    quantity: 30,
    line_total_vnd: 300000,
  }),
];

Deno.test("retail report uses same-period comparison, skips cancelled lines and separates exchanges", () => {
  const report = buildDealerReport({
    rows: retailRows,
    isNpp: false,
    month: "2026-11",
    today: "2026-11-10",
  });

  assertEquals(report.period, {
    month: "2026-11",
    start_date: "2026-11-01",
    end_date: "2026-11-10",
    days_elapsed: 10,
  });

  assertEquals(report.summary, {
    order_count: 3,
    quantity: 25,
    amount_vnd: 250000,
    exchange_quantity: 1,
    makeup_quantity: 3,
    delivery_days: 2,
    avg_per_day: 2.5,
  });

  assertEquals(report.comparison.prev_same_period_quantity, 20);
  assert(report.comparison.same_period_change_pct !== null);
  assertAlmostEquals(report.comparison.same_period_change_pct, 0.25);
  assertAlmostEquals(report.comparison.prev_avg_per_day, 50 / 31);
  assert(report.comparison.avg_change_pct !== null);
  assertAlmostEquals(report.comparison.avg_change_pct, 0.55);

  assertEquals(report.daily.length, 10);
  assertEquals(report.daily[0], { date: "2026-11-01", quantity: 0 });
  assertEquals(report.daily[1], { date: "2026-11-02", quantity: 18 });
  assertEquals(report.daily[2], { date: "2026-11-03", quantity: 0 });
  assertEquals(report.daily[4], { date: "2026-11-05", quantity: 7 });

  assertEquals(report.weekday, [18, 30, 0, 7, 0, 20, 0]);

  assertEquals(report.recent_orders, [
    {
      order_number: "DH-095",
      delivery_date: "2026-11-05",
      quantity: 7,
      extra_quantity: 0,
      amount_vnd: 70000,
    },
    {
      order_number: "DH-200",
      delivery_date: "2026-11-02",
      quantity: 3,
      extra_quantity: 0,
      amount_vnd: 30000,
    },
    {
      order_number: "DH-100",
      delivery_date: "2026-11-02",
      quantity: 15,
      extra_quantity: 4,
      amount_vnd: 150000,
    },
  ]);

  assertEquals(report.months[0], {
    month: "2026-09",
    order_count: 0,
    quantity: 0,
    avg_per_day: 0,
    amount_vnd: 0,
  });
  assertEquals(report.months[1].month, "2026-10");
  assertEquals(report.months[1].order_count, 2);
  assertEquals(report.months[1].quantity, 50);
  assertAlmostEquals(report.months[1].avg_per_day, 50 / 31);
  assertEquals(report.months[1].amount_vnd, 500000);
  assertEquals(report.months[2], {
    month: "2026-11",
    order_count: 3,
    quantity: 25,
    avg_per_day: 2.5,
    amount_vnd: 250000,
  });

  assertEquals(report.points, null);
});

Deno.test("distributor points group by route, sort by quantity and use previous month average", () => {
  const report = buildDealerReport({
    rows: [
      row({
        order_number: "N-1",
        requested_delivery_date: "2026-11-02",
        route_customer_name: "Điểm A",
        quantity: 10,
        line_total_vnd: 100000,
      }),
      row({
        order_number: "N-2",
        requested_delivery_date: "2026-11-03",
        route_customer_name: "Điểm B",
        quantity: 30,
        line_total_vnd: 300000,
      }),
      row({
        order_number: "N-3",
        requested_delivery_date: "2026-11-04",
        route_customer_name: null,
        quantity: 5,
        line_total_vnd: 50000,
      }),
      row({
        order_number: "P-1",
        requested_delivery_date: "2026-10-05",
        route_customer_name: "Điểm A",
        quantity: 20,
        line_total_vnd: 200000,
      }),
      row({
        order_number: "P-2",
        requested_delivery_date: "2026-10-06",
        route_customer_name: "Điểm B",
        quantity: 10,
        line_total_vnd: 100000,
      }),
      // Route only present last month is not part of this month's points.
      row({
        order_number: "P-3",
        requested_delivery_date: "2026-10-07",
        route_customer_name: "Điểm C",
        quantity: 100,
        line_total_vnd: 1000000,
      }),
    ],
    isNpp: true,
    month: "2026-11",
    today: "2026-11-10",
  });

  const points = report.points;
  assert(points !== null);
  assertEquals(points.map((point) => point.name), ["Điểm B", "Điểm A", "(không ghi)"]);

  assertEquals(points[0].quantity, 30);
  assertEquals(points[0].avg_per_day, 3);
  assertAlmostEquals(points[0].prev_avg_per_day, 10 / 31);
  assert(points[0].change_pct !== null);
  assertAlmostEquals(points[0].change_pct, 8.3);

  assertEquals(points[1].quantity, 10);
  assertEquals(points[1].avg_per_day, 1);
  assertAlmostEquals(points[1].prev_avg_per_day, 20 / 31);
  assert(points[1].change_pct !== null);
  assertAlmostEquals(points[1].change_pct, 0.55);

  assertEquals(points[2].quantity, 5);
  assertEquals(points[2].avg_per_day, 0.5);
  assertEquals(points[2].prev_avg_per_day, 0);
  assertEquals(points[2].change_pct, null);
});

Deno.test("recent orders sort latest delivery date first and then order_number descending", () => {
  const report = buildDealerReport({
    rows: [
      row({ order_number: "DH-140", requested_delivery_date: "2026-11-09", quantity: 14 }),
      row({ order_number: "DH-150", requested_delivery_date: "2026-11-09", quantity: 15 }),
      row({ order_number: "DH-160", requested_delivery_date: "2026-11-08", quantity: 16 }),
    ],
    isNpp: false,
    month: "2026-11",
    today: "2026-11-10",
  });

  assertEquals(report.recent_orders.map((order) => order.order_number), [
    "DH-150",
    "DH-140",
    "DH-160",
  ]);
});

Deno.test("past months use their full day count and zero previous quantity yields null percentages", () => {
  const report = buildDealerReport({
    rows: [
      row({
        order_number: "DH-300",
        requested_delivery_date: "2026-09-15",
        quantity: 30,
        line_total_vnd: 300000,
      }),
    ],
    isNpp: false,
    month: "2026-09",
    today: "2026-11-10",
  });

  assertEquals(report.period, {
    month: "2026-09",
    start_date: "2026-09-01",
    end_date: "2026-09-30",
    days_elapsed: 30,
  });
  assertEquals(report.summary.order_count, 1);
  assertEquals(report.summary.quantity, 30);
  assertEquals(report.summary.avg_per_day, 1);
  assertEquals(report.daily.length, 30);
  assertEquals(report.daily[14], { date: "2026-09-15", quantity: 30 });
  assertEquals(report.daily[15], { date: "2026-09-16", quantity: 0 });

  assertEquals(report.comparison.prev_same_period_quantity, 0);
  assertEquals(report.comparison.same_period_change_pct, null);
  assertEquals(report.comparison.prev_avg_per_day, 0);
  assertEquals(report.comparison.avg_change_pct, null);

  assertEquals(report.months.map((month) => month.month), [
    "2026-07",
    "2026-08",
    "2026-09",
  ]);
  assertEquals(report.months[1].avg_per_day, 0);
  assertEquals(report.months[2].avg_per_day, 1);
  assertEquals(report.points, null);
});
