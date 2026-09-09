import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { useLanguage } from "@/contexts/LanguageContext";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { readAnalyticsError } from "@/lib/bmqAnalytics";
import { DATA_REQUIRED_FIELDS, DATA_ENTITIES, DATA_FILE_LIMIT, dataSourcesSchema, dataStatusSchema, validateDataFile, type DataSource, type DataStatus } from "@/lib/bmqDataSources";

const enabled = import.meta.env.VITE_BMQ_DATA_PLATFORM_ENABLED === "true";
export default function BmqDataSources() {
  const { language, t } = useLanguage();
  const { isOwner, user } = useAuth();
  const en = language === "en";
  const [sources, setSources] = useState<DataSource[]>([]);
  const [status, setStatus] = useState<DataStatus | null>(null);
  const [kind, setKind] = useState<"dataset" | "document">("dataset");
  const [entity, setEntity] = useState<string>("customers");
  const [source, setSource] = useState("");
  const [title, setTitle] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const generation = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  async function invoke(body: Record<string, unknown>) {
    const { data, error: fault } = await supabase.functions.invoke("bmq-data-sources", { body: { ...body, language }, headers: { "Accept-Language": language } });
    if (fault) throw new Error(await readAnalyticsError(fault, language));
    return data;
  }
  async function load(token: number) {
    const [list, health] = await Promise.all([invoke({ action: "sources" }), invoke({ action: "status" })]);
    const parsedList = dataSourcesSchema.safeParse(list);
    const parsedStatus = dataStatusSchema.safeParse(health);
    if (!parsedList.success || !parsedStatus.success) throw new Error(en ? "Invalid source response. Please retry." : "Phản hồi nguồn dữ liệu chưa hợp lệ. Vui lòng thử lại.");
    if (token === generation.current) { setSources(parsedList.data.sources); setStatus(parsedStatus.data); }
  }
  async function refresh() {
    const token = generation.current;
    setBusy(true); setError("");
    try { await load(token); } catch (err) { if (token === generation.current) setError(err instanceof Error ? err.message : (en ? "Could not load sources." : "Chưa tải được nguồn dữ liệu.")); }
    finally { if (token === generation.current) setBusy(false); }
  }
  useEffect(() => {
    generation.current += 1;
    setSources([]); setStatus(null); setError(""); setNotice(""); setFile(null); setSource(""); setTitle("");
    if (enabled && isOwner && user?.id) void refresh();
    return () => { generation.current += 1; };
    // Changing identity invalidates pending responses; locale changes do not clear an in-progress upload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOwner, user?.id]);
  async function upload(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !file || !isOwner || !enabled) return;
    const token = generation.current;
    setBusy(true); setError(""); setNotice("");
    try {
      validateDataFile(file, kind, language);
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(source)) throw new Error(en ? "Use a source ID of 1–64 lowercase letters, numbers, hyphens or underscores." : "Mã nguồn gồm 1–64 chữ thường, số, dấu gạch ngang hoặc gạch dưới.");
      const content = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
      if (new TextEncoder().encode(content).length > DATA_FILE_LIMIT) throw new Error(en ? "File exceeds 1 MiB." : "File vượt quá 1 MiB.");
      if (token !== generation.current) return;
      const result = await invoke({ action: kind === "dataset" ? "ingest" : "document", source, filename: file.name, content, ...(kind === "dataset" ? { entity } : { title: title.trim() || file.name }) });
      if (token !== generation.current) return;
      if (result?.status !== "success" && result?.status !== "duplicate") throw new Error(en ? "Import was not confirmed. Refresh sources before retrying." : "Chưa xác nhận nạp thành công. Tải lại danh sách nguồn trước khi thử lại.");
      setNotice(result.status === "duplicate" ? (en ? "This content already exists; no duplicate was added." : "Nội dung đã tồn tại; không tạo bản trùng.") : (en ? "Source received. Review its validation status below; only validated data is used for answers." : "Đã nhận nguồn. Kiểm tra trạng thái bên dưới; chỉ dữ liệu đạt kiểm tra được dùng để trả lời."));
      setFile(null); if (fileInput.current) fileInput.current.value = "";
      await load(token);
    } catch (err) {
      if (token === generation.current) setError(err instanceof TypeError ? (en ? "Use a valid UTF-8 text file." : "Vui lòng dùng file văn bản UTF-8 hợp lệ.") : err instanceof Error ? err.message : (en ? "Import failed." : "Nạp dữ liệu thất bại."));
    } finally { if (token === generation.current) setBusy(false); }
  }
  const localPairs = [
    ["Choose a non-empty file up to 1 MiB.", "Chọn file có nội dung, tối đa 1 MiB."],
    ["This file format does not match the selected source type.", "Định dạng file không đúng loại nguồn đã chọn."],
    ["Use a source ID of 1–64 lowercase letters, numbers, hyphens or underscores.", "Mã nguồn gồm 1–64 chữ thường, số, dấu gạch ngang hoặc gạch dưới."],
    ["Use a valid UTF-8 text file.", "Vui lòng dùng file văn bản UTF-8 hợp lệ."],
    ["File exceeds 1 MiB.", "File vượt quá 1 MiB."],
    ["This content already exists; no duplicate was added.", "Nội dung đã tồn tại; không tạo bản trùng."],
    ["Source received. Review its validation status below; only validated data is used for answers.", "Đã nhận nguồn. Kiểm tra trạng thái bên dưới; chỉ dữ liệu đạt kiểm tra được dùng để trả lời."],
  ];
  const localText = (value: string) => { const pair = localPairs.find((pair) => pair.includes(value)); return pair ? pair[en ? 0 : 1] : value; };
  const statusText = (value: string) => ({ validated: en ? "Validated" : "Đạt kiểm tra", ready: en ? "Ready" : "Sẵn sàng", success: en ? "Imported" : "Đã nạp", rejected: en ? "Rejected" : "Bị từ chối", failed: en ? "Failed" : "Lỗi", pending: en ? "Pending validation" : "Chờ kiểm tra", duplicate: en ? "Duplicate" : "Đã tồn tại" }[value] || value);
  const field = "w-full rounded-md border bg-background px-3 py-2 text-sm min-h-11";
  if (!enabled || !isOwner) return <div className="p-6">{en ? "BMQ data sources are not enabled for this account." : "Nguồn dữ liệu BMQ chưa được bật cho tài khoản này."}</div>;
  return <div className="mx-auto max-w-5xl space-y-6" data-bmq-data-sources="v1-owner-ingest">
    <header><h1 className="text-2xl font-bold">{t.dataSources}</h1><p className="mt-2 text-sm text-muted-foreground">{en ? "Import business records and reference documents for BMQ answers. Files are not submitted for model training by this workflow." : "Nạp dữ liệu và tài liệu nghiệp vụ để BMQ tra cứu khi trả lời. Luồng này không đưa file vào huấn luyện model."}</p></header>
    <section className="rounded-xl border p-4 space-y-2" aria-label={en ? "Storage status" : "Trạng thái lưu trữ"}>
      <div className="flex items-center justify-between gap-3"><h2 className="font-semibold">{en ? "Storage & freshness" : "Lưu trữ & độ mới"}</h2><Button variant="outline" onClick={() => void refresh()} disabled={busy}>{en ? "Refresh" : "Tải lại"}</Button></div>
      <p className="text-sm">{status ? `${en ? "Free" : "Còn trống"}: ${(status.storage.free_bytes / 1024 ** 3).toFixed(1)} GiB / ${(status.storage.total_bytes / 1024 ** 3).toFixed(1)} GiB · ${status.knowledge_documents} ${en ? "documents" : "tài liệu"}` : (en ? "Storage has not been verified." : "Chưa xác minh lưu trữ.")}</p>
      {status?.storage.warning && <p className="text-sm text-amber-700" role="status">{status.storage.warning}</p>}
    </section>
    <form onSubmit={upload} className="rounded-xl border p-4 space-y-4">
      <h2 className="font-semibold">{en ? "Add a source" : "Thêm nguồn"}</h2>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="space-y-1 text-sm">{en ? "Content type" : "Loại nội dung"}<select className={field} value={kind} disabled={busy} onChange={(e) => { setKind(e.target.value as typeof kind); setFile(null); if (fileInput.current) fileInput.current.value = ""; }}><option value="dataset">{en ? "Business records (CSV / JSON)" : "Dữ liệu nghiệp vụ (CSV / JSON)"}</option><option value="document">{en ? "Knowledge document (MD / TXT)" : "Tài liệu kiến thức (MD / TXT)"}</option></select></label>
        <label className="space-y-1 text-sm">{en ? "Source ID" : "Mã nguồn"}<Input required maxLength={64} placeholder="bmq-pos" value={source} disabled={busy} onChange={(e) => setSource(e.target.value)} /></label>
        {kind === "dataset" ? <label className="space-y-1 text-sm">{en ? "Entity" : "Nhóm dữ liệu"}<select className={field} value={entity} disabled={busy} onChange={(e) => setEntity(e.target.value)}>{DATA_ENTITIES.map((item) => <option key={item}>{item}</option>)}</select></label> : <label className="space-y-1 text-sm">{en ? "Document title" : "Tên tài liệu"}<Input maxLength={200} value={title} disabled={busy} onChange={(e) => setTitle(e.target.value)} /></label>}
        <label className="space-y-1 text-sm">{en ? "UTF-8 file · up to 1 MiB" : "File UTF-8 · tối đa 1 MiB"}<input ref={fileInput} type="file" className={field} required disabled={busy} accept={kind === "dataset" ? ".csv,.json" : ".md,.txt"} onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></label>
      </div>
      <p className="text-xs text-muted-foreground">{en ? "Use the same source ID for related records. Imports are validated before publication; invalid files are not partially accepted. Historical records must include their original dates." : "Dùng cùng mã nguồn cho các bản ghi liên quan. File được kiểm tra trước khi công bố; không nạp một phần file lỗi. Bản ghi lịch sử phải có ngày gốc."}</p>
      {kind === "dataset" && <details className="rounded-lg bg-muted/50 p-3 text-sm">
        <summary className="cursor-pointer font-medium">{en ? "Required columns & import order" : "Cột bắt buộc & thứ tự nạp"}</summary>
        <code className="mt-2 block break-all">{DATA_REQUIRED_FIELDS[entity as keyof typeof DATA_REQUIRED_FIELDS]}</code>
        <p className="mt-2 text-xs">{en ? "Use CSV headers or JSON array keys. IDs must be stable within the source. Import customers/products/locations before linked orders, items and inventory. Dates use ISO 8601, for example 2026-09-09T08:00:00+07:00. Rejected files remain listed for correction." : "Dùng tên cột CSV hoặc khóa trong mảng JSON. ID phải ổn định trong cùng nguồn. Nạp khách hàng/sản phẩm/địa điểm trước đơn hàng, chi tiết và tồn kho có liên kết. Ngày dùng ISO 8601, ví dụ 2026-09-09T08:00:00+07:00. File bị từ chối vẫn nằm trong danh sách để sửa."}</p>
      </details>}
      <Button type="submit" disabled={busy || !file}>{busy ? (en ? "Processing…" : "Đang xử lý…") : (en ? "Import source" : "Nạp nguồn")}</Button>
    </form>
    {error && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{localText(error)}</div>}
    {notice && <div role="status" className="rounded-lg border p-3 text-sm">{localText(notice)}</div>}
    <section className="space-y-3"><h2 className="font-semibold">{en ? "Source history" : "Lịch sử nguồn"}</h2>{sources.length === 0 && <p className="text-sm text-muted-foreground">{en ? "No sources loaded. Import a file to begin." : "Chưa có nguồn được tải. Nạp file để bắt đầu."}</p>}{sources.map((item) => <article key={item.id} className="rounded-xl border p-4 text-sm space-y-2 break-words">
      <h3 className="font-semibold">{item.filename}</h3><p>{item.source} · {item.entity} · {item.records} {en ? "records" : "bản ghi"}</p><p>{en ? "Status" : "Trạng thái"}: {statusText(item.status)} · {en ? "Imported" : "Đã nạp"}: {new Date(item.ingested_at).toLocaleString(language === "vi" ? "vi-VN" : "en-US")}</p>{item.error && <p className="text-red-700">{item.error}</p>}
    </article>)}</section>
  </div>;
}
