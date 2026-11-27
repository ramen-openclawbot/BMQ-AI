import { Suspense, lazy, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { FileSearch, FileText, Search, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LoadingState } from "@/components/ui/loading";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/AuthContext";
import { foodCertFileUrl, useArchiveFoodCert, useFoodCerts } from "@/hooks/useKhoLots";
import { FOOD_CERT_TYPE_LABELS, expiryTone, type FoodCert } from "@/lib/kho-lots";
import { searchKey } from "@/lib/kho-items";
import { cn } from "@/lib/utils";
import { KhoTraceDialog } from "@/components/kho/KhoTraceDialog";
import { AttpChecklist, type AttpAction } from "@/components/kho/AttpChecklist";
import { AttpUploadDialog } from "@/components/kho/AttpUploadDialog";
import { useKhoConfirm } from "@/components/kho/KhoConfirm";
import "@/styles/bmq-warehouse.css";
import "@/styles/bmq-kho.css";

type View = "all" | "soon" | "expired";
type Page = "checklist" | "papers" | "haccp";
const PAGES: Page[] = ["checklist", "papers", "haccp"];
// The HACCP workbook (owner 28/11) lives here as a tab; load its exporter only when opened.
const HaccpDossierRoute = lazy(() => import("@/pages/HaccpDossierRoute"));
const dmy = (iso?: string | null) => (iso ? iso.slice(0, 10).split("-").reverse().join("/") : "");

function expiryLabel(cert: FoodCert): { text: string; tone: "expired" | "soon" | "ok" | null } {
  if (!cert.expires_on || cert.days_left === null) return { text: "không ghi hạn", tone: null };
  const tone = expiryTone(cert.days_left);
  if (tone === "expired") return { text: `hết hạn ${dmy(cert.expires_on)}`, tone };
  if (tone === "soon") return { text: `còn ${cert.days_left} ngày · ${dmy(cert.expires_on)}`, tone };
  return { text: `hạn ${dmy(cert.expires_on)}`, tone };
}

/**
 * Hồ sơ ATTP (owner 23/10, traceability GĐ2): one private vault for the food-safety
 * papers behind every lot — facility ATTP certificates, COAs and product declarations,
 * each tied to a manufacturer, an item, a supplier or the company, with its expiry.
 */
export default function KhoCerts() {
  const certs = useFoodCerts();
  const { canEditModule } = useAuth();
  const canEdit = canEditModule("inventory");
  const { confirm, dialog } = useKhoConfirm();
  const { toast } = useToast();
  const archive = useArchiveFoodCert();
  const [view, setView] = useState<View>("all");
  const [query, setQuery] = useState("");
  const [tracing, setTracing] = useState(false);
  const [params, setParams] = useSearchParams();
  const page: Page = PAGES.includes(params.get("tab") as Page) ? (params.get("tab") as Page) : "checklist";
  const setPage = (next: Page) => setParams(next === "checklist" ? {} : { tab: next }, { replace: true });
  const [attp, setAttp] = useState<AttpAction | "new" | null>(null);
  const rows = certs.data ?? [];
  const soon = rows.filter((c) => expiryTone(c.days_left) === "soon").length;
  const expired = rows.filter((c) => expiryTone(c.days_left) === "expired").length;
  const key = searchKey(query);
  const shown = rows.filter((c) => {
    const tone = expiryTone(c.days_left);
    if (view === "soon" && tone !== "soon") return false;
    if (view === "expired" && tone !== "expired") return false;
    if (!key) return true;
    return [c.owner_name, c.cert_no, c.issuer, c.file_name, FOOD_CERT_TYPE_LABELS[c.cert_type]].some((v) => searchKey(v).includes(key));
  });

  const openFile = async (cert: FoodCert) => {
    try {
      window.open(await foodCertFileUrl(cert.file_path), "_blank", "noopener");
    } catch {
      toast({ title: "Chưa mở được file", description: "Chỉ người có quyền sửa kho mới mở được file giấy tờ.", variant: "destructive" });
    }
  };
  const archiveCert = async (cert: FoodCert) => {
    const ok = await confirm({ title: "Lưu trữ giấy này", message: `Ẩn “${FOOD_CERT_TYPE_LABELS[cert.cert_type]}” của ${cert.owner_name ?? "công ty"} khỏi danh sách? File vẫn được giữ.`, ok: "Lưu trữ", cancel: "Thôi" });
    if (!ok) return;
    archive.mutate({ id: cert.id }, { onSuccess: () => toast({ title: "Đã lưu trữ giấy" }) });
  };

  return (
    <div className="d3-wh d3-kho min-w-0" data-bmq-kho-certs>
      <header className="d3-wh-head">
        <div className="min-w-0">
          <h1>An toàn thực phẩm</h1>
          <p className="d3-wh-tag">{page === "haccp" ? "Hồ sơ HACCP bếp Quận 7 gửi đơn vị tư vấn ISO" : certs.isLoading ? "Đang đọc hồ sơ…" : certs.isError ? "Chưa đọc được" : `${rows.length} giấy tờ${soon ? ` · ${soon} sắp hết hạn` : ""}${expired ? ` · ${expired} đã hết hạn` : ""}`}</p>
        </div>
        <div className="d3-kho-head-acts">
          <Button variant={canEdit ? "outline" : "default"} onClick={() => setTracing(true)} data-bmq-trace-open><FileSearch className="mr-1.5 h-4 w-4" />Truy xuất</Button>
          {canEdit && page !== "haccp" ? <Button onClick={() => setAttp("new")} data-bmq-attp-new><Upload className="mr-1.5 h-4 w-4" />Tải giấy lên</Button> : null}
        </div>
      </header>

      <div className="d3-kho-tabs d3-fs-tabs" role="tablist" aria-label="An toàn thực phẩm">
        {([["attp", "Giấy tờ ATTP"], ["haccp", "Hồ sơ HACCP"]] as const).map(([id, label]) => {
          const on = id === "haccp" ? page === "haccp" : page !== "haccp";
          return <button key={id} type="button" role="tab" aria-selected={on} className={cn(on && "is-on")} onClick={() => setPage(id === "haccp" ? "haccp" : "checklist")} data-bmq-fs-tab={id}>{label}</button>;
        })}
      </div>

      {page !== "haccp" ? (
        <div className="d3-kho-seg is-small d3-attp-pages" role="group" aria-label="Cách xem giấy tờ">
          {([["checklist", "Checklist"], ["papers", `Tất cả giấy${certs.data ? ` (${rows.length})` : ""}`]] as const).map(([id, label]) => (
            <button key={id} type="button" aria-pressed={page === id} className={cn(page === id && "is-on")} onClick={() => setPage(id)} data-bmq-attp-page={id}>{label}</button>
          ))}
        </div>
      ) : null}

      {page === "haccp" ? <Suspense fallback={<LoadingState label="Đang mở hồ sơ HACCP" />}><HaccpDossierRoute embedded /></Suspense> : page === "checklist" ? <AttpChecklist canEdit={canEdit} onAction={setAttp} /> : (

      <section className="d3-wh-card d3-kho-card">
        <div className="d3-kho-tabs" role="tablist" aria-label="Lọc theo hạn">
          {([["all", "Tất cả", rows.length], ["soon", "Sắp hết hạn", soon], ["expired", "Đã hết hạn", expired]] as const).map(([id, label, n]) => (
            <button key={id} type="button" role="tab" aria-selected={view === id} className={cn(view === id && "is-on")} onClick={() => setView(id)} data-bmq-cert-view={id}>
              {label}<small>{certs.data ? n : "…"}</small>
            </button>
          ))}
        </div>
        <div className="d3-kho-tools">
          <span className="d3-kho-search">
            <Search aria-hidden="true" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Tìm nhà sản xuất, số giấy…" aria-label="Tìm giấy tờ" enterKeyHint="search" data-bmq-cert-search />
            {query ? <button type="button" onClick={() => setQuery("")} aria-label="Xóa tìm kiếm"><X /></button> : null}
          </span>
        </div>
        <p className="d3-kho-hint">Giấy chứng nhận cơ sở đủ điều kiện ATTP, phiếu kiểm nghiệm và bản công bố của nhà sản xuất từng nguyên liệu. Nút “Truy xuất” dựng báo cáo theo mẫu KFM cho từng lệnh sản xuất và đính kèm các giấy này.</p>

        {certs.isLoading ? <LoadingState label="Đang đọc hồ sơ" /> : certs.isError ? (
          <div className="d3-kho-failed" role="alert">
            <p>Không tải được hồ sơ ATTP.</p>
            <Button variant="outline" onClick={() => void certs.refetch()}>Thử lại</Button>
          </div>
        ) : shown.length ? (
          <ul className="d3-kho-list" data-bmq-cert-list>
            {shown.map((c) => {
              const exp = expiryLabel(c);
              return (
                <li key={c.id} className="d3-kho-row d3-cert-row" data-bmq-cert={c.id}>
                  <button type="button" className="d3-kho-row-main" onClick={() => void openFile(c)} data-bmq-cert-open>
                    <b>{c.owner_name ?? "Công ty"}</b>
                    <small>
                      <span>{FOOD_CERT_TYPE_LABELS[c.cert_type]}</span>
                      {c.cert_no ? <span>Số {c.cert_no}</span> : null}
                      {c.issuer ? <span>{c.issuer}</span> : null}
                      {c.review_status === "pending" ? <span className="d3-kho-exp is-soon" data-bmq-cert-pending>chờ kiểm tra</span> : null}
                      <span className={cn(exp.tone === "expired" && "d3-kho-exp is-expired", exp.tone === "soon" && "d3-kho-exp is-soon")} data-bmq-cert-exp={exp.tone ?? ""}>{exp.text}</span>
                    </small>
                    <small className="d3-cert-file"><FileText aria-hidden="true" />{c.file_name ?? "Mở file"}</small>
                  </button>
                  {canEdit && c.review_status === "pending" ? <Button size="sm" onClick={() => setAttp({ kind: "review", certId: c.id })}>Kiểm tra</Button> : canEdit ? <Button variant="ghost" size="sm" onClick={() => void archiveCert(c)} data-bmq-cert-archive>Lưu trữ</Button> : null}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="d3-kho-empty" data-bmq-cert-empty>
            {rows.length ? "Không có giấy tờ nào khớp bộ lọc." : canEdit ? "Chưa có giấy tờ nào. Bấm “Tải giấy lên” để thêm giấy chứng nhận ATTP đầu tiên." : "Chưa có giấy tờ nào."}
          </p>
        )}
      </section>
      )}
      {attp ? <AttpUploadDialog action={attp === "new" ? null : attp} onClose={() => setAttp(null)} /> : null}
      {tracing ? <KhoTraceDialog onClose={() => setTracing(false)} /> : null}
      {dialog}
    </div>
  );
}
