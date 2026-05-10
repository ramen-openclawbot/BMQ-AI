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
    assert "blendedDailyRate * remainingDays" in src
    assert "const actualControlled = stats.total" in src


def test_forecast_v2_models_mix_timing_trend_and_concentration_risk():
    src = read_dashboard()
    assert "productSkuKey" in src
    assert "extractRawText" in src
    assert "productMixCoverage" in src
    assert "channelMixFactor" in src
    assert "productMixFactor" in src
    assert "lineWeekday" in src
    assert "weekday/peak/downtime" in src
    assert "timingBucket" in src
    assert 'return "early"' in src
    assert 'return "mid"' in src
    assert 'return "late"' in src
    assert "timingBucketLabel" in src
    assert "recentDailyAverage" in src
    assert "topCustomerShare" in src
    assert "Rủi ro tập trung" in src


def test_forecast_avoids_old_double_weighted_channel_replacement():
    src = read_dashboard()
    forbidden_patterns = [
        "weightedChannelDaily",
        "share * ((channelTotals.get(key) || 0) / baselineDays || dailyAverage)",
        "weightedChannelDaily * 0.55 + dailyAverage * 0.45",
    ]
    for pattern in forbidden_patterns:
        assert pattern not in src


def test_forecast_anchors_baseline_daily_with_bounded_mix_factors():
    src = read_dashboard()
    assert "const baselineDailyAnchor = dailyAverage" in src
    assert "const channelMixFactor = actualControlled > 0 && total > 0" in src
    assert "const productMixFactor = productMixCoverage >= 0.25" in src
    assert "const baselineComparableFloor = dailyAverage * 0.9" in src
    assert "clamp(channelLiftFromComparableShares || 1, 0.9, 1.1)" in src
    assert "clamp(productLiftFromKnownProducts || 1, 0.9, 1.1)" in src
    assert "baselineDailyAnchor * channelMixFactor * productMixFactor" in src


def test_low_product_coverage_uses_historical_baseline_fallback_wording():
    src = read_dashboard()
    assert "dữ liệu product/SKU còn mỏng" in src
    assert "forecast fallback về historical baseline + điều chỉnh channel/source có biên" in src


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
    assert "Giải thích dự báo V2" in src
    assert "Độ tin cậy" in src
    assert "Công thức: blend historical baseline có bounded channel/source adjustment + run-rate gần đây + lịch ngày còn lại" in src
    assert "confidenceLabel" in src
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
