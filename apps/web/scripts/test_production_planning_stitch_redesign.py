from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src/pages/ProductionPlanning.tsx"


def read_src() -> str:
    return SRC.read_text(encoding="utf-8")


def test_production_planning_uses_stitch_light_ops_structure():
    src = read_src()

    assert 'data-stitch-production-planning="bmq-light-operations"' in src
    assert 'data-stitch-production-metrics="true"' in src
    assert 'data-stitch-production-po-check="true"' in src
    assert 'data-stitch-production-table="true"' in src
    assert 'data-stitch-production-insights="true"' in src
    assert 'data-stitch-production-orders="true"' in src
    assert 'card-elevated' in src
    assert 'stat-card' in src
    assert 'Thiết lập SX & Kiểm tra PO' in src
    assert 'SKU / Thành phẩm' in src
    assert 'Cần sản xuất' in src
    assert 'Việc cần xử lý' in src


def test_production_planning_preserves_existing_workflows_and_handlers():
    src = read_src()

    required_logic = [
        'const handleCreateClick = (po: CustomerPoInbox)',
        'const handleSubmitCreate = async () =>',
        'const openEditOrder = (order: ProductionOrder)',
        'const closeEditOrder = () =>',
        'const handleOpenTvMode = useCallback(() =>',
        'const handleTvModeOpenChange = useCallback((open: boolean) =>',
        'createProductionOrderMutation.mutate',
        'updateProductionOrderMutation.mutate',
        'deleteProductionOrderMutation.mutate',
        'onClick={() => handleCreateClick(po)}',
        'onClick={handleSubmitCreate}',
        'onClick={handleOpenTvMode}',
    ]

    for marker in required_logic:
        assert marker in src


def test_redesign_does_not_reintroduce_dark_page_shell():
    src = read_src()
    page_shell = src.split('data-stitch-production-planning="bmq-light-operations"', 1)[1].split('{tvModeOpen &&', 1)[0]

    assert 'bg-[radial-gradient(circle_at_18%_-12%' not in page_shell
    assert 'bg-[#14100d]' not in page_shell
    assert 'text-white' not in page_shell
