from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PAGE = ROOT / "src/pages/PaymentRequests.tsx"
source = PAGE.read_text(encoding="utf-8")

required_tokens = [
    'data-stitch-payment-requests-mobile="approved-card-flow"',
    'data-stitch-section="mobile-summary-filters"',
    'data-stitch-section="mobile-approval-cards"',
    'data-stitch-card="mobile-payment-request"',
    'data-stitch-section="mobile-accounting-checklist"',
    'data-stitch-section="mobile-selected-actions-inline"',
    'data-stitch-section="mobile-pagination"',
    'absolute -left-1.5 top-5 h-14 w-3 rounded-r-lg bg-primary',
    'lg:hidden',
    'rounded-3xl border-border/70 bg-card/85 shadow-card backdrop-blur-xl',
    'Cần duyệt',
    'Đối soát trước khi duyệt',
    'PO / Phiếu nhập',
    'Phiếu nhập',
    'Cần đối soát PO',
    'Trang ${safeCurrentPage}/${totalPages}',
    'Trước',
    'Tiếp',
]

missing = [token for token in required_tokens if token not in source]
assert not missing, f"Missing Stitch mobile payment request markers/classes/copy: {missing}"

# Keep the operational desktop table present but hidden on mobile.
assert '<Card className="hidden overflow-hidden rounded-md' in source, "Desktop table must remain available from lg breakpoint"
assert 'TableHead className="min-w-[130px] text-slate-700' in source, "Desktop table columns should not be removed"

# Mobile actions should be thumb-sized and preserve detail + approve paths.
mobile_section = source.split('data-stitch-section="mobile-approval-cards"', 1)[1].split('{/* Requests Table */}', 1)[0]
for token in ['h-12 rounded-xl', 'setSelectedRequestId(request.id)', 'openQuickApproveConfirm(request.id)']:
    assert token in mobile_section, f"Missing mobile action affordance: {token}"

for forbidden in ['data-stitch-section="mobile-sticky-bulk-actions"', 'fixed inset-x-3 bottom-3']:
    assert forbidden not in source, f"Mobile bottom menu/sticky bottom pattern should not be present: {forbidden}"

print("payment requests mobile Stitch guard passed")
