/* Chi lương tiền mặt (owner + quyền Chi lương): the CEO uploads the transfer slip to the chief
 * accountant, then the chief accountant uploads one bank slip per employee; the app matches
 * slips to payslip lines by amount (equal amounts by name) and the payout completes when every
 * employee is covered. Amounts are only shown here, never in the Zalo notices.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Check, ChevronLeft, ImagePlus, Loader2, Trash2, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/contexts/AuthContext";
import { fileToJpegBase64 } from "@/components/payment-requests/UncApprovalDialog";
import { getUncEvidenceSignedUrl } from "@/hooks/usePaymentRequestUncEvidence";
import { useSalaryPayout, type SalaryPayoutCeoEvidence } from "@/hooks/useSalaryPayout";
import { SalaryAttachmentsCard } from "@/components/payment-requests/SalaryAttachments";
import { matchSalaryPayout } from "@/lib/salary-payout-match";
import { cn } from "@/lib/utils";
import "@/styles/bmq-urgent-payables.css";
import "@/styles/bmq-unc-approval.css";
import "@/styles/bmq-unc-bulk.css";
import "@/styles/bmq-cash-settlement.css";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const vnd = (value: number | null | undefined) =>
  value === null || value === undefined ? "—" : `${new Intl.NumberFormat("vi-VN").format(Math.round(Number(value)))} đ`;

const STATUS: Record<string, { label: string; tone: string }> = {
  pending: { label: "Chờ CEO chuyển tiền", tone: "is-amber" },
  advanced: { label: "Chờ bank slip nhân viên", tone: "is-blue" },
  completed: { label: "Đã chi lương xong", tone: "is-green" },
  cancelled: { label: "Đã huỷ", tone: "" },
};

const ERROR_TEXT: Record<string, string> = {
  insufficient_privilege: "Anh/chị chưa có quyền Chi lương.",
  not_owner: "Chỉ CEO (owner) được xác nhận chuyển tiền.",
  not_allowed: "Anh/chị chưa có quyền Chi lương.",
  evidence_reused: "Ảnh chuyển khoản này đã được dùng trước đó.",
  amount_mismatch: "Số tiền trên bank slip không khớp lương của nhân viên.",
  line_already_matched: "Nhân viên này đã có bank slip.",
  receipt_not_uploaded: "Bank slip đã được ghép hoặc đã bỏ. Tải lại trang.",
  not_advanced: "CEO chưa xác nhận chuyển tiền.",
  not_pending: "Phiếu đã được CEO xác nhận trước đó.",
  image_too_large: "Ảnh quá lớn. Chụp lại hoặc chọn ảnh nhỏ hơn.",
};
const errorText = (err: unknown) => {
  const message = err instanceof Error ? err.message : String((err as { message?: unknown; code?: unknown })?.message ?? (err as { code?: unknown })?.code ?? "");
  const code = Object.keys(ERROR_TEXT).find((k) => message.includes(k));
  return code ? ERROR_TEXT[code] : message || "Chưa lưu được. Thử lại.";
};

function Thumb({ path, onOpen }: { path: string | null; onOpen: (url: string) => void }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    if (path) void getUncEvidenceSignedUrl(path).then((u) => alive && setUrl(u));
    return () => {
      alive = false;
    };
  }, [path]);
  return url ? (
    <button type="button" className="d3-cs-thumb" onClick={() => onOpen(url)} aria-label="Xem ảnh">
      <img src={url} alt="Bank slip" loading="lazy" />
    </button>
  ) : (
    <span className="d3-cs-thumb is-empty" />
  );
}

export default function SalaryPayout() {
  const { id } = useParams<{ id: string }>();
  const payoutId = id && UUID_RE.test(id) ? id : null;
  const { isOwner, canEditModule } = useAuth();
  const canEdit = isOwner || canEditModule("salary_cash");
  const { data, isLoading, error, ceoExtract, recordCeoPayment, extractReceipts, discard, submitMatches } = useSalaryPayout(payoutId);
  const [zoom, setZoom] = useState<string | null>(null);
  const [ceoEvidence, setCeoEvidence] = useState<(SalaryPayoutCeoEvidence & { preview: string }) | null>(null);
  const [busy, setBusy] = useState<"" | "ceo-read" | "ceo-save" | "receipts" | "submit">("");
  const [manualLine, setManualLine] = useState<Record<string, string>>({});
  const [manualAmount, setManualAmount] = useState<Record<string, string>>({});
  const ceoFileRef = useRef<HTMLInputElement>(null);
  const slipFileRef = useRef<HTMLInputElement>(null);

  const payout = data?.payout;
  const lines = useMemo(() => data?.lines ?? [], [data]);
  const openReceipts = useMemo(() => (data?.receipts ?? []).filter((r) => r.status === "uploaded"), [data]);
  const matchedCount = lines.filter((l) => !!l.receipt_storage_path).length;

  const match = useMemo(
    () =>
      matchSalaryPayout(
        lines.map((l) => ({ id: l.id, employee_name: l.employee_name, net_pay: Number(l.net_pay), matched: !!l.receipt_storage_path })),
        openReceipts.map((r) => ({ id: r.id, amount: r.ocr_amount, beneficiary: r.ocr_beneficiary })),
      ),
    [lines, openReceipts],
  );

  const pendingMatches = useMemo(() => {
    const auto = match.proposals.map((p) => ({ receipt_id: p.receipt_id, line_id: p.line_id }));
    const usedLines = new Set(auto.map((m) => m.line_id));
    const manual: { receipt_id: string; line_id: string; amount?: number }[] = [];
    for (const r of openReceipts) {
      if (auto.some((m) => m.receipt_id === r.id)) continue;
      const lineId = manualLine[r.id];
      if (!lineId || usedLines.has(lineId)) continue;
      const line = lines.find((l) => l.id === lineId);
      const amount = r.ocr_amount ?? Number(manualAmount[r.id] || 0);
      if (!line || Number(amount) !== Number(line.net_pay)) continue;
      usedLines.add(lineId);
      manual.push(r.ocr_amount ? { receipt_id: r.id, line_id: lineId } : { receipt_id: r.id, line_id: lineId, amount: Number(amount) });
    }
    return [...auto, ...manual];
  }, [match, openReceipts, manualLine, manualAmount, lines]);

  const lineFor = (receiptId: string) => pendingMatches.find((m) => m.receipt_id === receiptId)?.line_id;

  const pickCeoSlip = async (list: FileList | null) => {
    const file = list?.[0];
    if (!file) return;
    setBusy("ceo-read");
    try {
      const image = await fileToJpegBase64(file);
      const evidence = await ceoExtract(image.base64, image.mime);
      setCeoEvidence({ ...evidence, preview: image.preview });
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setBusy("");
    }
  };

  const confirmCeo = async () => {
    if (!payout || !ceoEvidence) return;
    setBusy("ceo-save");
    try {
      await recordCeoPayment(payout.id, ceoEvidence);
      toast.success("Đã xác nhận chuyển tiền chi lương. Nhóm Zalo đã được báo.");
      setCeoEvidence(null);
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setBusy("");
    }
  };

  const pickSlips = async (list: FileList | null) => {
    if (!payout) return;
    const files = Array.from(list ?? []).filter((f) => f.type.startsWith("image/") || f.type === "");
    if (!files.length) return;
    setBusy("receipts");
    try {
      const images = await Promise.all(files.map((f) => fileToJpegBase64(f)));
      const results = await extractReceipts(payout.id, images.map((i) => ({ image_base64: i.base64, mime_type: i.mime })));
      const failed = results.filter((r) => !r.ok);
      if (failed.length) toast.error(`${failed.length} ảnh chưa tải lên được: ${ERROR_TEXT[failed[0].errorCode ?? ""] ?? "thử lại sau"}.`);
    } finally {
      setBusy("");
    }
  };

  const submit = async () => {
    if (!payout || pendingMatches.length === 0) return;
    setBusy("submit");
    try {
      const result = await submitMatches(payout.id, pendingMatches);
      setManualLine({});
      setManualAmount({});
      toast.success(result.status === "completed" ? "Đã chi lương xong. Nhóm Zalo đã được báo." : `Đã ghép ${pendingMatches.length} bank slip.`);
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setBusy("");
    }
  };

  const st = STATUS[payout?.status ?? ""] ?? { label: payout?.status ?? "", tone: "" };

  return (
    <div className="d3-ps d3-csp min-w-0 pb-24" data-bmq-salary-page>
      <Link to="/payment-requests" className="d3-ps-back"><ChevronLeft className="h-4 w-4" /> Duyệt chi</Link>
      {!payoutId ? (
        <p className="d3-up-state is-bad" role="alert"><TriangleAlert className="h-4 w-4" /> Link không hợp lệ.</p>
      ) : isLoading ? (
        <p className="d3-up-state"><Loader2 className="h-4 w-4 animate-spin" /> Đang tải phiếu chi lương…</p>
      ) : error || !payout ? (
        <p className="d3-up-state is-bad" role="alert" data-bmq-salary-denied>
          <TriangleAlert className="h-4 w-4" /> Không xem được phiếu chi lương. Cần quyền Chi lương hoặc owner.
        </p>
      ) : (
        <>
          <header className="d3-csp-head">
            <span className="d3-up-tag">{payout.source === "manual" ? "Lương lẻ" : "Chi lương"} · {payout.period_name}</span>
            <h1>{payout.payout_number}</h1>
            <p>
              {payout.employee_count} nhân viên · <b data-bmq-salary-total>{vnd(payout.total_amount)}</b>
            </p>
          </header>

          {/* CEO transfer */}
          <section className="d3-csp-card d3-cs" aria-label="CEO chuyển tiền">
            <div className="d3-cs-head">
              <h3>CEO chuyển tiền cho kế toán</h3>
              <span className={cn("d3-up-chip", st.tone)} data-bmq-salary-status={payout.status}>{st.label}</span>
            </div>
            {payout.ceo_evidence_storage_path ? (
              <div className="d3-csp-docs">
                <Thumb path={payout.ceo_evidence_storage_path} onOpen={setZoom} />
              </div>
            ) : payout.status === "pending" && isOwner ? (
              <>
                <input ref={ceoFileRef} type="file" accept="image/*" className="sr-only" data-bmq-salary-ceo-file onChange={(e) => { void pickCeoSlip(e.target.files); e.currentTarget.value = ""; }} />
                {ceoEvidence ? (
                  <div className="d3-cs-receipts">
                    <div className="d3-salary-ceo">
                      <img src={ceoEvidence.preview} alt="Ảnh chuyển khoản" className="d3-cs-thumb" />
                      <div className="d3-cs-r-body">
                        <span className="d3-ub-amt">{vnd(ceoEvidence.ocr_amount)}</span>
                        {ceoEvidence.ocr_amount !== null && Number(ceoEvidence.ocr_amount) !== Number(payout.total_amount) ? (
                          <small className="is-bad">Khác tổng lương {vnd(payout.total_amount)}. Kiểm tra lại trước khi xác nhận.</small>
                        ) : ceoEvidence.ocr_amount !== null ? (
                          <small className="is-ok">Khớp tổng lương.</small>
                        ) : (
                          <small>Chưa đọc được số tiền.</small>
                        )}
                      </div>
                    </div>
                    <div className="d3-cpr-line-row">
                      <Button variant="outline" className="h-11" onClick={() => setCeoEvidence(null)} disabled={!!busy}>Chọn ảnh khác</Button>
                      <Button className="d3-ub-go h-11" onClick={() => void confirmCeo()} disabled={!!busy} data-bmq-salary-ceo-confirm>
                        {busy === "ceo-save" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Xác nhận đã chuyển
                      </Button>
                    </div>
                  </div>
                ) : (
                  <button type="button" className="d3-unc-drop" onClick={() => ceoFileRef.current?.click()} disabled={!!busy} data-bmq-salary-ceo-pick>
                    {busy === "ceo-read" ? <Loader2 className="h-6 w-6 animate-spin" /> : <ImagePlus className="h-6 w-6" />}
                    <span>{busy === "ceo-read" ? "Đang đọc ảnh…" : "Up ảnh chuyển khoản cho kế toán"}</span>
                    <small>Tổng cần chuyển {vnd(payout.total_amount)}</small>
                  </button>
                )}
              </>
            ) : (
              <p className="d3-unc-ev-note">{payout.status === "pending" ? "Chờ CEO chuyển tiền và up ảnh chuyển khoản." : "Chưa có ảnh chuyển khoản."}</p>
            )}
          </section>

          {/* Employees */}
          <section className="d3-csp-card d3-cs" aria-label="Nhân viên">
            <div className="d3-cs-head">
              <h3>Nhân viên · {matchedCount}/{lines.length} đã có bank slip</h3>
            </div>
            <div className="d3-cs-bar"><span style={{ width: `${lines.length ? (matchedCount / lines.length) * 100 : 0}%` }} /></div>
            <ul className="d3-cs-items">
              {lines.map((l) => {
                const done = !!l.receipt_storage_path;
                return (
                  <li key={l.id} className={cn(done && "is-done")} data-bmq-salary-line={done ? "done" : "open"}>
                    <div className="d3-cs-item-top">
                      <span className="d3-cs-tick">{done && <Check className="h-3.5 w-3.5" />}</span>
                      <b>{l.employee_name}</b>
                      <span className="d3-cs-amt">{vnd(l.net_pay)}</span>
                    </div>
                    {l.note && <small className="d3-cs-left d3-salary-note">{l.note}</small>}
                    {done && (
                      <div className="d3-cs-strip">
                        <figure>
                          <Thumb path={l.receipt_storage_path} onOpen={setZoom} />
                          <figcaption>{l.receipt_beneficiary || l.employee_code}</figcaption>
                        </figure>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>

            {payout.status === "advanced" && canEdit && (
              <>
                <input ref={slipFileRef} type="file" accept="image/*" multiple className="sr-only" data-bmq-salary-slip-file onChange={(e) => { void pickSlips(e.target.files); e.currentTarget.value = ""; }} />
                <button type="button" className="d3-unc-drop d3-cs-drop" onClick={() => slipFileRef.current?.click()} disabled={!!busy} data-bmq-salary-slip-pick>
                  {busy === "receipts" ? <Loader2 className="h-6 w-6 animate-spin" /> : <ImagePlus className="h-6 w-6" />}
                  <span>{busy === "receipts" ? "Đang đọc bank slip…" : "Up bank slip trả lương"}</span>
                  <small>Chọn tất cả ảnh một lần · mỗi nhân viên một bank slip</small>
                </button>
              </>
            )}
            {payout.status === "pending" && !isOwner && (
              <p className="d3-unc-ev-note">Khi CEO xác nhận chuyển tiền, kế toán up bank slip trả lương tại đây.</p>
            )}

            {openReceipts.length > 0 && (
              <ul className="d3-cs-receipts" aria-label="Bank slip chưa ghép">
                {openReceipts.map((r) => {
                  const lineId = lineFor(r.id);
                  const line = lines.find((l) => l.id === lineId);
                  const auto = match.proposals.some((p) => p.receipt_id === r.id);
                  return (
                    <li key={r.id} className={cn(line && "is-on")} data-bmq-salary-receipt={line ? (auto ? "auto" : "manual") : "open"}>
                      <Thumb path={r.storage_path} onOpen={setZoom} />
                      <div className="d3-cs-r-body">
                        <span className="d3-ub-amt">{vnd(r.ocr_amount ?? (manualAmount[r.id] ? Number(manualAmount[r.id]) : null))}</span>
                        {r.ocr_beneficiary && <small>{r.ocr_beneficiary}</small>}
                        {r.ocr_amount === null && manualAmount[r.id] && <small>Số tiền nhập tay</small>}
                        {line ? (
                          <p className="d3-ub-why is-ok"><Check className="h-3.5 w-3.5" /> {line.employee_name}</p>
                        ) : canEdit ? (
                          <div className="d3-cs-manual">
                            {r.ocr_amount === null && (
                              <Input inputMode="numeric" placeholder="Số tiền" aria-label="Số tiền trên bank slip" value={manualAmount[r.id] ? new Intl.NumberFormat("vi-VN").format(Number(manualAmount[r.id])) : ""} onChange={(e) => setManualAmount((m) => ({ ...m, [r.id]: e.target.value.replace(/[^\d]/g, "") }))} />
                            )}
                            <select className="d3-cs-select" value={manualLine[r.id] ?? ""} onChange={(e) => setManualLine((m) => ({ ...m, [r.id]: e.target.value }))} aria-label="Ghép với nhân viên" data-bmq-salary-assign>
                              <option value="">Ghép với nhân viên…</option>
                              {lines.filter((l) => !l.receipt_storage_path).map((l) => (
                                <option key={l.id} value={l.id}>{`${l.employee_name} · ${vnd(l.net_pay)}`}</option>
                              ))}
                            </select>
                            {manualLine[r.id] && <small className="is-bad">Số tiền phải đúng bằng lương của nhân viên đã chọn.</small>}
                          </div>
                        ) : null}
                      </div>
                      {canEdit && (
                        <button type="button" className="d3-cs-x" aria-label="Bỏ bank slip" onClick={() => void discard(r.id)} disabled={!!busy}>
                          <Trash2 className="h-4 w-4" />
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}

            {canEdit && openReceipts.length > 0 && (
              <div className="d3-cs-foot">
                <p>
                  Sau khi ghép: <b>{matchedCount + pendingMatches.length}</b>/{lines.length} nhân viên
                  {matchedCount + pendingMatches.length >= lines.length && lines.length > 0 && <> · <b className="is-ok">đủ, sẽ hoàn tất</b></>}
                </p>
                <Button className="d3-ub-go" disabled={!!busy || pendingMatches.length === 0} onClick={() => void submit()} data-bmq-salary-submit>
                  {busy === "submit" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                  Xác nhận ghép ({pendingMatches.length})
                </Button>
              </div>
            )}
          </section>

          <SalaryAttachmentsCard
            payoutId={payout.id}
            attachments={data?.attachments ?? []}
            canAdd={canEdit && payout.status !== "completed" && payout.status !== "cancelled"}
            onOpenImage={setZoom}
          />
        </>
      )}

      <Dialog open={!!zoom} onOpenChange={(o) => !o && setZoom(null)}>
        <DialogContent className="d3-unc-ev-zoom">
          <DialogTitle className="sr-only">Ảnh</DialogTitle>
          {zoom && <img src={zoom} alt="Ảnh" />}
        </DialogContent>
      </Dialog>
    </div>
  );
}
