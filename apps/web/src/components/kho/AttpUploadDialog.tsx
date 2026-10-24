import { useEffect, useMemo, useRef, useState } from "react";
import { Check, FileText, Loader2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { useAttpChecklist, useConfirmFoodCert, useScanFoodCert, useUploadPendingCert } from "@/hooks/useKhoAttp";
import { foodCertFileUrl, uploadFoodCertFile, useFoodCerts, useFoodManufacturers, useUpsertFoodManufacturer } from "@/hooks/useKhoLots";
import { ATTP_KIND_LABELS, flattenByItem, type AttpKind, type ScanFoodCertResult } from "@/lib/kho-attp";
import type { FoodCertOwnerKind, FoodCertTypeWithQuarantine } from "@/lib/kho-lots";
import { searchKey } from "@/lib/kho-items";
import { cn } from "@/lib/utils";
import { KhoDialog } from "@/components/kho/KhoDialog";
import type { AttpAction } from "@/components/kho/AttpChecklist";

const TYPES: FoodCertTypeWithQuarantine[] = ["attp_facility", "product_declaration", "coa", "quarantine", "other"];
const TYPE_LABEL = (t: FoodCertTypeWithQuarantine) => (t === "other" ? "Giấy tờ khác" : ATTP_KIND_LABELS[t as AttpKind]);

interface Draft {
  certType: FoodCertTypeWithQuarantine;
  ownerKind: FoodCertOwnerKind;
  ownerId: string | null;
  ownerText: string;
  certNo: string;
  issuer: string;
  issuedOn: string;
  expiresOn: string;
  itemIds: string[];
  machine: Set<string>;
}

const emptyDraft = (kind: AttpKind | null, itemIds: string[]): Draft => ({
  certType: kind ?? "attp_facility", ownerKind: "manufacturer", ownerId: null, ownerText: "", certNo: "", issuer: "",
  issuedOn: "", expiresOn: "", itemIds, machine: new Set(),
});

function draftFromScan(scan: ScanFoodCertResult | null, kind: AttpKind | null, itemIds: string[]): Draft {
  const d = emptyDraft(kind, itemIds);
  if (!scan) return d;
  const m = new Set<string>();
  const type = scan.cert_type as FoodCertTypeWithQuarantine;
  if (TYPES.includes(type) && type !== "other") { d.certType = type; m.add("type"); }
  if (scan.match) { d.ownerKind = scan.match.kind; d.ownerId = scan.match.id; d.ownerText = scan.match.name; m.add("owner"); }
  else if (scan.holder_name) { d.ownerText = scan.holder_name; m.add("owner"); }
  if (scan.cert_no) { d.certNo = scan.cert_no; m.add("no"); }
  if (scan.issuer) { d.issuer = scan.issuer; m.add("issuer"); }
  if (scan.issued_on) { d.issuedOn = scan.issued_on; m.add("issued"); }
  if (scan.expires_on) { d.expiresOn = scan.expires_on; m.add("expires"); }
  d.itemIds = [...new Set([...itemIds, ...(scan.suggested_item_ids ?? [])])];
  d.machine = m;
  return d;
}

/**
 * Tải giấy → máy đọc → kiểm tra → Hoàn thành (owner 24/10). The paper is saved as
 * "chờ kiểm tra" right after reading, so closing the sheet never loses it; only
 * "Đúng, hoàn thành" makes it count in the checklist.
 */
export function AttpUploadDialog({ action, onClose }: { action: AttpAction | null; onClose: () => void }) {
  const { toast } = useToast();
  const checklist = useAttpChecklist(180);
  const certs = useFoodCerts();
  const makers = useFoodManufacturers();
  const scan = useScanFoodCert();
  const pending = useUploadPendingCert();
  const confirm = useConfirmFoodCert();
  const makeMaker = useUpsertFoodManufacturer();
  const fileRef = useRef<HTMLInputElement>(null);
  const ctxKind = action?.kind === "upload" ? action.certKind : null;
  const ctxItems = action?.kind === "upload" ? [action.itemId] : [];

  const [certId, setCertId] = useState<string | null>(action?.kind === "review" ? action.certId : null);
  const [stage, setStage] = useState<"pick" | "reading" | "review">(action?.kind === "review" ? "review" : "pick");
  const [draft, setDraft] = useState<Draft>(() => emptyDraft(ctxKind, ctxItems));
  const [file, setFile] = useState<{ path: string; name: string; mime: string | null } | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [readNote, setReadNote] = useState<string | null>(null);
  const [addQuery, setAddQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const loadedRef = useRef(false);

  const allItems = useMemo(() => (checklist.data ? flattenByItem(checklist.data) : []), [checklist.data]);
  const itemName = (id: string) => allItems.find((i) => i.item_id === id)?.name ?? "Món kho";

  // Review an existing pending paper: fill from what the machine stored.
  useEffect(() => {
    if (action?.kind !== "review" || loadedRef.current || !certs.data) return;
    const c = certs.data.find((x) => x.id === action.certId);
    if (!c) return;
    loadedRef.current = true;
    const ex = (c.extracted ?? {}) as Record<string, unknown>;
    const scanLike = (ex.scan ?? ex) as Partial<ScanFoodCertResult>;
    const d = draftFromScan(scanLike.cert_type ? (scanLike as ScanFoodCertResult) : null, null, c.linked_item_ids ?? []);
    d.certType = c.cert_type;
    // A pending paper without a matched holder is parked under "company"; keep the
    // holder the machine read so the reviewer confirms the real owner.
    const parked = c.owner_kind === "company" && Boolean(d.ownerText);
    if (!parked) { d.ownerKind = c.owner_kind; d.ownerId = c.owner_id; d.ownerText = c.owner_name ?? d.ownerText; }
    d.certNo = c.cert_no ?? d.certNo; d.issuer = c.issuer ?? d.issuer; d.issuedOn = c.issued_on ?? d.issuedOn; d.expiresOn = c.expires_on ?? d.expiresOn;
    d.itemIds = [...new Set([...(c.linked_item_ids ?? []), ...d.itemIds])];
    setDraft(d);
    setFile({ path: c.file_path, name: c.file_name ?? "giay", mime: c.mime_type });
  }, [action, certs.data]);

  useEffect(() => {
    if (!file?.path) return;
    let live = true;
    foodCertFileUrl(file.path).then((u) => { if (live) setPreview(u); }).catch(() => undefined);
    return () => { live = false; };
  }, [file?.path]);

  const pick = async (f: File) => {
    setStage("reading");
    try {
      const up = await uploadFoodCertFile(f);
      setFile({ path: up.file_path, name: up.file_name, mime: up.mime_type });
      let result: ScanFoodCertResult | null = null;
      try {
        result = await scan.mutateAsync({ filePath: up.file_path });
        setReadNote(null);
      } catch {
        setReadNote("Máy chưa đọc được giấy này, anh/chị gõ giúp các ô bên dưới.");
      }
      const d = draftFromScan(result, ctxKind, ctxItems);
      setDraft(d);
      const saved = await pending.mutateAsync({
        certType: d.certType,
        ownerKind: d.ownerId ? d.ownerKind : "company",
        ownerId: d.ownerId,
        certNo: d.certNo || null, issuer: d.issuer || null, issuedOn: d.issuedOn || null, expiresOn: d.expiresOn || null,
        filePath: up.file_path, fileName: up.file_name, mimeType: up.mime_type,
        extracted: result ? { scan: result } : null,
        itemIds: d.itemIds,
      });
      setCertId(saved.id);
      setStage("review");
    } catch {
      toast({ title: "Chưa tải được giấy", description: "Kiểm tra file (PDF hoặc ảnh, tối đa 20 MB) rồi thử lại.", variant: "destructive" });
      setStage("pick");
    }
  };

  const ownerOptions = useMemo(() => (makers.data ?? []).map((m) => ({ id: m.id, name: m.name })), [makers.data]);
  const set = (patch: Partial<Draft>, field?: string) => setDraft((d) => {
    const machine = new Set(d.machine);
    if (field) machine.delete(field);
    return { ...d, ...patch, machine };
  });
  const toggleItem = (id: string) => set({ itemIds: draft.itemIds.includes(id) ? draft.itemIds.filter((x) => x !== id) : [...draft.itemIds, id] });
  const addMatches = addQuery.trim().length >= 2 ? allItems.filter((i) => !draft.itemIds.includes(i.item_id) && searchKey(i.name).includes(searchKey(addQuery))).slice(0, 5) : [];
  const datesOk = !(draft.issuedOn && draft.expiresOn && draft.expiresOn < draft.issuedOn);
  const ownerOk = draft.ownerKind === "company" || Boolean(draft.ownerId) || draft.ownerText.trim().length >= 2;

  const finish = async () => {
    if (!certId || !datesOk || !ownerOk) return;
    setBusy(true);
    try {
      let ownerKind = draft.ownerKind;
      let ownerId = draft.ownerId;
      if (ownerKind !== "company" && !ownerId) {
        const made = await makeMaker.mutateAsync(draft.ownerText.trim());
        ownerKind = "manufacturer"; ownerId = made.id;
      }
      await confirm.mutateAsync({
        certId, certType: draft.certType, ownerKind, ownerId,
        certNo: draft.certNo.trim() || null, issuer: draft.issuer.trim() || null,
        issuedOn: draft.issuedOn || null, expiresOn: draft.expiresOn || null, itemIds: draft.itemIds,
      });
      toast({ title: "Đã hoàn thành giấy", description: draft.itemIds.length ? `Đánh dấu tick cho ${draft.itemIds.length} món.` : undefined });
      onClose();
    } catch {
      toast({ title: "Chưa lưu được", description: "Anh/chị thử lại giúp.", variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const tag = (field: string) => (draft.machine.has(field) ? <em className="d3-attp-auto">máy đọc</em> : null);
  const isImage = (file?.mime ?? "").startsWith("image/");

  return (
    <KhoDialog
      title={stage === "review" ? "Kiểm tra giấy" : "Tải giấy ATTP lên"}
      sub={stage === "review" ? "Máy đã đọc và điền sẵn. So với giấy, đúng thì bấm Hoàn thành." : action?.kind === "upload" ? `${ATTP_KIND_LABELS[action.certKind]} · ${action.itemName}` : "Chụp hoặc chọn file giấy, máy sẽ đọc và điền sẵn"}
      onClose={onClose}
      wide
      data={{ "data-bmq-attp-dialog": stage }}
    >
      {stage !== "review" ? (
        <div className="d3-attp-pick">
          <input ref={fileRef} type="file" accept="application/pdf,image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void pick(f); }} data-bmq-attp-file />
          <Button size="lg" disabled={stage === "reading"} onClick={() => fileRef.current?.click()} data-bmq-attp-pick>
            {stage === "reading" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}
            {stage === "reading" ? "Đang đọc giấy…" : "Chụp hoặc chọn file"}
          </Button>
          <p className="d3-kho-quiet">PDF hoặc ảnh, tối đa 20 MB. Giấy được lưu ở trạng thái chờ kiểm tra ngay khi đọc xong.</p>
        </div>
      ) : (
        <>
          <div className="d3-attp-rv">
            <div className="d3-attp-doc" data-bmq-attp-preview>
              {preview && isImage ? <img src={preview} alt="Ảnh giấy đã tải lên" /> : (
                <a href={preview ?? undefined} target="_blank" rel="noopener noreferrer" className="d3-attp-docfile"><FileText aria-hidden="true" /><span>{file?.name ?? "Đang mở file…"}</span><small>Mở để so</small></a>
              )}
            </div>
            <div className="d3-attp-fields">
              {readNote ? <p className="d3-kho-error">{readNote}</p> : null}
              <label className="d3-kho-field"><span>Loại giấy {tag("type")}</span>
                <select className="d3-attp-select" value={draft.certType} onChange={(e) => set({ certType: e.target.value as FoodCertTypeWithQuarantine }, "type")} data-bmq-attp-type>
                  {TYPES.map((t) => <option key={t} value={t}>{TYPE_LABEL(t)}</option>)}
                </select>
              </label>
              <label className="d3-kho-field"><span>{draft.ownerKind === "supplier" ? "Của nhà cung cấp" : draft.ownerKind === "company" ? "Của công ty" : "Của nhà sản xuất"} {tag("owner")}</span>
                <Input value={draft.ownerText} list="attp-makers" maxLength={160} disabled={draft.ownerKind === "company"} placeholder="Ví dụ: Cty TNHH Interflour Vietnam"
                  onChange={(e) => {
                    const text = e.target.value;
                    const hit = ownerOptions.find((o) => searchKey(o.name) === searchKey(text));
                    set({ ownerText: text, ownerKind: hit ? "manufacturer" : draft.ownerKind === "supplier" ? "manufacturer" : draft.ownerKind, ownerId: hit?.id ?? null }, "owner");
                  }} data-bmq-attp-owner />
                <datalist id="attp-makers">{ownerOptions.map((o) => <option key={o.id} value={o.name} />)}</datalist>
                {draft.ownerKind !== "company" && !draft.ownerId && draft.ownerText.trim().length >= 2 ? <small className="d3-kho-quiet">Nhà sản xuất mới, sẽ được thêm vào danh sách.</small> : null}
                {draft.ownerId && draft.machine.has("owner") ? <small className="d3-kho-quiet">Khớp danh sách {draft.ownerKind === "supplier" ? "nhà cung cấp" : "nhà sản xuất"}.</small> : null}
              </label>
              <div className="d3-cert-grid">
                <label className="d3-kho-field"><span>Số giấy {tag("no")}</span><Input value={draft.certNo} maxLength={80} onChange={(e) => set({ certNo: e.target.value }, "no")} data-bmq-attp-no /></label>
                <label className="d3-kho-field"><span>Cơ quan cấp {tag("issuer")}</span><Input value={draft.issuer} maxLength={160} onChange={(e) => set({ issuer: e.target.value }, "issuer")} /></label>
                <label className="d3-kho-field"><span>Ngày cấp {tag("issued")}</span><Input type="date" value={draft.issuedOn} onChange={(e) => set({ issuedOn: e.target.value }, "issued")} /></label>
                <label className="d3-kho-field"><span>Hết hạn {tag("expires")}</span><Input type="date" value={draft.expiresOn} onChange={(e) => set({ expiresOn: e.target.value }, "expires")} data-bmq-attp-expires /></label>
              </div>
              {!datesOk ? <p className="d3-kho-error">Ngày hết hạn phải sau ngày cấp.</p> : null}
              <div className="d3-attp-applies" data-bmq-attp-items>
                <b>Áp dụng cho {draft.itemIds.length} món</b>
                {draft.itemIds.map((id) => (
                  <label key={id}><input type="checkbox" checked onChange={() => toggleItem(id)} />{itemName(id)}</label>
                ))}
                <Input value={addQuery} onChange={(e) => setAddQuery(e.target.value)} placeholder="Thêm món khác…" className="h-9" data-bmq-attp-add />
                {addMatches.length ? (
                  <div className="d3-attp-addlist">
                    {addMatches.map((i) => <button key={i.item_id} type="button" onClick={() => { toggleItem(i.item_id); setAddQuery(""); }}>+ {i.name}</button>)}
                  </div>
                ) : null}
              </div>
              <p className="d3-kho-quiet">Hoàn thành sẽ đánh dấu tick cho các món trên. Hệ thống nhắc Zalo trước ngày hết hạn 30 ngày.</p>
            </div>
          </div>
          <div className={cn("d3-kho-actions d3-attp-actions")}>
            <Button className="d3-attp-ok" disabled={!certId || busy || !datesOk || !ownerOk} onClick={() => void finish()} data-bmq-attp-confirm>
              <Check className="mr-1.5 h-4 w-4" />{busy ? "Đang lưu…" : "Đúng, hoàn thành"}
            </Button>
            <Button variant="outline" onClick={onClose}>Để sau</Button>
          </div>
        </>
      )}
    </KhoDialog>
  );
}
