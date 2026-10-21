import { Upload, Download, Plus } from "lucide-react";
import { SupplierList } from "@/components/dashboard/SupplierList";
import { AddSupplierDialog } from "@/components/dialogs/AddSupplierDialog";
import { ExportSuppliersButton } from "@/components/suppliers/ExportSuppliersButton";
import { ImportSuppliersButton } from "@/components/suppliers/ImportSuppliersButton";
import "@/styles/bmq-production.css";

const Suppliers = () => {
  return (
    <div className="space-y-4 sm:space-y-6" data-bmq-suppliers-vietnamese-mobile>
      <div className="d3-prod-head">
        <div className="flex w-full flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0">
            <h1>Nhà cung cấp</h1>
            <p>Quản lý hồ sơ NCC, liên hệ, hợp đồng và điều khoản thanh toán.</p>
          </div>
          <div className="grid grid-cols-3 gap-2 sm:flex sm:flex-wrap sm:items-center sm:justify-end" data-bmq-suppliers-mobile-actions>
            <ImportSuppliersButton compactIcon={Upload} />
            <ExportSuppliersButton compactIcon={Download} />
            <AddSupplierDialog compactIcon={Plus} />
          </div>
        </div>
      </div>

      <SupplierList />
    </div>
  );
};

export default Suppliers;
