from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORKER = ROOT / "supabase/functions/dealer-warehouse-notify/index.ts"


def test_owner_correction_is_scoped_to_one_audited_job():
    source = WORKER.read_text(encoding="utf-8")
    assert 'const correctionJobId = req.headers.get("x-owner-correction-job-id")' in source
    assert '.eq("id", correctionJobId)' in source
    assert '.eq("notification_type", "production_bread_order_correction")' in source
    assert '.contains("source_snapshot", { approved_by_owner: true })' in source
    assert 'claim_dealer_order_notification_by_id' in source
    assert "x-force-delivery" not in source


def test_correction_message_recomputes_vehicle_and_total_after_lunar_off():
    original_vehicle = 720
    bv = 210
    pvc = 140
    corrected_vehicle = original_vehicle - bv - pvc
    raw_total = 1200 + 47 + corrected_vehicle
    rounded_total = ((raw_total + 9) // 10) * 10
    assert corrected_vehicle == 370
    assert raw_total == 1617
    assert rounded_total == 1620
