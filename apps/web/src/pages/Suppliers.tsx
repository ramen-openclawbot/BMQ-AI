import { Truck, Upload, Download, Plus } from "lucide-react";
import { SupplierList } from "@/components/dashboard/SupplierList";
import { AddSupplierDialog } from "@/components/dialogs/AddSupplierDialog";
import { ExportSuppliersButton } from "@/components/suppliers/ExportSuppliersButton";
import { ImportSuppliersButton } from "@/components/suppliers/ImportSuppliersButton";

const Suppliers = () => {
  return (
    <div className="space-y-4 sm:space-y-6" data-bmq-suppliers-vietnamese-mobile>
      <div className="rounded-2xl border border-amber-100 bg-gradient-to-br from-white via-amber-50/60 to-orange-50 px-4 py-4 shadow-sm sm:px-6 sm:py-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-start gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-amber-100 text-amber-700 shadow-inner">
              <Truck className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-amber-700">Đối tác cung ứng</p>
              <h1 className="mt-1 text-2xl font-display font-bold text-slate-950 sm:text-3xl">
                Nhà cung cấp
              </h1>
              <p className="mt-1 text-sm text-slate-600">
                Quản lý hồ sơ NCC, liên hệ, hợp đồng và điều khoản thanh toán.
              </p>
            </div>
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
