import assert from "node:assert/strict";
import test from "node:test";

import {
  channelGroup,
  countProductionByStatus,
  countSubmittedLocations,
  metric,
  previousPeriod,
  summarizeRevenueByChannel,
  vietnamDayKey,
} from "./overview-summary.ts";

test("vietnamDayKey dùng múi giờ Việt Nam (UTC+7)", () => {
  assert.equal(vietnamDayKey("2026-10-01T17:30:00Z"), "2026-10-02");
  assert.equal(vietnamDayKey("2026-10-01T16:30:00Z"), "2026-10-01");
});

test("previousPeriod lùi đúng một tháng, vắt qua năm", () => {
  assert.equal(previousPeriod("2026-01"), "2025-12");
  assert.equal(previousPeriod("2026-10"), "2026-09");
});

test("channelGroup phân nhóm dealer/b2b/retail và kênh lạ", () => {
  // dealer
  assert.equal(channelGroup("Franchise"), "dealer");
  assert.equal(channelGroup("ĐẠI LÝ"), "dealer");
  assert.equal(channelGroup("Bread business wholesale channel"), "dealer");
  assert.equal(channelGroup("NPP"), "dealer");
  // b2b
  assert.equal(channelGroup("B2B BMQ"), "b2b");
  assert.equal(channelGroup("b2b siêu thị"), "b2b");
  // retail
  assert.equal(channelGroup("Retail kiosk"), "retail");
  assert.equal(channelGroup("Bán lẻ kiosk"), "retail");
  assert.equal(channelGroup("Retail Kiosk"), "retail");
  // bakery (kênh thật "BÁNH NGỌT" trong revenue_ledger_lines)
  assert.equal(channelGroup("BÁNH NGỌT"), "bakery");
  assert.equal(channelGroup("Bakery business"), "bakery");
  // lạ / rỗng
  assert.equal(channelGroup("Kênh không xác định"), "other");
  assert.equal(channelGroup(null), "other");
  assert.equal(channelGroup(""), "other");
  // bỏ dấu + không phân biệt hoa thường
  assert.equal(channelGroup("franchise"), "dealer");
  assert.equal(channelGroup("đại lý"), "dealer");
});

test("summarizeRevenueByChannel đủ 14 ngày kể cả ngày 0, vắt qua tháng", () => {
  const summary = summarizeRevenueByChannel(
    [
      { revenue_date: "2026-02-20", channel: "Franchise", gross_revenue: 100 },
      { revenue_date: "2026-02-20", channel: "B2B BMQ", gross_revenue: 50 },
      { revenue_date: "2026-02-21", channel: "NPP", gross_revenue: null },
      { revenue_date: "2026-03-05", channel: "Retail kiosk", gross_revenue: 30 },
      { revenue_date: "2026-03-05", channel: null, gross_revenue: null },
      { revenue_date: "2026-01-01", channel: "Franchise", gross_revenue: 999 },
    ],
    "2026-03-05",
  );

  assert.equal(summary.days.length, 14);
  assert.equal(summary.days[0].day, "2026-02-20");
  assert.equal(summary.days.at(-1)?.day, "2026-03-05");

  const firstDay = summary.days[0];
  assert.equal(firstDay.total, 150);
  assert.equal(firstDay.byGroup.dealer, 100);
  assert.equal(firstDay.byGroup.b2b, 50);

  const nullGrossDay = summary.days.find((d) => d.day === "2026-02-21");
  assert.equal(nullGrossDay?.total, 0);
  assert.equal(nullGrossDay?.byGroup.dealer, 0);

  const lastDay = summary.days.at(-1);
  assert.equal(lastDay?.total, 30);
  assert.equal(lastDay?.byGroup.retail, 30);

  assert.deepEqual(summary.totals, {
    dealer: 100,
    b2b: 50,
    retail: 30,
    bakery: 0,
    other: 0,
  });
  assert.equal(summary.total, 180);
});

test("summarizeRevenueByChannel tôn trọng tham số days", () => {
  const summary = summarizeRevenueByChannel([], "2026-03-05", 3);
  assert.equal(summary.days.length, 3);
  assert.deepEqual(
    summary.days.map((d) => d.day),
    ["2026-03-03", "2026-03-04", "2026-03-05"],
  );
  assert.equal(summary.total, 0);
});

test("countSubmittedLocations đếm điểm khác nhau, bỏ submitted_at null", () => {
  assert.equal(
    countSubmittedLocations([
      { location_id: "A", submitted_at: "2026-10-01T00:00:00Z" },
      { location_id: "A", submitted_at: "2026-10-01T01:00:00Z" },
      { location_id: "B", submitted_at: null },
      { location_id: "B", submitted_at: "2026-10-01T02:00:00Z" },
      { location_id: null, submitted_at: "2026-10-01T03:00:00Z" },
    ]),
    2,
  );
});

test("countProductionByStatus đếm tổng và theo trạng thái", () => {
  assert.deepEqual(
    countProductionByStatus([
      { status: "planned" },
      { status: "planned" },
      { status: "done" },
    ]),
    { total: 3, byStatus: { planned: 2, done: 1 } },
  );
});

test("metric: error/unavailable/null/isEmpty/ok và không bao giờ ok với null", () => {
  const errorResult = metric<number>({ href: "/x", error: new Error("boom") });
  assert.equal(errorResult.status, "error");
  assert.equal(errorResult.value, null);

  const unavailableResult = metric<number>({
    href: "/x",
    unavailable: "no_permission",
  });
  assert.equal(unavailableResult.status, "unavailable");
  assert.equal(unavailableResult.value, null);
  assert.equal(unavailableResult.note, "no_permission");

  const nullResult = metric<number>({ href: "/x", value: null });
  assert.equal(nullResult.status, "unavailable");
  assert.equal(nullResult.value, null);

  const emptyResult = metric<number>({ href: "/x", value: 0, isEmpty: true });
  assert.equal(emptyResult.status, "empty");
  assert.equal(emptyResult.value, 0);

  const okResult = metric<number>({ href: "/x", value: 0 });
  assert.equal(okResult.status, "ok");
  assert.equal(okResult.value, 0);

  // error thắng value
  assert.equal(
    metric<number>({ href: "/x", error: "fail", value: 5 }).status,
    "error",
  );
  // isEmpty không được biến null thành empty/ok
  assert.equal(
    metric<number>({ href: "/x", value: null, isEmpty: true }).status,
    "unavailable",
  );
  // Thiếu value -> không bao giờ ok
  assert.notEqual(metric<number>({ href: "/x" }).status, "ok");
});

test("summarizeRevenueByChannel tính từ đầu tháng tới hôm nay, bỏ ngày tháng trước", () => {
  const today = "2026-10-10";
  const summary = summarizeRevenueByChannel(
    [
      { revenue_date: "2026-09-30", channel: "BÁNH NGỌT", gross_revenue: 9_000_000 },
      { revenue_date: "2026-10-01", channel: "ĐẠI LÝ", gross_revenue: 1_000_000 },
      { revenue_date: "2026-10-08", channel: "BÁNH NGỌT", gross_revenue: 15_043_277 },
      { revenue_date: "2026-10-10", channel: "Retail Kiosk", gross_revenue: 500_000 },
      { revenue_date: "2026-10-11", channel: "ĐẠI LÝ", gross_revenue: 7_000_000 },
    ],
    today,
    Number(today.slice(8, 10)),
  );
  assert.equal(summary.days.length, 10);
  assert.equal(summary.days[0].day, "2026-10-01");
  assert.equal(summary.days[9].day, "2026-10-10");
  assert.equal(summary.total, 16_543_277);
  assert.equal(summary.totals.bakery, 15_043_277);
});
