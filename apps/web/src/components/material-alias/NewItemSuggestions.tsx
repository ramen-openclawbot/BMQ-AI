import { useEffect, useMemo, useRef, useState } from "react";
import { OptionPicker } from "@/components/OptionPicker";
import { useQueryClient } from "@tanstack/react-query";
import { Plus, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import {
  useApplyNewItemSuggestion,
  useDismissNewItemSuggestion,
  useNewItemSuggestions,
  useLatestNewItemRun,
  useRunNewItemScan,
  MATERIAL_ALIAS_BACKLOG_REVIEW_QUERY_KEY,
  MATERIAL_ALIAS_NEW_ITEM_QUERY_KEY,
  type MaterialAliasLocation,
} from "@/hooks/useMaterialAlias";
import type { NewItemSuggestion, NewItemSuggestionClass } from "@/lib/material-alias";
import { packFactorFor, unitFactor } from "./new-stock-item";
import { CrateDocEvidence } from "@/components/DocEvidence";
import "@/styles/bmq-material-alias.css";

const CLASS_LABELS: Record<NewItemSuggestionClass, string> = {
  raw_material: "Nguyên liệu",
  packaging_supply: "Bao bì / vật tư",
  non_stock: "Không tồn kho",
};

const pct = (value: number) => `${Math.round(value * 100)}%`;

const shortDate = (iso: string | null | undefined) => {
  if (!iso) return "";
  const [y, m, d] = iso.slice(0, 10).split("-");
  return d && m && y ? `${d}/${m}` : iso;
};

const errorText = (error: unknown) => {
  const message = String((error as { message?: string })?.message ?? error);
  if (message.includes("forbidden") || message.includes("insufficient_privilege")) return "Chỉ chủ hoặc người có quyền sửa kho Q7 làm được việc này.";
  if (message.includes("daily") || message.includes("quota")) return "Đã hết hạn mức gọi Sushi hôm nay.";
  if (message.includes("kill")) return "Sushi đang bị tắt bằng công tắc khẩn.";
  if (message.includes("member_not_in_suggestion")) return "Nhóm đã thay đổi, bấm phân loại lại.";
  return message;
};

interface MemberDraft {
  label: string;
  factor: string;
}

function memberDefaults(group: NewItemSuggestion, unit: string): MemberDraft[] {
  return group.members.map((member) => {
    const pack = packFactorFor(member.raw_name, unit);
    if (pack) return { label: pack.label, factor: String(pack.factor) };
    // Invoice unit → stock unit when they convert (kg → g); otherwise ask.
    const label = member.raw_unit ?? unit;
    const factor = unitFactor(label, unit);
    return { label, factor: factor === null ? "" : String(factor) };
  });
}

function GroupRow({ group, onDone, location }: { group: NewItemSuggestion; onDone: () => void; location: MaterialAliasLocation }) {
  const { toast } = useToast();
  const apply = useApplyNewItemSuggestion();
  const dismiss = useDismissNewItemSuggestion();
  const [requestId] = useState(() => crypto.randomUUID());
  const [name, setName] = useState(group.suggested_name);
  const [unit, setUnit] = useState(group.suggested_unit ?? "cái");
  const [itemClass, setItemClass] = useState<NewItemSuggestionClass | "">(group.suggested_class ?? "");
  const [drafts, setDrafts] = useState<MemberDraft[] | null>(null);
  const members = drafts ?? memberDefaults(group, unit.trim());
  const nonStock = itemClass === "non_stock";
  const factorsOk = members.every((member) => Number(member.factor.replace(",", ".")) > 0);
  const ready = itemClass !== "" && (nonStock || (name.trim().length >= 2 && unit.trim().length > 0 && factorsOk));
  const busy = apply.isPending || dismiss.isPending;

  const setMember = (index: number, patch: Partial<MemberDraft>) =>
    setDrafts(members.map((member, i) => (i === index ? { ...member, ...patch } : member)));

  const save = () => {
    if (!ready || !itemClass) return;
    apply.mutate(
      {
        suggestionId: group.id,
        name: name.trim(),
        unit: unit.trim(),
        itemClass,
        requestId,
        members: group.members.map((member, index) => ({
          supplier_id: member.supplier_id,
          normalized_name: member.normalized_name,
          raw_name: member.raw_name,
          entered_unit_label: nonStock ? null : members[index].label.trim() || null,
          conversion_factor: nonStock ? 1 : Number(members[index].factor.replace(",", ".")),
        })),
      },
      {
        onSuccess: (result) => {
          toast({
            title: nonStock ? "Đã đánh dấu không nhập kho" : result.status === "already_applied" ? "Nhóm này đã tạo trước đó" : "Đã tạo mặt hàng",
            description: `${name.trim()} · ${group.members.length} cách ghi tự chọn từ lần sau`,
          });
          onDone();
        },
        onError: (error) => toast({ title: "Chưa tạo được", description: errorText(error), variant: "destructive" }),
      },
    );
  };

  return (
    <li className="d3-ma-row" data-bmq-new-item-group>
      <div className="d3-ab-row-h">
        <div className="d3-ma-raw">
          <strong>{group.suggested_name}</strong>
          <small>
            {group.receipt_count} phiếu · {group.receipt_days} ngày
            {group.first_date ? ` · ${shortDate(group.first_date)}–${shortDate(group.last_date)}` : ""}
            {group.members.length > 1 ? ` · ${group.members.length} cách ghi` : ""}
          </small>
        </div>
        {group.suggested_class ? (
          <span className={`d3-sc-prob${(group.class_probability ?? 0) >= 0.85 ? " is-high" : (group.class_probability ?? 0) < 0.6 ? " is-low" : ""}`}>
            Sushi: {CLASS_LABELS[group.suggested_class]}{group.class_probability !== null ? ` ${pct(group.class_probability)}` : ""}
          </span>
        ) : (
          <span className="d3-sc-warn">Chưa xếp loại</span>
        )}
      </div>
      <div className="d3-ab-form">
        <label className="d3-ma-field d3-ma-item">
          <span>Tên mặt hàng</span>
          <Input value={name} onChange={(event) => setName(event.target.value)} disabled={nonStock} aria-label="Tên mặt hàng mới" />
        </label>
        <label className="d3-ma-field">
          <span>Loại</span>
          <OptionPicker value={itemClass} onChange={(value) => setItemClass(value as NewItemSuggestionClass)} title="Loại mặt hàng" ariaLabel="Loại mặt hàng" options={(Object.keys(CLASS_LABELS) as NewItemSuggestionClass[]).map((value) => ({ value, label: CLASS_LABELS[value] }))} />
        </label>
        <label className="d3-ma-field">
          <span>Đơn vị kho</span>
          <Input value={unit} onChange={(event) => { setUnit(event.target.value); setDrafts(null); }} disabled={nonStock} aria-label="Đơn vị kho" />
        </label>
      </div>
      <ul className="d3-ni-members">
        {group.members.map((member, index) => (
          <li key={`${member.supplier_id}|${member.normalized_name}`}>
            <span className="d3-ni-name">
              {member.raw_name}
              <small>{member.receipt_count} phiếu</small>
            </span>
            {nonStock ? null : (
              <span className="d3-ni-conv">
                <span>1</span>
                <Input value={members[index].label} onChange={(event) => setMember(index, { label: event.target.value })} aria-label={`Đơn vị trên phiếu của ${member.raw_name}`} />
                <span>=</span>
                <Input inputMode="decimal" placeholder="?" value={members[index].factor} onChange={(event) => setMember(index, { factor: event.target.value })} aria-label={`Hệ số đổi của ${member.raw_name}`} />
                <span>{unit.trim() || "đv"}</span>
              </span>
            )}
            {nonStock ? null : <CrateDocEvidence location={location} supplierId={member.supplier_id} normalizedName={member.normalized_name} title={`Phiếu giao hàng — ${member.raw_name}`} />}
          </li>
        ))}
      </ul>
      <div className="d3-ma-actions">
        <Button type="button" size="sm" onClick={save} disabled={!ready || busy}>
          {nonStock ? null : <Plus className="h-4 w-4" />}
          {apply.isPending ? "Đang lưu…" : nonStock ? "Không nhập kho" : "Tạo mặt hàng"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() =>
            dismiss.mutate(
              { suggestionId: group.id },
              { onSuccess: onDone, onError: (error) => toast({ title: "Chưa bỏ qua được", description: errorText(error), variant: "destructive" }) },
            )
          }
        >
          Bỏ qua
        </Button>
      </div>
    </li>
  );
}

/**
 * Purchased names of the last 60 days that have no stock item: grouped by Jev
 * (same goods written differently), classified, and turned into an item plus
 * auto aliases in one click.
 */
const RUN_LIVE = new Set(["queued", "running"]);

export function NewItemSuggestions({ canEdit, location = "q7" }: { canEdit: boolean; location?: MaterialAliasLocation }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const query = useNewItemSuggestions(location);
  const scan = useRunNewItemScan();
  const runQuery = useLatestNewItemRun(location, { enabled: canEdit });
  const run = runQuery.data ?? null;
  const live = Boolean(run && RUN_LIVE.has(run.status));
  const [tab, setTab] = useState<"recurring" | "once">("recurring");
  const [hidden, setHidden] = useState<Record<string, true>>({});

  // The scan runs on the server; when a run leaves "running", refresh both lists once.
  const lastStatus = useRef<string | null>(null);
  useEffect(() => {
    const status = run?.status ?? null;
    if (lastStatus.current && RUN_LIVE.has(lastStatus.current) && status && !RUN_LIVE.has(status)) {
      void queryClient.invalidateQueries({ queryKey: [MATERIAL_ALIAS_NEW_ITEM_QUERY_KEY] });
      void queryClient.invalidateQueries({ queryKey: [MATERIAL_ALIAS_BACKLOG_REVIEW_QUERY_KEY] });
      if (status === "done") toast({ title: `Sushi đã phân loại xong · ${run?.groups ?? 0} nhóm` });
      if (status === "failed") toast({ title: "Lượt phân loại bị lỗi", description: run?.last_error ?? undefined, variant: "destructive" });
    }
    lastStatus.current = status;
  }, [run?.status, run?.groups, run?.last_error, queryClient, toast]);

  const groups = useMemo(() => (query.data ?? []).filter((group) => group.status === "pending" && !hidden[group.id]), [query.data, hidden]);
  const recurring = groups.filter((group) => group.is_recurring);
  const once = groups.filter((group) => !group.is_recurring);
  const list = tab === "recurring" ? recurring : once;

  const start = () =>
    scan.mutate(
      { location, days: 60, batchSize: 20 },
      {
        onSuccess: () => void runQuery.refetch(),
        onError: (error) => toast({ title: "Chưa bắt đầu được", description: errorText(error), variant: "destructive" }),
      },
    );

  const total = run ? run.processed + run.remaining : 0;
  const runNote = !run
    ? null
    : live
      ? total > 0 ? `Sushi đang xét · đã xong ${run.processed}, còn ${run.remaining}` : "Sushi đang bắt đầu…"
      : run.status === "paused"
        ? `Tạm dừng · còn ${run.remaining}. Bấm lại để chạy tiếp.`
        : run.status === "failed"
          ? `Lượt trước bị lỗi: ${run.last_error ?? "không rõ"}`
          : run.finished_at
            ? `Lần chạy gần nhất xong ${shortDate(run.finished_at)} · ${run.groups} nhóm · ${run.calls} lượt Sushi`
            : null;

  if (!canEdit) return null;

  return (
    <section className="d3-wh-card" style={{ ["--i" as string]: 3 }} data-bmq-new-items>
      <div className="d3-wh-card-h">
        <h2>Hàng mới đề xuất</h2>
        <span className="d3-wh-pill">{query.data ? groups.length : "…"}</span>
        <p>Hàng đã nhập trong 60 ngày nhưng chưa có mã kho. Sushi gom các cách ghi của cùng một món và xếp loại; bấm "Tạo mặt hàng" là lần sau tự chọn.</p>
        <button type="button" className="d3-ap-link d3-ab-scan" disabled={scan.isPending || live} onClick={start} data-bmq-new-items-scan>
          <Sparkles className="h-3.5 w-3.5" />
          {live || scan.isPending ? "Sushi đang phân loại…" : run?.status === "paused" ? "Chạy tiếp" : "Phân loại hàng chưa có mã"}
        </button>
      </div>

      {runNote ? (
        <div className={`d3-ab-progress${run?.status === "failed" ? " is-error" : ""}`} role="status" aria-live="polite" data-bmq-new-items-run={run?.status}>
          {live || run?.status === "paused" ? (
            <span className="d3-ab-bar"><i style={{ width: total ? `${Math.round(((run?.processed ?? 0) / total) * 100)}%` : "4%" }} /></span>
          ) : null}
          <small>{runNote}{live ? " · đóng trang vẫn chạy" : ""}</small>
        </div>
      ) : null}

      {query.isLoading ? (
        <div className="d3-wh-empty">Đang tải…</div>
      ) : query.isError ? (
        <div className="d3-wh-empty">{errorText(query.error)}</div>
      ) : groups.length === 0 ? (
        <div className="d3-wh-empty">Chưa có nhóm nào. Bấm "Phân loại hàng chưa có mã" để Sushi xét hàng 60 ngày.</div>
      ) : (
        <>
          <div className="d3-ab-tabs" role="tablist">
            <button type="button" role="tab" aria-selected={tab === "recurring"} className={tab === "recurring" ? "is-on" : ""} onClick={() => setTab("recurring")}>
              Nhập từ 2 lần <b>{recurring.length}</b>
            </button>
            <button type="button" role="tab" aria-selected={tab === "once"} className={tab === "once" ? "is-on" : ""} onClick={() => setTab("once")}>
              Mua 1 lần <b>{once.length}</b>
            </button>
          </div>
          {list.length === 0 ? (
            <div className="d3-wh-empty">Không có nhóm nào trong mục này.</div>
          ) : (
            <ul className="d3-ma-list">
              {list.map((group) => (
                <GroupRow key={group.id} group={group} location={location} onDone={() => setHidden((current) => ({ ...current, [group.id]: true }))} />
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
