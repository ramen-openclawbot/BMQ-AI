from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PAGE = ROOT / "src/pages/PaymentRequests.tsx"
source = PAGE.read_text(encoding="utf-8")

# Summary amounts/counts must reconcile to the same supplier/search, VN-date,
# and source scope as the visible list. Status/card filters remain list-only so
# the three status cards keep showing the breakdown within that base scope.
assert 'const summaryFilteredRequests = useMemo(() => {' in source, (
    "Duyệt chi summary needs one shared search/date/source-filtered scope"
)
summary_scope = source.split('const summaryFilteredRequests = useMemo(() => {', 1)[1].split(
    'const stats = useMemo(() => {', 1
)[0]
for token in [
    'dateFilteredRequests.filter',
    'normalizeSearch(searchTerm)',
    'sourceFilter === "warehouse_receipt"',
    'sourceFilter === "manual"',
    'supplierName.includes(normalizedSearchTerm)',
    'productNames.includes(normalizedSearchTerm)',
    'requestCode.includes(normalizedSearchTerm)',
    'receiptNumber.includes(normalizedSearchTerm)',
    'poNumber.includes(normalizedSearchTerm)',
]:
    assert token in summary_scope, f"Summary scope is missing filter behavior: {token}"

stats_scope = source.split('const stats = useMemo(() => {', 1)[1].split('const statCards = [', 1)[0]
assert 'const source = summaryFilteredRequests;' in stats_scope, (
    "Summary stats must reduce the shared search/date/source-filtered scope"
)
assert '}, [summaryFilteredRequests]);' in stats_scope, (
    "Summary stats memo must update when its filtered scope changes"
)

list_scope = source.split('// Filter requests based on dropdown and card filters', 1)[1].split(
    'useEffect(() => {', 1
)[0]
assert 'return summaryFilteredRequests.filter((r) => {' in list_scope, (
    "Visible list must layer status/card filters on the shared summary scope"
)
for token in ['statusFilter !== "all"', 'if (activeCardFilter)']:
    assert token in list_scope, f"Visible list is missing list-only filtering: {token}"

print("payment request filtered summary reconciliation guard passed")
