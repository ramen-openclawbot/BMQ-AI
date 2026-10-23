import { useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FileText, Plus, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LoadingState } from "@/components/ui/loading";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { useKhoItems } from "@/hooks/useKhoItems";
import {
  foodCertFileUrl, uploadFoodCertFile, useArchiveFoodCert, useFoodCerts, useFoodManufacturers,
  useUpsertFoodCert, useUpsertFoodManufacturer,
} from "@/hooks/useKhoLots";
import {
  FOOD_CERT_OWNER_KIND_LABELS, FOOD_CERT_TYPE_LABELS, expiryTone,
  type FoodCert, type FoodCertOwnerKind, type FoodCertType,
} from "@/lib/kho-lots";
import { searchKey } from "@/lib/kho-items";
import { cn } from "@/lib/utils";
import { KhoDialog } from "@/components/kho/KhoDialog";
import { useKhoConfirm } from "@/components/kho/KhoConfirm";
import "@/styles/bmq-warehouse.css";
import "@/styles/bmq-kho.css";

type View = "all" | "soon" | "expired";
const dmy = (iso?: string | null) => (iso ? iso.slice(0, 10).split("-").reverse().join("/") : "");
const CERT_TYPES = Object.keys(FOOD_CERT_TYPE_LABELS) as FoodCertType[];
const OWNER_KINDS = Object.keys(FOOD_CERT_OWNER_KIND_LABELS) as FoodCertOwnerKind[];

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
  const [adding, setAdding] = useState(false);
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
          <h1>Hồ sơ ATTP</h1>
          <p className="d3-wh-tag">{certs.isLoading ? "Đang đọc hồ sơ…" : certs.isError ? "Chưa đọc được" : `${rows.length} giấy tờ${soon ? ` · ${soon} sắp hết hạn` : ""}${expired ? ` · ${expired} đã hết hạn` : ""}`}</p>
        </div>
        {canEdit ? <Button onClick={() => setAdding(true)} data-bmq-cert-add><Plus className="mr-1.5 h-4 w-4" />Thêm giấy</Button> : null}
      </header>

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
        <p className="d3-kho-hint">Giấy chứng nhận cơ sở đủ điều kiện ATTP, phiếu kiểm nghiệm và bản công bố của nhà sản xuất từng nguyên liệu. Báo cáo truy xuất nguồn gốc sẽ đính kèm các giấy này.</p>

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
                      <span className={cn(exp.tone === "expired" && "d3-kho-exp is-expired", exp.tone === "soon" && "d3-kho-exp is-soon")} data-bmq-cert-exp={exp.tone ?? ""}>{exp.text}</span>
                    </small>
                    <small className="d3-cert-file"><FileText aria-hidden="true" />{c.file_name ?? "Mở file"}</small>
                  </button>
                  {canEdit ? <Button variant="ghost" size="sm" onClick={() => void archiveCert(c)} data-bmq-cert-archive>Lưu trữ</Button> : null}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="d3-kho-empty" data-bmq-cert-empty>
            {rows.length ? "Không có giấy tờ nào khớp bộ lọc." : canEdit ? "Chưa có giấy tờ nào. Bấm “Thêm giấy” để tải lên giấy chứng nhận ATTP đầu tiên." : "Chưa có giấy tờ nào."}
          </p>
        )}
      </section>
      {adding ? <CertForm onClose={() => setAdding(false)} /> : null}
      {dialog}
    </div>
  );
}

function CertForm({ onClose }: { onClose: () => void }) {
  const { toast } = useToast();
  const upsert = useUpsertFoodCert();
  const makeMaker = useUpsertFoodManufacturer();
  const makers = useFoodManufacturers();
  const items = useKhoItems();
  const suppliers = useQuery({
    queryKey: ["suppliers-min"],
    queryFn: async () => {
      const { data, error } = await supabase.from("suppliers").select("id, name").order("name");
      if (error) throw error;
      return (data ?? []) as { id: string; name: string }[];
    },
  });
  const [certType, setCertType] = useState<FoodCertType>("attp_facility");
  const [ownerKind, setOwnerKind] = useState<FoodCertOwnerKind>("manufacturer");
  const [ownerText, setOwnerText] = useState("");
  const [certNo, setCertNo] = useState("");
  const [issuer, setIssuer] = useState("");
  const [issuedOn, setIssuedOn] = useState("");
  const [expiresOn, setExpiresOn] = useState("");
  const [note, setNote] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const options = useMemo(() => {
    if (ownerKind === "manufacturer") return (makers.data ?? []).map((m) => ({ id: m.id, name: m.name }));
    if (ownerKind === "item") return (items.data?.items ?? []).filter((i) => i.active).map((i) => ({ id: i.id, name: i.name }));
    if (ownerKind === "supplier") return suppliers.data ?? [];
    return [];
  }, [ownerKind, makers.data, items.data, suppliers.data]);
  const match = options.find((o) => searchKey(o.name) === searchKey(ownerText)) ?? null;
  const ownerOk = ownerKind === "company" || Boolean(match) || (ownerKind === "manufacturer" && ownerText.trim().length >= 2);
  const datesOk = !(issuedOn && expiresOn && expiresOn < issuedOn);

  const save = async () => {
    if (!file || !ownerOk || !datesOk) return;
    setBusy(true);
    setError(null);
    try {
      let ownerId: string | null = ownerKind === "company" ? null : match?.id ?? null;
      if (ownerKind === "manufacturer" && !ownerId) ownerId = (await makeMaker.mutateAsync(ownerText.trim())).id;
      const up = await uploadFoodCertFile(file);
      await upsert.mutateAsync({
        ownerKind, ownerId, certType, certNo: certNo.trim() || null, issuer: issuer.trim() || null,
        issuedOn: issuedOn || null, expiresOn: expiresOn || null, filePath: up.file_path, fileName: up.file_name,
        mimeType: up.mime_type, note: note.trim() || null,
      });
      toast({ title: "Đã lưu giấy vào hồ sơ ATTP" });
      onClose();
    } catch {
      setError("Chưa lưu được giấy. Kiểm tra file (PDF hoặc ảnh, tối đa 20 MB) rồi thử lại.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <KhoDialog title="Thêm giấy ATTP" sub="Tải lên giấy chứng nhận, phiếu kiểm nghiệm hoặc bản công bố" onClose={onClose} wide data={{ "data-bmq-cert-form": "" }}>
      <div className="d3-kho-field"><span>Loại giấy</span>
        <div className="d3-kho-seg d3-kr-reasons" role="group" aria-label="Loại giấy">
          {CERT_TYPES.map((t) => (
            <button key={t} type="button" aria-pressed={certType === t} className={cn(certType === t && "is-on")} onClick={() => setCertType(t)} data-bmq-cert-type={t}>{FOOD_CERT_TYPE_LABELS[t]}</button>
          ))}
        </div>
      </div>
      <div className="d3-kho-field"><span>Của</span>
        <div className="d3-kho-seg is-small d3-kr-reasons" role="group" aria-label="Giấy của">
          {OWNER_KINDS.map((k) => (
            <button key={k} type="button" aria-pressed={ownerKind === k} className={cn(ownerKind === k && "is-on")} onClick={() => { setOwnerKind(k); setOwnerText(""); }} data-bmq-cert-owner-kind={k}>{FOOD_CERT_OWNER_KIND_LABELS[k]}</button>
          ))}
        </div>
      </div>
      {ownerKind !== "company" ? (
        <label className="d3-kho-field"><span>{FOOD_CERT_OWNER_KIND_LABELS[ownerKind]}</span>
          <Input value={ownerText} onChange={(e) => setOwnerText(e.target.value)} list="cert-owner-options" maxLength={160}
            placeholder={ownerKind === "manufacturer" ? "Ví dụ: Cty TNHH Interflour Vietnam" : "Gõ để chọn"} data-bmq-cert-owner />
          <datalist id="cert-owner-options">{options.map((o) => <option key={o.id} value={o.name} />)}</datalist>
          {ownerKind === "manufacturer" && ownerText.trim().length >= 2 && !match ? <small className="d3-kho-quiet">Nhà sản xuất mới, sẽ được thêm vào danh sách.</small> : null}
          {ownerKind !== "manufacturer" && ownerText && !match ? <small className="d3-kho-quiet">Chọn đúng tên trong danh sách.</small> : null}
        </label>
      ) : null}
      <div className="d3-cert-grid">
        <label className="d3-kho-field"><span>Số giấy</span><Input value={certNo} onChange={(e) => setCertNo(e.target.value)} maxLength={80} data-bmq-cert-no /></label>
        <label className="d3-kho-field"><span>Cơ quan cấp</span><Input value={issuer} onChange={(e) => setIssuer(e.target.value)} maxLength={160} placeholder="Ví dụ: Sở Y tế TP.HCM" data-bmq-cert-issuer /></label>
        <label className="d3-kho-field"><span>Ngày cấp</span><Input type="date" value={issuedOn} onChange={(e) => setIssuedOn(e.target.value)} data-bmq-cert-issued /></label>
        <label className="d3-kho-field"><span>Ngày hết hạn</span><Input type="date" value={expiresOn} onChange={(e) => setExpiresOn(e.target.value)} data-bmq-cert-expires /></label>
      </div>
      {!datesOk ? <p className="d3-kho-error">Ngày hết hạn phải sau ngày cấp.</p> : null}
      <label className="d3-kho-field"><span>Ghi chú</span><Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} data-bmq-cert-note /></label>
      <div className="d3-kho-field"><span>File giấy tờ</span>
        <input ref={fileRef} type="file" accept="application/pdf,image/*" className="hidden" onChange={(e) => setFile(e.target.files?.[0] ?? null)} data-bmq-cert-file />
        <Button type="button" variant="outline" className="justify-self-start" onClick={() => fileRef.current?.click()} data-bmq-cert-file-pick>
          <FileText className="mr-1.5 h-4 w-4" />{file ? file.name : "Chọn PDF hoặc ảnh"}
        </Button>
      </div>
      {error ? <p className="d3-kho-error">{error}</p> : null}
      <div className="d3-kho-actions">
        <Button disabled={!file || !ownerOk || !datesOk || busy} onClick={() => void save()} data-bmq-cert-save>{busy ? "Đang lưu…" : "Lưu giấy"}</Button>
        <Button variant="outline" onClick={onClose}>Thôi</Button>
      </div>
    </KhoDialog>
  );
}
