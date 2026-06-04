from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
QA_PAGE = ROOT / "src/pages/QAInspection.tsx"


def test_qa_pass_dialog_does_not_render_redundant_pass_buttons():
    source = QA_PAGE.read_text(encoding="utf-8")
    dialog_section = source.split('data-qa-pass-modal="production-order-click"', 1)[1].split('<Dialog open={detailOpen}', 1)[0]

    assert "setChecklist((current)" not in dialog_section
    assert "CHƯA PASS" not in dialog_section
    assert "Upload nhiều ảnh QA" not in dialog_section  # labels come from copy object, not hardcoded here
    assert "data-qa-inspector-autofill" in dialog_section
    assert "fileInputRef.current?.click()" in dialog_section
    assert "qaPassMutation.mutate()" in dialog_section


def test_qa_selected_date_title_uses_date_key_without_timezone_shift():
    source = QA_PAGE.read_text(encoding="utf-8")

    assert "const displayDateKey" in source
    assert "match(/^(\\d{4})-(\\d{2})-(\\d{2})/)" in source
    assert "displayDateKey(selectedDate)" in source
    assert "displayDate(selectedDate)" not in source
    assert 'data-stitch-qa-finished-goods="q7-current-theme-vn-date"' in source
    assert 'bg-[#f7f2ec]' not in source


def main():
    test_qa_pass_dialog_does_not_render_redundant_pass_buttons()
    test_qa_selected_date_title_uses_date_key_without_timezone_shift()
    print("PASS: QA date title is timezone-safe and redundant pass buttons stay removed")


if __name__ == "__main__":
    main()
