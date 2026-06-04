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


def main():
    test_qa_pass_dialog_does_not_render_redundant_pass_buttons()
    print("PASS: QA pass dialog no longer renders three redundant PASS buttons")


if __name__ == "__main__":
    main()
