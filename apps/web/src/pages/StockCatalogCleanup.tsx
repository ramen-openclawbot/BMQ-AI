import { useMemo, useState } from "react";
import { AlertTriangle, Bot, GitMerge, Layers, RotateCcw, Sparkles, Tags } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import {
  useDecideStockCatalogSuggestion,
  useLinkKitchenItemsToCanonical,
  useRevertStockItemMerge,
  useRunStockCatalogJev,
  useStockCatalogReview,
} from "@/hooks/useStockCatalog";
import {
  useMaterialAliasReview,
  useRunAliasBacklog,
  useSetMaterialAliasStatus,
  useUndoMaterialAliasEvent,
} from "@/hooks/useMaterialAlias";
import { materialAliasActionLabel, materialAliasStatusLabel } from "@/lib/material-alias";
import {
  ITEM_CLASS_LABELS,
  itemClassLabel,
  STOCK_ITEM_CLASSES,
  type StockCatalogPendingSuggestion,
  type StockItemClass,
} from "@/lib/stock-catalog";
import "@/styles/bmq-warehouse.css";
import "@/styles/bmq-stock-ledger.css";

const num = (value: number | null | undefined, digits = 3) =>
  value === null || value === undefined || !Number.isFinite(value)
    ? "—"
    : value.toLocaleString("vi-VN", { maximumFractionDigits: digits });

const pct = (value: number) => `${Math.round(value * 100)}%`;

const shortDate = (iso: string | null | undefined) => {
  if (!iso) return "—";
  const [y, m, d] = iso.slice(0, 10).split("-");
  return d && m && y ? `${d}/${m}` : iso;
};

const errorText = (error: unknown) => {
  const message = String((error as { message?: string })?.message ?? error);
  if (message.includes("insufficient_privilege")) return "Tài khoản chưa có quyền sửa danh mục kho.";
  if (message.includes("merge_source_was_target") || message.includes("merge_target_merged")) return "Mặt hàng này đã nằm trong một lần gộp khác. Hoàn tác lần đó trước.";
  if (message.includes("factor")) return "Cần hệ số đổi đơn vị dương.";
  if (message.includes("daily") || message.includes("quota")) return "Đã hết hạn mức gọi Jev hôm nay.";
  if (message.includes("kill")) return "Jev đang bị tắt bằng công tắc khẩn.";
  return message;
};

const usageText = (count: number | null) => (count === null ? "" : count > 0 ? `${count} phiếu xuất 90 ngày` : "không dùng 90 ngày");

function MergeRow({ row, canEdit }: { row: StockCatalogPendingSuggestion; canEdit: boolean }) {
  const { toast } = useToast();
  const decide = useDecideStockCatalogSuggestion();
  const [factor, setFactor] = useState(row.proposed_factor === null ? "" : String(row.proposed_factor));
  const factorValue = Number(factor.replace(",", "."));
  const factorOk = Number.isFinite(factorValue) && factorValue > 0;
  const keepIsItem = row.proposed_target_id === row.item_id;
  const keep = keepIsItem
    ? { name: row.item_name, unit: row.item_unit, use: row.item_issue_count_90d }
    : { name: row.other_item_name ?? "—", unit: row.other_item_unit ?? "", use: row.other_issue_count_90d };
  const drop = keepIsItem
    ? { name: row.other_item_name ?? "—", unit: row.other_item_unit ?? "", use: row.other_issue_count_90d }
    : { name: row.item_name, unit: row.item_unit, use: row.item_issue_count_90d };

  const act = (action: "approve" | "reject") =>
    decide.mutate(
      { suggestionId: row.id, action, factor: action === "approve" ? factorValue : null },
      {
        onSuccess: () =>
          toast({
            title: action === "approve" ? "Đã gộp" : "Đã bỏ đề xuất",
            description: action === "approve" ? `${drop.name} → ${keep.name}. Có thể hoàn tác ở mục Lịch sử gộp.` : undefined,
          }),
        onError: (error) => toast({ title: "Chưa làm được", description: errorText(error), variant: "destructive" }),
      },
    );

  return (
    <li className="d3-sc-row" data-bmq-catalog-merge>
      <div className="d3-sc-pair">
        <div className="d3-sc-side is-keep">
          <small>Giữ</small>
          <strong>{keep.name}</strong>
          <span>{keep.unit} · {usageText(keep.use)}</span>
        </div>
        <GitMerge className="d3-sc-arrow h-4 w-4" aria-hidden="true" />
        <div className="d3-sc-side">
          <small>Gộp vào</small>
          <strong>{drop.name}</strong>
          <span>{drop.unit} · {usageText(drop.use)}</span>
        </div>
      </div>
      <div className="d3-sc-meta">
        <span className={`d3-sc-prob${row.probability >= 0.9 ? " is-high" : row.probability < 0.7 ? " is-low" : ""}`}>
          Jev {pct(row.probability)} cùng mặt hàng
        </span>
        {row.factor_source === "none" ? <span className="d3-sc-warn">Khác đơn vị, cần nhập hệ số</span> : null}
      </div>
      {canEdit ? (
        <div className="d3-sc-actions">
          <label className="d3-sc-factor">
            <span>1 {drop.unit || "đv"} = ? {keep.unit || "đv"}</span>
            <Input
              inputMode="decimal"
              value={factor}
              onChange={(event) => setFactor(event.target.value)}
              aria-label={`Hệ số đổi từ ${drop.name} sang ${keep.name}`}
            />
          </label>
          <Button type="button" onClick={() => act("approve")} disabled={!factorOk || decide.isPending}>
            {decide.isPending ? "Đang gộp…" : "Gộp"}
          </Button>
          <Button type="button" variant="outline" onClick={() => act("reject")} disabled={decide.isPending}>
            Bỏ
          </Button>
        </div>
      ) : null}
    </li>
  );
}

function ClassifyRow({ row, canEdit }: { row: StockCatalogPendingSuggestion; canEdit: boolean }) {
  const { toast } = useToast();
  const decide = useDecideStockCatalogSuggestion();
  const [cls, setCls] = useState<StockItemClass | "">(row.proposed_class ?? "");

  const act = (action: "approve" | "reject") =>
    decide.mutate(
      { suggestionId: row.id, action, itemClass: action === "approve" && cls !== row.proposed_class ? cls : null },
      {
        onSuccess: () => toast({ title: action === "approve" ? "Đã phân loại" : "Đã bỏ đề xuất", description: row.item_name }),
        onError: (error) => toast({ title: "Chưa làm được", description: errorText(error), variant: "destructive" }),
      },
    );

  return (
    <li className="d3-sc-row is-classify" data-bmq-catalog-classify>
      <div className="d3-sc-side">
        <strong>{row.item_name}</strong>
        <span>{row.item_unit} · {usageText(row.item_issue_count_90d)} · Jev {pct(row.probability)}</span>
      </div>
      {canEdit ? (
        <div className="d3-sc-actions">
          <select
            className="d3-wh-select d3-sc-class"
            aria-label={`Nhóm cho ${row.item_name}`}
            value={cls}
            onChange={(event) => setCls(event.target.value as StockItemClass)}
          >
            <option value="">Chọn nhóm…</option>
            {STOCK_ITEM_CLASSES.map((value) => (
              <option key={value} value={value}>{ITEM_CLASS_LABELS[value]}</option>
            ))}
          </select>
          <Button type="button" onClick={() => act("approve")} disabled={!cls || decide.isPending}>Duyệt</Button>
          <Button type="button" variant="outline" onClick={() => act("reject")} disabled={decide.isPending}>Bỏ</Button>
        </div>
      ) : (
        <span className="d3-wh-pill">{itemClassLabel(row.proposed_class)}</span>
      )}
    </li>
  );
}

function LearnedAliasesCard({ canEdit }: { canEdit: boolean }) {
  const { toast } = useToast();
  const reviewQuery = useMaterialAliasReview(7);
  const undo = useUndoMaterialAliasEvent();
  const setStatus = useSetMaterialAliasStatus();
  const backlog = useRunAliasBacklog();
  const review = reviewQuery.data;
  const aliases = review?.aliases ?? [];
  const summary = review?.summary;
  const fail = (title: string) => (error: unknown) => toast({ title, description: errorText(error), variant: "destructive" });

  return (
    <section className="d3-wh-card" style={{ ["--i" as string]: 4 }} data-bmq-learned-aliases>
      <div className="d3-wh-card-h">
        <h2>Bí danh đã học</h2>
        <span className="d3-wh-pill">
          {summary ? `${summary.auto_count} tự động · ${summary.learning_count} đang học` : "…"}
        </span>
        <p>
          Tên hàng nhân viên đã xác nhận trong 7 ngày. Jev không đồng ý xếp đầu.
          {summary ? ` Còn ${summary.pending_lines} dòng nhập chưa có mã.` : ""}
        </p>
        {canEdit ? (
          <button
            type="button"
            className="d3-ap-link"
            disabled={backlog.isPending}
            onClick={() =>
              backlog.mutate(
                { location: "q7" },
                {
                  onSuccess: (data) => {
                    const d = data as { evaluated?: number; skipped_existing?: number; calls?: number; stopped?: string | null };
                    toast({ title: "Jev đã dò tên tồn đọng", description: `${d.evaluated ?? 0} tên mới, ${d.skipped_existing ?? 0} đã có, ${d.calls ?? 0} lượt gọi${d.stopped ? " · dừng vì hết hạn mức" : ""}.` });
                  },
                  onError: fail("Jev chưa dò được"),
                },
              )
            }
          >
            {backlog.isPending ? "Jev đang dò…" : "Dò tên tồn đọng"}
          </button>
        ) : null}
      </div>
      {reviewQuery.isLoading ? (
        <div className="d3-wh-empty">Đang tải…</div>
      ) : reviewQuery.isError ? (
        <div className="d3-wh-empty">Không tải được: {errorText(reviewQuery.error)}</div>
      ) : aliases.length === 0 ? (
        <div className="d3-wh-empty">Chưa có bí danh nào được xác nhận trong 7 ngày.</div>
      ) : (
        <ul className="d3-sc-list">
          {aliases.map((alias) => (
            <li key={alias.alias_id} className={`d3-sc-row is-history${alias.jev_disagreed ? " is-flagged" : ""}${alias.status === "disabled" ? " is-reverted" : ""}`} data-bmq-learned-alias>
              <div className="d3-sc-side">
                <strong>{alias.normalized_name} → {alias.item_name ?? "—"}</strong>
                <span>
                  {alias.supplier_name ?? "mọi NCC"} · {alias.pack_label ? `${alias.pack_label} = ${num(alias.conversion_factor)} ${alias.unit}` : alias.unit} · {materialAliasStatusLabel(alias.status)} {alias.confirm_count}/3
                  {alias.jev_disagreed ? " · Jev không đồng ý" : ""}
                  {alias.last_event ? ` · ${materialAliasActionLabel(alias.last_event.action)} ${shortDate(alias.last_event.created_at)}` : ""}
                </span>
              </div>
              {canEdit ? (
                <div className="d3-sc-actions is-inline">
                  {alias.last_event?.id && alias.last_event.action !== "undo" && alias.last_event.action !== "auto_promoted" ? (
                    <Button type="button" variant="outline" size="sm" disabled={undo.isPending} onClick={() => undo.mutate({ eventId: alias.last_event?.id as string }, { onSuccess: () => toast({ title: "Đã hoàn tác" }), onError: fail("Chưa hoàn tác được") })}>
                      <RotateCcw className="h-3.5 w-3.5" />
                      Hoàn tác
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={setStatus.isPending}
                    onClick={() =>
                      setStatus.mutate(
                        { aliasId: alias.alias_id, status: alias.status === "disabled" ? "auto" : "disabled" },
                        { onSuccess: () => toast({ title: alias.status === "disabled" ? "Đã bật lại" : "Đã tắt bí danh" }), onError: fail("Chưa đổi được") },
                      )
                    }
                  >
                    {alias.status === "disabled" ? "Bật lại" : "Tắt"}
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default function StockCatalogCleanup() {
  const { toast } = useToast();
  const { isOwner, canEditModule } = useAuth();
  const canEdit = isOwner || canEditModule("q7_material_inventory") || canEditModule("kitchen_inventory");
  const reviewQuery = useStockCatalogReview();
  const runJev = useRunStockCatalogJev();
  const revert = useRevertStockItemMerge();
  const link = useLinkKitchenItemsToCanonical();
  const review = reviewQuery.data;

  const merges = useMemo(() => (review?.pending_suggestions ?? []).filter((row) => row.kind === "merge"), [review]);
  const classifies = useMemo(() => (review?.pending_suggestions ?? []).filter((row) => row.kind === "classify"), [review]);
  const history = review?.recent_merges ?? [];
  const classCounts = review?.item_class_counts ?? {};
  const classified = Object.entries(classCounts).filter(([key]) => key !== "unclassified").reduce((sum, [, count]) => sum + count, 0);
  const unclassified = classCounts.unclassified ?? 0;
  const usage = review?.jev_usage;
  const quotaLeft = usage ? Math.max(0, usage.call_limit - usage.calls) : null;

  const loading = reviewQuery.isLoading;
  const failed = reviewQuery.isError;
  const metrics: Array<{ label: string; value: string; hint: string; Icon: LucideIcon }> = [
    { label: "Đề xuất gộp", value: String(merges.length), hint: "Chờ duyệt", Icon: GitMerge },
    { label: "Chờ phân loại", value: String(classifies.length), hint: `${unclassified} mặt hàng chưa có nhóm`, Icon: Tags },
    { label: "Đã có nhóm", value: String(classified), hint: "Mặt hàng đã phân loại", Icon: Layers },
    { label: "Jev hôm nay", value: usage ? `${usage.calls}/${usage.call_limit}` : "—", hint: usage ? `${num(usage.cost, 4)} USD` : "Lượt gọi", Icon: Bot },
  ];

  const scan = (mode: "dedupe" | "classify") =>
    runJev.mutate(
      { mode },
      {
        onSuccess: (summary) =>
          toast({
            title: mode === "dedupe" ? "Jev đã quét cặp trùng" : "Jev đã phân loại",
            description: `${summary.suggestions} đề xuất mới, ${summary.skipped_existing} đã có, ${summary.failed} lỗi, ${summary.calls} lượt gọi${summary.stopped ? " · dừng vì hết hạn mức" : ""}.`,
          }),
        onError: (error) => toast({ title: "Jev chưa quét được", description: errorText(error), variant: "destructive" }),
      },
    );

  return (
    <div className="d3-wh d3-sl d3-sc min-w-0" data-bmq-stock-catalog>
      <header className="d3-wh-head">
        <div className="min-w-0">
          <span className="d3-wh-tag">Jev đề xuất · người duyệt quyết định · mọi lần gộp đều hoàn tác được</span>
          <h1>
            Dọn danh mục <b>NVL Q7</b>
          </h1>
        </div>
        {canEdit ? (
          <div className="d3-sc-scan">
            <Button type="button" onClick={() => scan("dedupe")} disabled={runJev.isPending || quotaLeft === 0}>
              <Sparkles className="h-4 w-4" />
              {runJev.isPending ? "Jev đang quét…" : "Quét cặp trùng"}
            </Button>
            <Button type="button" variant="outline" onClick={() => scan("classify")} disabled={runJev.isPending || quotaLeft === 0}>
              <Tags className="h-4 w-4" />
              Phân loại mặt hàng
            </Button>
          </div>
        ) : null}
      </header>

      <section className="d3-wh-kpis">
        {metrics.map(({ label, value, hint, Icon }, k) => (
          <div key={label} className="d3-wh-kpi" style={{ ["--i" as string]: k }}>
            <span><Icon className="h-4 w-4" />{label}</span>
            <strong>{loading ? "…" : failed ? "—" : value}</strong>
            <small>{hint}</small>
          </div>
        ))}
      </section>

      {failed ? (
        <div className="d3-wh-alert is-error">
          <AlertTriangle className="h-5 w-5 shrink-0" />
          <div><strong>Không tải được danh mục.</strong> {errorText(reviewQuery.error)}</div>
        </div>
      ) : null}

      {!loading && !failed && merges.length === 0 && classifies.length === 0 && history.length === 0 ? (
        <div className="d3-wh-alert is-warn">
          <AlertTriangle className="h-5 w-5 shrink-0" />
          <div><strong>Chưa có đề xuất nào.</strong> Bấm "Quét cặp trùng" để Jev xét các mặt hàng có tên gần giống nhau, rồi "Phân loại mặt hàng" để gắn nhóm.</div>
        </div>
      ) : null}

      <div className="d3-sl-grid">
        <section className="d3-wh-card" style={{ ["--i" as string]: 1 }}>
          <div className="d3-wh-card-h">
            <h2>Đề xuất gộp</h2>
            <span className="d3-wh-pill">{merges.length}</span>
            <p>Mặt hàng được giữ là bên đang dùng nhiều hơn. Tồn và lịch sử của bên kia chuyển sang theo hệ số.</p>
          </div>
          {loading ? (
            <div className="d3-wh-empty">Đang tải…</div>
          ) : merges.length === 0 ? (
            <div className="d3-wh-empty">Không có cặp nào chờ duyệt.</div>
          ) : (
            <ul className="d3-sc-list">
              {merges.map((row) => <MergeRow key={row.id} row={row} canEdit={canEdit} />)}
            </ul>
          )}
        </section>

        <div className="d3-sl-side">
          <section className="d3-wh-card" style={{ ["--i" as string]: 2 }}>
            <div className="d3-wh-card-h">
              <h2>Phân loại</h2>
              <span className="d3-wh-pill">{classifies.length}</span>
              <p>Nguyên liệu, bao bì/vật tư, thành phẩm hay không tồn kho.</p>
            </div>
            {loading ? (
              <div className="d3-wh-empty">Đang tải…</div>
            ) : classifies.length === 0 ? (
              <div className="d3-wh-empty">Không có mặt hàng chờ phân loại.</div>
            ) : (
              <ul className="d3-sc-list">
                {classifies.map((row) => <ClassifyRow key={row.id} row={row} canEdit={canEdit} />)}
              </ul>
            )}
          </section>

          <section className="d3-wh-card" style={{ ["--i" as string]: 3 }}>
            <div className="d3-wh-card-h">
              <h2>Lịch sử gộp</h2>
              <span className="d3-wh-pill">{history.length}</span>
              {canEdit ? (
                <button
                  type="button"
                  className="d3-ap-link"
                  disabled={link.isPending}
                  onClick={() =>
                    link.mutate(undefined, {
                      onSuccess: (data) => {
                        const n = Number((data as { linkable_count?: number })?.linkable_count ?? 0);
                        const amb = ((data as { ambiguous_items?: unknown[] })?.ambiguous_items ?? []).length;
                        toast({ title: "Đã rà mã chuẩn", description: `${n} mặt hàng gắn được mã chuẩn, ${amb} mặt hàng có nhiều mã cần xem. Việc gắn thật làm ở Material Master.` });
                      },
                      onError: (error) => toast({ title: "Chưa rà được", description: errorText(error), variant: "destructive" }),
                    })
                  }
                >
                  Rà mã chuẩn
                </button>
              ) : null}
            </div>
            {history.length === 0 ? (
              <div className="d3-wh-empty">Chưa gộp mặt hàng nào.</div>
            ) : (
              <ul className="d3-sc-list">
                {history.map((merge) => (
                  <li key={merge.merge_id} className={`d3-sc-row is-history${merge.status === "reverted" ? " is-reverted" : ""}`} data-bmq-catalog-history>
                    <div className="d3-sc-side">
                      <strong>{merge.source_name} → {merge.target_name}</strong>
                      <span>
                        hệ số {num(merge.factor)} · {shortDate(merge.applied_at)}
                        {merge.status === "reverted" ? ` · đã hoàn tác ${shortDate(merge.reverted_at)}` : ""}
                      </span>
                    </div>
                    {canEdit && merge.can_revert ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={revert.isPending}
                        onClick={() =>
                          revert.mutate(
                            { mergeId: merge.merge_id },
                            {
                              onSuccess: () => toast({ title: "Đã hoàn tác", description: `${merge.source_name} hoạt động trở lại.` }),
                              onError: (error) => toast({ title: "Chưa hoàn tác được", description: errorText(error), variant: "destructive" }),
                            },
                          )
                        }
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                        Hoàn tác
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <LearnedAliasesCard canEdit={canEdit} />
        </div>
      </div>
    </div>
  );
}
