import { useMemo, useState } from "react";
import { Check, ChevronRight, Clock3 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LoadingState } from "@/components/ui/loading";
import { useToast } from "@/hooks/use-toast";
import { useAttpChecklist, useSetAttpProfile } from "@/hooks/useKhoAttp";
import {
  ATTP_KIND_LABELS, ATTP_PROFILE_LABELS, filterByState, flattenByItem,
  type AttpChecklistItem, type AttpKind, type AttpProfile, type AttpRequirement, type AttpStateFilter, type AttpTotals,
} from "@/lib/kho-attp";
import { cn } from "@/lib/utils";

/** What a requirement row asks the page to open. */
export type AttpAction =
  | { kind: "upload"; certKind: AttpKind; itemId: string; itemName: string; supplierId?: string | null }
  | { kind: "review"; certId: string };

const KIND_ORDER: AttpKind[] = ["attp_facility", "product_declaration", "coa", "quarantine"];
const STATE_LABEL = { ok: "Hoàn thành", warn: "Sắp hết hạn", wait: "Chờ kiểm tra", miss: "Còn thiếu", na: "Không cần" } as const;
const PROFILES = Object.keys(ATTP_PROFILE_LABELS) as AttpProfile[];
const dmy = (iso?: string | null) => (iso ? iso.slice(0, 10).split("-").reverse().join("/") : "");

function Mark({ state }: { state: AttpRequirement["state"] }) {
  if (state === "ok" || state === "warn") return <span className={cn("d3-attp-mk", state === "ok" ? "is-ok" : "is-warn")} aria-hidden="true"><Check /></span>;
  if (state === "wait") return <span className="d3-attp-mk is-wait" aria-hidden="true"><Clock3 /></span>;
  return <span className="d3-attp-mk is-miss" aria-hidden="true" />;
}

function reqNote(r: AttpRequirement): string | null {
  if (r.state === "warn") return r.days_left !== null ? `hết hạn sau ${r.days_left} ngày` : "sắp hết hạn";
  if (r.state === "ok") {
    const parts = [r.cert_no ? `Số ${r.cert_no}` : null, r.expires_on ? `hạn ${dmy(r.expires_on)}` : null, r.shared_count > 1 ? `dùng chung ${r.shared_count} món` : null].filter(Boolean);
    return parts.join(" · ") || null;
  }
  if (r.state === "wait") {
    const exp = r.extracted && typeof r.extracted.expires_on === "string" ? r.extracted.expires_on : null;
    return exp ? `máy đọc: hạn ${dmy(exp)}` : "máy đã đọc, chờ xác nhận";
  }
  if (r.state === "miss" && r.expired_cert) return `giấy cũ hết hạn ${dmy(r.expired_cert.expires_on)}`;
  return null;
}

function Pct({ t }: { t: AttpTotals }) {
  return (
    <span className={cn("d3-attp-pct", t.total > 0 && t.pct === 100 && "is-full")}>
      {t.total ? `${t.pct}%` : "—"}
      <span className="d3-attp-mini"><i style={{ width: `${t.total ? t.pct : 0}%` }} /></span>
    </span>
  );
}

function ReqAction({ r, item, supplierId, canEdit, onAction, compact }: {
  r: AttpRequirement; item: AttpChecklistItem; supplierId?: string | null; canEdit: boolean; onAction: (a: AttpAction) => void; compact?: boolean;
}) {
  if (!canEdit) return null;
  const upload = () => onAction({ kind: "upload", certKind: r.kind, itemId: item.item_id, itemName: item.name, supplierId });
  if (r.state === "wait" && r.cert_id) return <Button size="sm" className="d3-attp-go" onClick={() => onAction({ kind: "review", certId: r.cert_id! })} data-bmq-attp-review={r.cert_id}>Kiểm tra</Button>;
  if (r.state === "miss") return <Button size="sm" variant="outline" className="d3-attp-go" onClick={upload} data-bmq-attp-upload={`${item.item_id}:${r.kind}`}>Tải lên</Button>;
  if (r.state === "warn" && !compact) return <Button size="sm" variant="outline" className="d3-attp-go" onClick={upload}>Tải giấy mới</Button>;
  return null;
}

function ProfilePick({ item, canEdit }: { item: AttpChecklistItem; canEdit: boolean }) {
  const { toast } = useToast();
  const setProfile = useSetAttpProfile();
  if (!canEdit) return <small>{ATTP_PROFILE_LABELS[item.profile]}</small>;
  return (
    <label className="d3-attp-profile">
      <span className="sr-only">Nhóm hồ sơ của {item.name}</span>
      <select
        value={item.profile}
        disabled={setProfile.isPending}
        onChange={(e) => setProfile.mutate({ itemId: item.item_id, profile: e.target.value as AttpProfile }, {
          onSuccess: () => toast({ title: `Đã đổi nhóm hồ sơ: ${ATTP_PROFILE_LABELS[e.target.value as AttpProfile]}` }),
          onError: () => toast({ title: "Chưa đổi được nhóm hồ sơ", variant: "destructive" }),
        })}
        data-bmq-attp-profile={item.item_id}
      >
        {PROFILES.map((p) => <option key={p} value={p}>{ATTP_PROFILE_LABELS[p]}</option>)}
      </select>
    </label>
  );
}

type Group = { id: string; name: string; totals: AttpTotals; items: AttpChecklistItem[] };

/**
 * Checklist hồ sơ ATTP (owner 24/10, approved demo): progress across every paper the
 * kho needs, grouped by supplier or by item; each paper is missing, waiting for a
 * human check, done, or about to expire.
 */
export function AttpChecklist({ canEdit, onAction }: { canEdit: boolean; onAction: (a: AttpAction) => void }) {
  const checklist = useAttpChecklist(180);
  const [by, setBy] = useState<"supplier" | "item">("supplier");
  const [filter, setFilter] = useState<AttpStateFilter>("all");
  const [picked, setPicked] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const data = checklist.data;
  const shown = useMemo(() => (data ? filterByState(data, filter) : null), [data, filter]);
  const groups: Group[] = useMemo(() => {
    if (!shown) return [];
    if (by === "supplier") return shown.suppliers.map((s) => ({ id: s.supplier_id, name: s.name, totals: s.totals, items: s.items }));
    return flattenByItem(shown).map((i) => ({ id: i.item_id, name: i.name, totals: i.totals, items: [i] }));
  }, [shown, by]);
  const current = groups.find((g) => g.id === picked) ?? groups[0] ?? null;
  const openId = open === null ? groups[0]?.id ?? null : open;

  if (checklist.isLoading) return <LoadingState label="Đang dựng checklist" />;
  if (checklist.isError || !data) {
    return (
      <div className="d3-kho-failed" role="alert">
        <p>Không tải được checklist hồ sơ.</p>
        <Button variant="outline" onClick={() => void checklist.refetch()}>Thử lại</Button>
      </div>
    );
  }

  const t = data.totals;
  const w = (n: number) => `${t.total ? (n * 100) / t.total : 0}%`;
  const kindsOf = (items: AttpChecklistItem[]) => KIND_ORDER.filter((k) => items.some((i) => i.requirements.some((r) => r.kind === k && r.state !== "na")));
  const reqOf = (item: AttpChecklistItem, k: AttpKind) => item.requirements.find((r) => r.kind === k) ?? null;

  return (
    <div className="d3-attp" data-bmq-attp>
      <section className="d3-wh-card d3-attp-sum" data-bmq-attp-sum>
        <div className="d3-attp-big"><b data-bmq-attp-pct>{t.pct}%</b><span>hồ sơ đã đủ<br />{t.done} / {t.total} giấy</span></div>
        <p className="d3-attp-next">
          {t.wait ? <>Việc tiếp theo: <b>{t.wait} giấy chờ kiểm tra</b><br /></> : t.miss ? <>Việc tiếp theo: <b>tải {t.miss} giấy còn thiếu</b><br /></> : <><b>Đã đủ hồ sơ</b><br /></>}
          {t.warn} giấy sắp hết hạn · {t.miss} giấy còn thiếu
        </p>
        <div className="d3-attp-bar" aria-hidden="true"><i className="is-ok" style={{ width: w(t.ok) }} /><i className="is-warn" style={{ width: w(t.warn) }} /><i className="is-wait" style={{ width: w(t.wait) }} /></div>
        <div className="d3-attp-legend">
          <span><i className="is-ok" />Hoàn thành {t.ok}</span><span><i className="is-warn" />Sắp hết hạn {t.warn}</span>
          <span><i className="is-wait" />Chờ kiểm tra {t.wait}</span><span><i />Còn thiếu {t.miss}</span>
        </div>
      </section>

      <div className="d3-attp-tools">
        <div className="d3-kho-seg" role="tablist" aria-label="Xem theo">
          {([["supplier", "Theo nhà cung cấp"], ["item", "Theo món kho"]] as const).map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={by === id} className={cn(by === id && "is-on")} onClick={() => { setBy(id); setPicked(null); setOpen(null); }} data-bmq-attp-by={id}>{label}</button>
          ))}
        </div>
        <div className="d3-attp-chips" role="group" aria-label="Lọc trạng thái">
          {([["all", "Tất cả", t.total], ["miss", "Còn thiếu", t.miss], ["wait", "Chờ kiểm tra", t.wait], ["warn", "Sắp hết hạn", t.warn]] as const).map(([id, label, n]) => (
            <button key={id} type="button" aria-pressed={filter === id} className={cn(filter === id && "is-on")} onClick={() => { setFilter(id); setPicked(null); setOpen(null); }} data-bmq-attp-filter={id}>{label}<small>{n}</small></button>
          ))}
        </div>
      </div>

      {groups.length === 0 ? (
        <p className="d3-kho-empty" data-bmq-attp-empty>{filter === "all" ? "Chưa có hàng nhập nào trong 6 tháng qua cần hồ sơ." : "Không còn giấy nào ở trạng thái này."}</p>
      ) : (
        <>
          <div className="d3-attp-md">
            <div className="d3-attp-list" role="list">
              {groups.map((g) => (
                <button key={g.id} type="button" role="listitem" className={cn("d3-attp-sup", current?.id === g.id && "is-on")} onClick={() => setPicked(g.id)} data-bmq-attp-group={g.id}>
                  <b>{g.name}</b>
                  <small>{by === "supplier" ? `${g.items.length} món · ` : ""}{g.totals.done}/{g.totals.total} giấy{g.totals.wait ? ` · ${g.totals.wait} chờ kiểm tra` : ""}</small>
                  <Pct t={g.totals} />
                </button>
              ))}
            </div>
            {current ? (
              <section className="d3-wh-card d3-attp-detail" data-bmq-attp-detail={current.id}>
                <div className="d3-attp-dh"><h2>{current.name}</h2><p>{current.items.length} món · {current.totals.done}/{current.totals.total} giấy · {current.totals.pct}%</p></div>
                <table className="d3-attp-table">
                  <thead><tr><th>Món trên kho</th>{kindsOf(current.items).map((k) => <th key={k}>{ATTP_KIND_LABELS[k]}</th>)}</tr></thead>
                  <tbody>
                    {current.items.map((item) => (
                      <tr key={`${item.item_id}-${item.supplier_id ?? ""}`} data-bmq-attp-row={item.item_id}>
                        <td className="d3-attp-item"><b>{item.name}</b><small>{item.manufacturer_name ? `Nhà SX: ${item.manufacturer_name}` : by === "item" && item.supplier_name ? `NCC: ${item.supplier_name}` : "Chưa rõ nhà sản xuất"}</small><ProfilePick item={item} canEdit={canEdit} /></td>
                        {kindsOf(current.items).map((k) => {
                          const r = reqOf(item, k);
                          if (!r || r.state === "na") return <td key={k}><span className="d3-attp-na">Không cần</span></td>;
                          const note = reqNote(r);
                          return (
                            <td key={k}>
                              <div className="d3-attp-cell" data-bmq-attp-state={r.state}>
                                <Mark state={r.state} /><span className="t">{STATE_LABEL[r.state]}</span>
                                {note ? <span className={cn("s", r.state === "warn" && "is-warn")}>{note}</span> : null}
                                <ReqAction r={r} item={item} supplierId={item.supplier_id} canEdit={canEdit} onAction={onAction} />
                              </div>
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            ) : null}
          </div>

          <div className="d3-attp-tree">
            {groups.map((g) => {
              const isOpen = openId === g.id;
              return (
                <div key={g.id} className={cn("d3-attp-node", isOpen && "is-open")} data-bmq-attp-node={g.id}>
                  <button type="button" className="d3-attp-nh" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? "" : g.id)}>
                    <b>{g.name}</b>
                    <small>{by === "supplier" ? `${g.items.length} món · ` : ""}{g.totals.done}/{g.totals.total} giấy</small>
                    <Pct t={g.totals} />
                    <ChevronRight className="d3-attp-chev" aria-hidden="true" />
                  </button>
                  {isOpen ? (
                    <div className="d3-attp-items">
                      {g.items.map((item) => (
                        <div key={`${item.item_id}-${item.supplier_id ?? ""}`} className="d3-attp-it">
                          {by === "supplier" ? <b>{item.name}</b> : null}
                          <small>{item.manufacturer_name ? `Nhà SX: ${item.manufacturer_name}` : "Chưa rõ nhà sản xuất"}</small>
                          <ProfilePick item={item} canEdit={canEdit} />
                          <div className="d3-attp-reqs">
                            {item.requirements.filter((r) => r.state !== "na").map((r) => {
                              const note = reqNote(r);
                              return (
                                <div key={r.kind} className="d3-attp-req" data-bmq-attp-state={r.state}>
                                  <Mark state={r.state} />
                                  <span className="t">{ATTP_KIND_LABELS[r.kind]}</span>
                                  <span className={cn("s", r.state === "warn" && "is-warn")}>{STATE_LABEL[r.state]}{note ? ` · ${note}` : ""}</span>
                                  <ReqAction r={r} item={item} supplierId={item.supplier_id} canEdit={canEdit} onAction={onAction} compact />
                                </div>
                              );
                            })}
                            {item.requirements.every((r) => r.state === "na") ? <span className="d3-attp-na">Không cần hồ sơ</span> : null}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
