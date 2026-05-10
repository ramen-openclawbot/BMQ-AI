from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DASHBOARD = ROOT / "src/pages/RevenueManagementDashboard.tsx"


def read_dashboard() -> str:
    return DASHBOARD.read_text(encoding="utf-8")


def test_forecast_uses_two_historical_baselines_and_current_controlled_revenue():
    src = read_dashboard()
    assert "forecastBasePeriod = previousMonth(prevPeriod)" in src
    assert "forecastBaseLines" in src
    assert "previousLines" in src
    assert "dailyAverage * remainingDays" in src
    assert "actualControlled: stats.total" in src


def test_forecast_chart_embeds_current_parse_inside_forecast_column():
    src = read_dashboard()
    assert 'stackId="forecast"' in src
    assert 'dataKey="controlledRevenue"' in src
    assert 'dataKey="forecastRemaining"' in src
    assert "Cột {period} là dự báo vận hành tổng" in src
    assert "phần xanh nằm trong cột" in src


def test_operational_vietnamese_wording_and_not_final():
    src = read_dashboard()
    assert "Doanh thu đã kiểm soát" in src
    assert "Dự báo vận hành" in src
    assert "không phải trusted/final hay số audit cuối tháng" in src
    forbidden_near_forecast = ["trusted forecast", "final forecast", "audited forecast"]
    lowered = src.lower()
    for phrase in forbidden_near_forecast:
        assert phrase not in lowered


def test_dashboard_refreshes_after_cron_or_manual_parse_posts_ledger_rows():
    src = read_dashboard()
    assert "refetchOnWindowFocus: true" in src
    assert "refetchInterval: isSelectedCurrentMonth ? 5 * 60 * 1000 : false" in src
    assert '["revenue-ledger-lines", period]' in src


def test_no_frontend_cron_or_service_role_secret_strings():
    src = read_dashboard().lower()
    assert "service_role" not in src
    assert "cron_secret" not in src
    assert "authorization: bearer" not in src
