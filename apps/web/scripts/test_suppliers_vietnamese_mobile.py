#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def read(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8")


def test_suppliers_page_is_vietnamese_and_mobile_first():
    page = read("src/pages/Suppliers.tsx")
    supplier_list = read("src/components/dashboard/SupplierList.tsx")
    importer = read("src/components/suppliers/ImportSuppliersButton.tsx")
    exporter = read("src/components/suppliers/ExportSuppliersButton.tsx")
    add_dialog = read("src/components/dialogs/AddSupplierDialog.tsx")
    details = read("src/components/dialogs/SupplierDetailsDialog.tsx")

    assert "data-bmq-suppliers-vietnamese-mobile" in page
    assert "Nhà cung cấp" in page
    assert "Quản lý hồ sơ NCC" in page
    assert "data-bmq-suppliers-mobile-actions" in page
    assert "grid grid-cols-3" in page
    assert ">Suppliers<" not in page
    assert "Manage your supplier relationships" not in page

    assert "data-bmq-suppliers-single-list-header" in supplier_list
    assert "Danh sách NCC" in supplier_list
    assert "Tìm tên, nhóm, SĐT, email" in supplier_list
    assert "data-bmq-suppliers-mobile-card-list" in supplier_list
    assert "Xem chi tiết" in supplier_list
    assert "Search suppliers by name" not in supplier_list
    assert "No suppliers yet" not in supplier_list
    assert "No matching suppliers" not in supplier_list
    assert "Couldn't load suppliers" not in supplier_list

    assert "Nhập Excel" in importer
    assert "Nhập nhà cung cấp từ Excel" in importer
    assert "Xuất Excel" in exporter
    assert "nha_cung_cap_" in exporter
    assert "Thêm NCC" in add_dialog
    assert "Thêm nhà cung cấp" in add_dialog
    assert "Tên nhà cung cấp" in add_dialog
    assert "Add Supplier" not in add_dialog
    assert "Supplier Name" not in add_dialog

    assert "Sửa nhà cung cấp" in details
    assert "Số điện thoại" in details
    assert "Đề nghị thanh toán" in details
    assert "No contact information available" not in details
    assert "Edit Supplier" not in details


def test_suppliers_route_uses_module_guard_with_vietnamese_label():
    routes = read("src/components/AppRoutes.tsx")
    assert 'suppliers: "Nhà cung cấp"' in routes
    assert '<Route path="/suppliers" element={<ModuleRoute moduleKey="suppliers"><Suppliers /></ModuleRoute>} />' in routes
    assert "Trang này yêu cầu quyền xem module {moduleLabel}" in routes


def main():
    tests = [
        test_suppliers_page_is_vietnamese_and_mobile_first,
        test_suppliers_route_uses_module_guard_with_vietnamese_label,
    ]
    for test in tests:
        test()
    print(f"ok - {len(tests)} supplier tests passed")


if __name__ == "__main__":
    main()
