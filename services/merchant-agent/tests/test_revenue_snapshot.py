from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Any

import pytest

from bmq_merchant.revenue_snapshot import (
    CAVEAT,
    CHANNEL_GROUP_LABELS,
    build_revenue_snapshot,
    channel_group,
    evaluate_flags,
    is_snapshot_command,
    render_snapshot_text,
    snapshot_periods,
)
from bmq_merchant.snapshot_tools import build_snapshot_tools

TODAY = date(2026, 10, 19)


class FakeDb:
    def __init__(
        self,
        fixtures: dict[str, Any] | None = None,
        errors: dict[str, Exception] | None = None,
    ) -> None:
        self.fixtures = fixtures or {}
        self.errors = errors or {}
        self.calls: list[tuple[str, dict[str, str]]] = []

    async def select(
        self, table: str, params: dict[str, str] | None = None
    ) -> list[dict[str, Any]]:
        self.calls.append((table, dict(params or {})))
        if table in self.errors:
            raise self.errors[table]
        value = self.fixtures.get(table, [])
        if callable(value):
            value = value(table, params)
        return list(value)

    def params_for(self, table: str) -> list[dict[str, str]]:
        return [params for called, params in self.calls if called == table]


def _revenue_rows() -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = [
        {
            "id": "r1",
            "revenue_date": "2026-10-05",
            "channel": "Franchise",
            "gross_revenue": 10_000_000,
        },
        {
            "id": "r2",
            "revenue_date": "2026-09-10",
            "channel": "Franchise",
            "gross_revenue": 20_000_000,
        },
        {
            "id": "r3",
            "revenue_date": "2026-10-06",
            "channel": "B2B BMQ",
            "gross_revenue": 10_000_000,
        },
        {
            "id": "r4",
            "revenue_date": "2026-09-11",
            "channel": "B2B BMQ",
            "gross_revenue": 5_000_000,
        },
    ]
    # Ten previous-month days without any current-month revenue: silent channel.
    for day in range(1, 11):
        rows.append(
            {
                "id": f"r-bakery-{day}",
                "revenue_date": f"2026-09-{day:02d}",
                "channel": "BÁNH NGỌT",
                "gross_revenue": 1_000_000,
            }
        )
    return rows


def _kiosk_locations() -> list[dict[str, Any]]:
    locations = [
        {
            "id": f"L{index}",
            "location_code": f"L{index}",
            "location_name": name,
            "active": True,
        }
        for index, name in enumerate(
            ["Quận 1", "Quận 3", "Bình Thạnh", "Phú Nhuận", "Thủ Đức"], start=1
        )
    ]
    # An active test row exists in live data; it must never count as a real point.
    locations.append(
        {
            "id": "L-test",
            "location_code": "TEST-KIOSK",
            "location_name": "Điểm bán TEST",
            "active": True,
        }
    )
    return locations


def _kiosk_reports() -> list[dict[str, Any]]:
    reports: list[dict[str, Any]] = [
        {
            "id": "k1",
            "location_id": "L1",
            "report_date": "2026-09-10",
            "status": "submitted",
            "channel_rows": [
                {
                    "channel_code": "grabfood",
                    "channel_name_snapshot": "GrabFood",
                    "amount_vnd": 3_000_000,
                }
            ],
        },
        {
            "id": "k2",
            "location_id": "L1",
            "report_date": "2026-10-10",
            "status": "submitted",
            "channel_rows": [
                {
                    "channel_code": "grabfood",
                    "channel_name_snapshot": "GrabFood",
                    "amount_vnd": 1_000_000,
                }
            ],
        },
        {
            "id": "k3",
            "location_id": "L1",
            "report_date": "2026-10-18",
            "status": "submitted",
            "channel_rows": [
                {
                    "channel_code": "khach_le",
                    "channel_name_snapshot": "Khách lẻ",
                    "amount_vnd": 500_000,
                }
            ],
        },
        {
            "id": "k4",
            "location_id": "L1",
            "report_date": "2026-10-19",
            "status": "submitted",
            "channel_rows": [
                {
                    "channel_code": "khach_le",
                    "channel_name_snapshot": "Khách lẻ",
                    "amount_vnd": 200_000,
                }
            ],
        },
    ]
    for index in range(2, 5):
        reports.append(
            {
                "id": f"k-yesterday-{index}",
                "location_id": f"L{index}",
                "report_date": "2026-10-18",
                "status": "submitted",
                "channel_rows": [],
            }
        )
    return reports


def _dealer_orders() -> list[dict[str, Any]]:
    return [
        {
            "id": f"d{day}",
            "order_number": f"SO-{day}",
            "status": "confirmed",
            "submitted_at": f"2026-09-{day:02d}T10:00:00+07:00",
            "total_amount_vnd": 1_000_000,
            "is_test": False,
        }
        for day in range(1, 20)
    ]


def _auto_job_rows() -> list[dict[str, Any]]:
    started_at = (datetime.now().astimezone() - timedelta(hours=5)).isoformat()
    return [
        {
            "revenue_date": "2026-10-18",
            "status": "success",
            "row_count": 120,
            "gross_total": 5_000_000,
            "error_message": None,
            "finished_at": "2026-10-18T23:59:30+07:00",
        },
        {
            "revenue_date": "2026-10-17",
            "status": "failed",
            "row_count": 0,
            "gross_total": 0,
            "error_message": "X" * 300,
            "finished_at": "2026-10-17T23:59:10+07:00",
        },
        {
            "revenue_date": "2026-10-16",
            "status": "started",
            "row_count": 0,
            "gross_total": 0,
            "error_message": None,
            "finished_at": None,
            "started_at": started_at,
        },
    ]


def _fixtures() -> dict[str, Any]:
    return {
        "revenue_ledger_lines": _revenue_rows(),
        "kiosk_report_locations": _kiosk_locations(),
        "kiosk_daily_reports": _kiosk_reports(),
        "dealer_orders": _dealer_orders(),
        "revenue_auto_daily_parse_logs": _auto_job_rows(),
    }


async def _build() -> tuple[dict[str, Any], FakeDb]:
    db = FakeDb(_fixtures())
    result = await build_revenue_snapshot(db, TODAY)
    return result, db


# -- matcher / periods / grouping --------------------------------------------


@pytest.mark.parametrize(
    "message",
    [
        "Snapshot doanh thu",
        " SNAPSHOT DOANH THU!",
        "Chụp nhanh doanh thu",
        "revenue snapshot",
        "  Revenue   Snapshot  ",
    ],
)
def test_is_snapshot_command_matches(message: str) -> None:
    assert is_snapshot_command(message) is True


@pytest.mark.parametrize(
    "message",
    [
        "snapshot doanh thu tháng trước",
        "doanh thu tháng này theo kênh",
        "",
        "snapshot",
    ],
)
def test_is_snapshot_command_rejects_other_questions(message: str) -> None:
    assert is_snapshot_command(message) is False


def test_snapshot_periods_mid_month() -> None:
    assert snapshot_periods(date(2026, 10, 19)) == {
        "current": {"start": date(2026, 10, 1), "end": date(2026, 10, 19)},
        "previous": {"start": date(2026, 9, 1), "end": date(2026, 9, 19)},
    }


def test_snapshot_periods_caps_previous_month_end() -> None:
    assert snapshot_periods(date(2026, 3, 31)) == {
        "current": {"start": date(2026, 3, 1), "end": date(2026, 3, 31)},
        "previous": {"start": date(2026, 2, 1), "end": date(2026, 2, 28)},
    }


def test_snapshot_periods_crosses_year_boundary() -> None:
    assert snapshot_periods(date(2026, 1, 15)) == {
        "current": {"start": date(2026, 1, 1), "end": date(2026, 1, 15)},
        "previous": {"start": date(2025, 12, 1), "end": date(2025, 12, 15)},
    }


@pytest.mark.parametrize(
    ("channel", "expected"),
    [
        ("Franchise", "dealer"),
        ("Đại lý", "dealer"),
        ("Bread Business Wholesale Channel", "dealer"),
        ("NPP", "dealer"),
        ("B2B BMQ", "b2b"),
        ("Siêu thị X", "b2b"),
        ("Retail Kiosk", "retail"),
        ("Xe bán lẻ", "retail"),
        ("BÁNH NGỌT", "bakery"),
        ("Bakery business", "bakery"),
        ("Khách lẻ", "other"),
        (None, "other"),
    ],
)
def test_channel_group(channel: str | None, expected: str) -> None:
    assert channel_group(channel) == expected


def test_channel_labels() -> None:
    assert CHANNEL_GROUP_LABELS == {
        "dealer": "Đại lý",
        "b2b": "B2B / Siêu thị",
        "retail": "Xe bán lẻ",
        "bakery": "Bánh ngọt",
        "other": "Khác",
    }


# -- source queries / payload ------------------------------------------------


async def test_build_reads_expected_sources_and_filters() -> None:
    result, db = await _build()
    payload = result["block"]["payload"]

    assert result["block"]["component"] == "revenue_snapshot"
    assert payload["version"] == 1
    assert payload["caveat"] == CAVEAT
    assert payload["sources"] == [
        "revenue_ledger_lines",
        "kiosk_report_locations",
        "kiosk_daily_reports",
        "dealer_orders",
        "revenue_auto_daily_parse_logs",
    ]

    revenue_params = db.params_for("revenue_ledger_lines")[0]
    assert revenue_params["approval_status"] == "eq.approved"
    assert revenue_params["source_document.status"] == "in.(controlled,trusted)"
    assert "revenue_source_documents!inner(status)" in revenue_params["select"]
    assert "revenue_date.gte.2026-09-01" in revenue_params["and"]
    assert "revenue_date.lte.2026-10-19" in revenue_params["and"]

    assert db.params_for("kiosk_report_locations")[0]["active"] == "eq.true"
    report_params = db.params_for("kiosk_daily_reports")[0]
    assert report_params["status"] == "eq.submitted"
    assert "report_date.gte.2026-09-01" in report_params["and"]
    assert "report_date.lte.2026-10-19" in report_params["and"]

    dealer_params = db.params_for("dealer_orders")[0]
    assert dealer_params["is_test"] == "eq.false"
    assert dealer_params["status"] == "neq.cancelled"
    assert "submitted_at.gte.2026-09-01T00:00:00+07:00" in dealer_params["and"]
    assert "submitted_at.lte.2026-10-19T23:59:59+07:00" in dealer_params["and"]

    auto_params = db.params_for("revenue_auto_daily_parse_logs")[0]
    assert auto_params["order"] == "revenue_date.desc"
    assert "revenue_date.gte.2026-10-12" in auto_params["and"]
    assert "revenue_date.lte.2026-10-18" in auto_params["and"]


async def test_build_revenue_groups_and_kiosk_totals() -> None:
    result, _ = await _build()
    payload = result["block"]["payload"]

    groups = {group["group"]: group for group in payload["revenue"]["groups"]}
    assert set(groups) == {"dealer", "b2b", "bakery"}
    assert groups["dealer"]["current"] == 10_000_000
    assert groups["dealer"]["previous"] == 20_000_000
    assert groups["dealer"]["delta_pct"] == -50.0
    assert groups["dealer"]["silent_days"] == 14
    assert groups["dealer"]["previous_active_days"] == 1
    assert groups["b2b"]["delta_pct"] == 100.0
    assert groups["bakery"]["current"] == 0
    assert groups["bakery"]["silent_days"] == 19
    assert groups["bakery"]["previous_active_days"] == 10
    assert payload["revenue"]["total"]["current"] == 20_000_000
    assert payload["revenue"]["total"]["previous"] == 35_000_000
    assert len(payload["revenue"]["channels_raw"]) == 3

    kiosk = payload["kiosk"]
    assert kiosk["active_count"] == 5
    assert kiosk["reported_yesterday"] == 4
    assert kiosk["reported_today"] == 1
    assert kiosk["missing_yesterday"] == [
        {"location_code": "L5", "location_name": "Thủ Đức"}
    ]
    channels = {channel["channel_code"]: channel for channel in kiosk["channels"]}
    assert channels["grabfood"]["channel_name"] == "GrabFood"
    assert channels["grabfood"]["delta_pct"] == round(
        (1_000_000 - 3_000_000) / 3_000_000 * 100, 1
    )

    dealer = payload["dealer_orders"]
    assert dealer["count_current"] == 0
    assert dealer["count_previous"] == 19
    assert dealer["orders_last_2_days"] == 0
    assert dealer["previous_daily_avg"] == 1.0

    auto_job = payload["auto_job"]
    assert auto_job["last_success_date"] == "2026-10-18"
    assert auto_job["failed_dates"][0]["date"] == "2026-10-17"
    assert len(auto_job["failed_dates"][0]["error_message"]) == 160
    assert auto_job["stuck_dates"] == ["2026-10-16"]
    assert auto_job["missing_dates"] == [
        "2026-10-15",
        "2026-10-14",
        "2026-10-13",
        "2026-10-12",
    ]


# -- flags --------------------------------------------------------------------


def _codes(flags: list[dict[str, str]]) -> set[str]:
    return {flag["code"] for flag in flags}


async def test_build_flags_cover_channel_rules() -> None:
    result, _ = await _build()
    flags = result["block"]["payload"]["flags"]
    codes = _codes(flags)

    assert "channel_drop" in codes
    assert "channel_spike" in codes
    assert "channel_silent" in codes
    assert "kiosk_missing_reports" in codes
    assert "kiosk_channel_drop" in codes
    assert "auto_job_failed" in codes
    assert "auto_job_missing" in codes
    assert "dealer_orders_zero" in codes
    assert "data_source_error" not in codes

    dealer_drop = next(
        flag
        for flag in flags
        if flag["code"] == "channel_drop" and "Đại lý" in flag["title"]
    )
    assert dealer_drop["severity"] == "high"
    assert "Kiểm tra kênh Đại lý" in dealer_drop["action"]

    spike = next(flag for flag in flags if flag["code"] == "channel_spike")
    assert spike["severity"] == "medium"
    assert "Xác minh số nhập trùng" in spike["action"]

    silent = next(flag for flag in flags if flag["code"] == "channel_silent")
    assert silent["severity"] == "high"
    assert "không có số 2 ngày liền" in silent["action"]

    severities = [flag["severity"] for flag in flags]
    assert severities == sorted(
        severities, key={"high": 0, "medium": 1, "info": 2}.get
    )


async def test_build_flags_cover_kiosk_auto_job_and_dealer_rules() -> None:
    result, _ = await _build()
    flags = result["block"]["payload"]["flags"]

    missing = next(
        flag for flag in flags if flag["code"] == "kiosk_missing_reports"
    )
    assert missing["severity"] == "medium"
    assert "ngày 18/10" in missing["action"]
    assert "Thủ Đức" in missing["action"]

    kiosk_drop = next(
        flag for flag in flags if flag["code"] == "kiosk_channel_drop"
    )
    assert kiosk_drop["severity"] == "medium"
    assert "Kiểm tra app GrabFood tại điểm bán" in kiosk_drop["action"]

    job_failed = next(flag for flag in flags if flag["code"] == "auto_job_failed")
    assert job_failed["severity"] == "high"
    assert "chạy lại ngày 17/10" in job_failed["action"]

    job_missing = next(
        flag for flag in flags if flag["code"] == "auto_job_missing"
    )
    assert job_missing["severity"] == "medium"
    assert "không chạy ngày 15/10" in job_missing["action"]

    dealer_zero = next(
        flag for flag in flags if flag["code"] == "dealer_orders_zero"
    )
    assert dealer_zero["severity"] == "high"
    assert dealer_zero["action"] == (
        "Đơn Zalo đại lý về 0 trong 2 ngày: kiểm tra cổng đặt hàng dathang "
        "và Zalo OA"
    )


async def test_failed_source_is_an_error_flag_not_zero() -> None:
    db = FakeDb(
        _fixtures(),
        errors={"dealer_orders": RuntimeError("boom")},
    )
    result = await build_revenue_snapshot(db, TODAY)
    payload = result["block"]["payload"]

    assert payload["dealer_orders"]["status"] == "error"
    assert payload["dealer_orders"]["message"]
    assert payload["revenue"]["total"]["current"] == 20_000_000
    assert payload["kiosk"]["reported_yesterday"] == 4

    error_flags = [
        flag for flag in payload["flags"] if flag["code"] == "data_source_error"
    ]
    assert len(error_flags) == 1
    assert error_flags[0]["severity"] == "info"
    assert "đơn đại lý" in error_flags[0]["title"]
    assert error_flags[0]["action"] == "Thử lại sau; nếu lặp lại, báo kỹ thuật"
    assert "Đơn đại lý 2 ngày: không đọc được dữ liệu" in result["text"]


async def test_source_over_row_limit_is_an_error_section() -> None:
    fixtures = _fixtures()
    fixtures["revenue_ledger_lines"] = [{}] * 20_001
    result = await build_revenue_snapshot(FakeDb(fixtures), TODAY)
    payload = result["block"]["payload"]

    assert payload["revenue"]["status"] == "error"
    assert payload["revenue"]["message"] == "quá nhiều dòng"
    assert any(flag["code"] == "data_source_error" for flag in payload["flags"])
    assert payload["dealer_orders"]["count_previous"] == 19


def test_no_anomaly_flag_when_numbers_are_stable() -> None:
    sections = {
        "periods": {
            "current": {"start": "2026-10-01", "end": "2026-10-19"},
            "previous": {"start": "2026-09-01", "end": "2026-09-19"},
        },
        "revenue": {
            "groups": [
                {
                    "group": "dealer",
                    "label": "Đại lý",
                    "current": 10_000_000,
                    "previous": 10_000_000,
                    "delta_pct": 0.0,
                    "silent_days": 0,
                    "previous_active_days": 15,
                }
            ]
        },
        "kiosk": {
            "channels": [],
            "reported_yesterday": 4,
            "missing_yesterday": [],
            "reported_today": 0,
            "active_count": 4,
        },
        "dealer_orders": {
            "orders_last_2_days": 3,
            "previous_daily_avg": 2.0,
        },
        "auto_job": {
            "last_success_date": "2026-10-18",
            "failed_dates": [],
            "missing_dates": [],
            "stuck_dates": [],
        },
    }

    flags = evaluate_flags(sections, TODAY)

    assert len(flags) == 1
    assert flags[0]["code"] == "no_anomaly"
    assert flags[0]["severity"] == "info"
    assert "Không phát hiện bất thường theo quy tắc hiện có" in flags[0]["detail"]


# -- rendering / tool ---------------------------------------------------------


async def test_render_snapshot_text_is_vietnamese_and_has_caveat() -> None:
    result, _ = await _build()
    text = result["text"]

    assert text.startswith("Snapshot doanh thu 19/10")
    assert "Tổng doanh thu:" in text
    assert "Đại lý:" in text
    assert "Điểm bán nộp báo cáo hôm qua: 4/5" in text
    assert "Đơn đại lý 2 ngày: 0 đơn" in text
    assert "Job 23:59:" in text
    assert "Bất thường (" in text
    assert CAVEAT in text
    lowered = text.casefold()
    assert "sushi" not in lowered
    assert "claude" not in lowered
    assert "haiku" not in lowered


class _FakeSnapshotBackend:
    def __init__(self) -> None:
        self.calls = 0

    async def revenue_snapshot(self) -> dict[str, Any]:
        self.calls += 1
        return {
            "text": "Tóm tắt snapshot",
            "block": {
                "component": "revenue_snapshot",
                "payload": {"version": 1, "flags": [], "caveat": CAVEAT},
            },
        }


class _FakeChatSession:
    def __init__(self) -> None:
        self.pending_ui: list[dict[str, Any]] = []
        self.backend = _FakeSnapshotBackend()


async def test_snapshot_tool_appends_exactly_one_revenue_block(settings: Any) -> None:
    chat_session = _FakeChatSession()
    tools = build_snapshot_tools(chat_session, settings)

    assert len(tools) == 1
    assert tools[0].name == "bmq_revenue_snapshot"

    result = await tools[0].handler({"language": "vi"})

    assert result.get("is_error") is not True
    assert "Tóm tắt snapshot" in result["content"][0]["text"]
    assert len(chat_session.pending_ui) == 1
    assert chat_session.pending_ui[0]["component"] == "revenue_snapshot"
    assert chat_session.backend.calls == 1
