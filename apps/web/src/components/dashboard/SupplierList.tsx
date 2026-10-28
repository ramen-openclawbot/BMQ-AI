import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Mail, Phone, Search, Truck, UserRound } from "lucide-react";
import { useSuppliers, Supplier } from "@/hooks/useSuppliers";
import { useSupplierProfileOverview } from "@/hooks/useSupplierProfiles";
import {
  SUPPLIER_PROFILE_MISSING_LABELS,
  filterSupplierProfiles,
  supplierProfileFilterCounts,
  type SupplierProfileFilter,
  type SupplierProfileOverview,
} from "@/lib/supplier-profile";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { SupplierDetailsDialog } from "@/components/dialogs/SupplierDetailsDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const PROFILE_FILTERS: { id: SupplierProfileFilter; label: string }[] = [
  { id: "all", label: "Tất cả" },
  { id: "active_60d", label: "Mua 60 ngày" },
  { id: "missing_email", label: "Thiếu email" },
  { id: "incomplete", label: "Thiếu thông tin" },
  { id: "unpaid", label: "Còn nợ" },
];

const LOCATION_LABEL: Record<string, string> = { q7: "Kho Q7", tan_tao: "Kho Tân Tạo" };
const vnd = (value: number) => `${Math.round(value).toLocaleString("vi-VN")} đ`;
const dmy = (value: string) => {
  const [y, m, d] = value.slice(0, 10).split("-");
  return d && m && y ? `${d}/${m}/${y}` : value;
};

/** One line of facts from the profile overview: what the supplier is to us, and what is missing. */
function ProfileFacts({ profile }: { profile: SupplierProfileOverview }) {
  const facts = [
    profile.receivingLocation ? LOCATION_LABEL[profile.receivingLocation] ?? profile.receivingLocation : null,
    profile.orderItemCount > 0 ? `${profile.orderItemCount} món đặt được` : null,
    profile.lastPurchaseAt ? `mua gần nhất ${dmy(profile.lastPurchaseAt)}` : null,
  ].filter(Boolean);
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5" data-bmq-supplier-profile={profile.id}>
      {profile.unpaidAmount > 0 ? (
        <span className="rounded-md bg-red-50 px-2 py-0.5 text-xs font-medium text-red-700 tabular-nums" data-bmq-supplier-unpaid>
          Còn nợ {vnd(profile.unpaidAmount)}{profile.unpaidCount > 1 ? ` · ${profile.unpaidCount} phiếu` : ""}
        </span>
      ) : null}
      {profile.missing.map((code) => (
        <span key={code} className="rounded-md bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800" data-bmq-supplier-missing={code}>
          {SUPPLIER_PROFILE_MISSING_LABELS[code]}
        </span>
      ))}
      {facts.length ? <span className="text-xs text-slate-500 tabular-nums">{facts.join(" · ")}</span> : null}
    </div>
  );
}

export function SupplierList() {
  const { data: suppliers, isLoading, isError, error, refetch } = useSuppliers();
  const overview = useSupplierProfileOverview();
  const [params, setParams] = useSearchParams();
  const [selectedSupplier, setSelectedSupplier] = useState<Supplier | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [filter, setFilter] = useState<SupplierProfileFilter>("all");
  const profiles = useMemo(() => overview.data ?? [], [overview.data]);
  const profileById = useMemo(() => new Map(profiles.map((row) => [row.id, row])), [profiles]);
  const counts = useMemo(() => supplierProfileFilterCounts(profiles), [profiles]);

  const normalizeText = (text: string) =>
    text
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .trim();

  const filteredSuppliers = useMemo(() => {
    const normalizedSearch = normalizeText(searchTerm);
    // With the overview loaded, its order (bought in 60 days first, then the least complete) and filters lead.
    if (profiles.length && suppliers?.length) {
      const byId = new Map(suppliers.map((row) => [row.id, row]));
      const picked = filterSupplierProfiles(profiles, { filter });
      return picked
        .map((row) => byId.get(row.id))
        .filter((row): row is Supplier => Boolean(row))
        .filter((supplier) => {
          const contact = profileById.get(supplier.id)?.contactName ?? "";
          const searchable = [supplier.name, supplier.category, supplier.phone, supplier.email, contact].filter(Boolean).join(" ");
          return normalizeText(searchable).replace(/đ/g, "d").includes(normalizedSearch.replace(/đ/g, "d"));
        });
    }
    return (suppliers || []).filter((supplier) => {
      const searchable = [supplier.name, supplier.category, supplier.phone, supplier.email]
        .filter(Boolean)
        .join(" ");
      return normalizeText(searchable).includes(normalizedSearch);
    });
  }, [searchTerm, suppliers, profiles, profileById, filter]);

  // /suppliers?id=<uuid> (from Đặt hàng) opens that supplier's profile.
  const wanted = params.get("id");
  useEffect(() => {
    if (!wanted || !suppliers?.length) return;
    const match = suppliers.find((row) => row.id === wanted);
    if (match) {
      setSelectedSupplier(match);
      setDialogOpen(true);
    }
  }, [wanted, suppliers]);
  const onDialogChange = (open: boolean) => {
    setDialogOpen(open);
    if (!open && wanted) setParams((prev) => { const next = new URLSearchParams(prev); next.delete("id"); return next; }, { replace: true });
  };
  // Keep the open dialog on the latest row after a save.
  const shownSupplier = selectedSupplier ? suppliers?.find((row) => row.id === selectedSupplier.id) ?? selectedSupplier : null;

  const handleSupplierClick = (supplier: Supplier) => {
    setSelectedSupplier(supplier);
    setDialogOpen(true);
  };

  if (isLoading) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
        <div className="mb-4 flex items-center justify-between">
          <Skeleton className="h-6 w-36" />
          <Skeleton className="h-9 w-28" />
        </div>
        <div className="space-y-3">
          {[1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-20 w-full rounded-xl" />
          ))}
        </div>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="rounded-2xl border border-red-100 bg-white p-5 shadow-sm">
        <div className="space-y-3">
          <p className="font-semibold text-red-700">Không tải được danh sách nhà cung cấp</p>
          <p className="break-words whitespace-pre-wrap text-sm text-slate-500">
            {(() => {
              if (error instanceof Error) return error.message;
              if (typeof error === "string") return error;
              try {
                return JSON.stringify(error, null, 2);
              } catch {
                return "Lỗi không xác định";
              }
            })()}
          </p>
          <Button variant="outline" onClick={() => refetch()}>
            Tải lại
          </Button>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="rounded-2xl border border-slate-200 bg-white shadow-sm" data-bmq-suppliers-single-list-header>
        <div className="border-b border-slate-100 p-4 sm:p-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm font-semibold text-slate-950">Danh sách NCC</p>
              <p className="text-xs text-slate-500">{filteredSuppliers.length}/{suppliers?.length || 0} nhà cung cấp</p>
            </div>
            <div className="relative w-full sm:max-w-sm">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <Input
                placeholder="Tìm tên, nhóm, SĐT, email..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="h-10 rounded-xl border-slate-200 pl-9"
                data-bmq-supplier-search
              />
            </div>
          </div>
          {profiles.length ? (
            <div className="-mx-1 mt-3 flex gap-1.5 overflow-x-auto px-1 pb-0.5 [scrollbar-width:none]" role="group" aria-label="Lọc nhà cung cấp" data-bmq-supplier-filters>
              {PROFILE_FILTERS.map(({ id, label }) => (
                <button
                  key={id}
                  type="button"
                  aria-pressed={filter === id}
                  onClick={() => setFilter(id)}
                  className={cn(
                    "inline-flex h-9 flex-none items-center gap-1.5 whitespace-nowrap rounded-full px-3 text-[13px] transition-colors",
                    filter === id ? "bg-slate-950 text-white" : "bg-slate-100 text-slate-700 hover:bg-slate-200",
                  )}
                  data-bmq-supplier-filter={id}
                >
                  {label}
                  <span className={cn("text-xs tabular-nums", filter === id ? "text-white/70" : "text-slate-500")}>{counts[id]}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>

        {!suppliers?.length ? (
          <div className="flex flex-col items-center justify-center px-4 py-10 text-center">
            <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-amber-50 text-amber-700">
              <Truck className="h-6 w-6" />
            </div>
            <p className="font-semibold text-slate-900">Chưa có nhà cung cấp</p>
            <p className="mt-1 text-sm text-slate-500">Thêm NCC đầu tiên để quản lý nhập hàng và công nợ.</p>
          </div>
        ) : filteredSuppliers.length ? (
          <div className="divide-y divide-slate-100" data-bmq-suppliers-mobile-card-list>
            {filteredSuppliers.map((supplier) => (
              <button
                key={supplier.id}
                type="button"
                className="block w-full px-4 py-3 text-left transition hover:bg-amber-50/50 sm:px-5 sm:py-4"
                onClick={() => handleSupplierClick(supplier)}
                data-bmq-supplier-row={supplier.id}
              >
                <div className="flex items-start gap-3">
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-amber-100 text-base font-bold text-amber-700">
                    {supplier.name.charAt(0)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0">
                        <p className="truncate font-semibold text-slate-950">{supplier.name}</p>
                        <p className="text-xs text-slate-500">{supplier.category || "Chưa phân nhóm"}</p>
                        {supplier.description && (
                          <p className="mt-1 line-clamp-2 text-xs text-slate-500 sm:line-clamp-1">
                            {supplier.description}
                          </p>
                        )}
                      </div>
                      <span className="hidden rounded-full bg-slate-100 px-2 py-1 text-xs font-medium text-slate-600 sm:inline-flex">
                        Xem chi tiết
                      </span>
                    </div>
                    <div className="mt-2 flex flex-col gap-1 text-xs text-slate-500 sm:flex-row sm:flex-wrap sm:gap-x-4">
                      {supplier.phone && (
                        <span className="inline-flex min-w-0 items-center gap-1">
                          <Phone className="h-3.5 w-3.5 shrink-0" />
                          <span className="truncate">{supplier.phone}</span>
                        </span>
                      )}
                      {supplier.email && (
                        <span className="inline-flex min-w-0 items-center gap-1">
                          <Mail className="h-3.5 w-3.5 shrink-0" />
                          <span className="truncate">{supplier.email}</span>
                        </span>
                      )}
                      {profileById.get(supplier.id)?.contactName ? (
                        <span className="inline-flex min-w-0 items-center gap-1">
                          <UserRound className="h-3.5 w-3.5 shrink-0" />
                          <span className="truncate">{profileById.get(supplier.id)?.contactName}</span>
                        </span>
                      ) : null}
                      {!supplier.phone && !supplier.email && !profileById.get(supplier.id) && <span>Chưa có thông tin liên hệ</span>}
                    </div>
                    {profileById.get(supplier.id) ? <ProfileFacts profile={profileById.get(supplier.id)!} /> : null}
                  </div>
                </div>
              </button>
            ))}
          </div>
        ) : (
          <p className="px-4 py-8 text-center text-sm text-slate-500">Không tìm thấy nhà cung cấp phù hợp.</p>
        )}
      </div>

      <SupplierDetailsDialog
        supplier={shownSupplier}
        open={dialogOpen}
        onOpenChange={onDialogChange}
      />
    </>
  );
}
