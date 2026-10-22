import { useMemo, useState } from "react";
import { AlertTriangle, ArrowDown, ArrowUp, Download } from "lucide-react";
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid } from "recharts";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SkuCostHeader } from "@/components/sku-costs/SkuCostMenuBar";
import { useSkuCostBridge } from "@/hooks/useSkuCostBridge";
import { buildSkuAnalysis, compactMoney, decimalMoney, money, pct, todayMonth, type SkuAnalysis } from "@/lib/sku-cost-analysis";
import { cn } from "@/lib/utils";

function DeltaBadge({ value }: { value: number | null }) {
  if (value === null) return <span className="gv-chip">N/A</span>;
  const isUp = value > 0;
  const Icon = isUp ? ArrowUp : ArrowDown;
  return (
    <span className={cn("gv-chip", isUp ? "is-bad" : "is-good")}>
      <Icon />
      {pct(value)}
    </span>
  );
}

export default function SkuCostsAnalysis() {
  const [period, setPeriod] = useState(todayMonth());
  const [selectedSkuId, setSelectedSkuId] = useState("");
  const [analysis, setAnalysis] = useState<SkuAnalysis | null>(null);
  const [showAllRows, setShowAllRows] = useState(false);
  const { data, isLoading } = useSkuCostBridge();

  const items = useMemo(() => data?.items || [], [data?.items]);
  const formulas = useMemo(() => data?.formulas || [], [data?.formulas]);
  const purchases = useMemo(() => data?.purchases || [], [data?.purchases]);
  const selectedSku = useMemo(() => {
    if (!items.length) return null;
    return items.find((item: any) => item.id === selectedSkuId) || items.find((item: any) => String(item.product_name || "").toLowerCase().includes("chà bông")) || items[0];
  }, [items, selectedSkuId]);

  const runAnalysis = () => {
    if (!selectedSku) return;
    setSelectedSkuId(selectedSku.id);
    setShowAllRows(false);
    setAnalysis(buildSkuAnalysis({ sku: selectedSku, formulas, purchases, period }));
  };

  const exportCurrentAnalysis = () => {
    if (!analysis) return;
    const header = ["SKU", "Tháng", "Mã NVL", "Tên NVL chuẩn", "Tên NVL công thức", "Giá CT", "Giá TT TB dùng tính", "Giá mua raw", "Định lượng", "Đơn vị", "Δ cost", "Δ %", "Nguồn", "Số dòng PR/PO", "Cảnh báo"];
    const rows = analysis.rows.map((row) => [analysis.skuLabel, analysis.period, row.materialCode || "", row.name, row.rawName, row.formulaPrice, row.actualPrice ?? "", row.rawActualPrice ?? "", row.dosage, row.unit, row.diffCost ?? "", row.diffPct ?? "", row.source, row.sampleCount, row.warning || ""]);
    const chart = [[""], ["Chart"], ["Ngày", "Giá mua thật", "Formula baseline", "% NVL có giá thật", "NVL match", "Tổng NVL"], ...analysis.chartRows.map((row) => [row.label, row.actual ?? "", row.baseline, row.coveragePct, row.matchedMaterials, row.totalMaterials])];
    const csv = [header, ...rows, ...chart].map((line) => line.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `sku-cost-review-${analysis.skuId}-${analysis.period}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const staleAnalysis = !!analysis && (analysis.skuId !== selectedSku?.id || analysis.period !== period);
  const displayRows = analysis ? (showAllRows ? analysis.rows : analysis.rows.slice(0, 3)) : [];
  const hiddenRows = analysis ? Math.max(0, analysis.rows.length - displayRows.length) : 0;
  const warningRows = analysis ? analysis.rows.filter((row) => row.warning) : [];

  const runAt = analysis ? new Date(analysis.runAt) : null;

  return (
    <div data-stitch-sku-cost-analysis-theme="pantone-2026-light" className="gv">
      <SkuCostHeader
        title="Xu hướng giá vốn"
        description="So giá vốn theo công thức với giá mua thực tế đã quy đổi, theo từng SKU và từng tháng."
        actions={
          <button type="button" className="gv-btn" onClick={exportCurrentAnalysis} disabled={!analysis}>
            <Download /> Xuất CSV
          </button>
        }
      />

      <section className="gv-panel" aria-label="Chọn SKU và tháng">
        <div className="gv-controls">
          <label className="gv-field">
            <span>SKU</span>
            <Select value={selectedSku?.id || ""} onValueChange={(value) => { setSelectedSkuId(value); setAnalysis(null); setShowAllRows(false); }}>
              <SelectTrigger className="gv-input px-3 text-left">
                <SelectValue placeholder={isLoading ? "Đang tải SKU..." : "Chọn SKU"} />
              </SelectTrigger>
              <SelectContent className="max-h-80">
                {items.map((item: any) => <SelectItem key={item.id} value={item.id}>{item.product_name} - {item.sku_code || item.id}</SelectItem>)}
              </SelectContent>
            </Select>
          </label>
          <label className="gv-field">
            <span>Tháng</span>
            <Input type="month" value={period} onChange={(event) => { setPeriod(event.target.value); setAnalysis(null); setShowAllRows(false); }} aria-label="Chọn tháng phân tích" className="gv-input w-full min-w-0 px-3 [color-scheme:light]" />
          </label>
          <button type="button" className="gv-btn is-primary" onClick={runAnalysis} disabled={!selectedSku || isLoading}>
            Chạy phân tích
          </button>
        </div>
        <p className="gv-meta">
          {isLoading ? "Đang tải SKU…" : `${items.length} SKU`} · {analysis ? `${analysis.matchedRows}/${analysis.totalRows} NVL có giá thực tế` : "Bấm “Chạy phân tích” để lấy giá mua từ PR/duyệt chi đã quy đổi."}
          {staleAnalysis ? <span className="gv-warn"> Thông số đã đổi, bấm chạy lại để cập nhật.</span> : null}
        </p>
      </section>

      {!analysis ? (
        <section className="gv-panel">
          <p className="gv-empty">
            <b>Chưa có phân tích</b>
            Chọn SKU và tháng, rồi bấm “Chạy phân tích” để xem bảng NVL và biến động giá theo đợt thanh toán.
          </p>
        </section>
      ) : (
        <>
          <section className="gv-kpis" aria-label="Kết quả phân tích">
            <div className="gv-kpi">
              <span className="gv-kpi-label">Giá vốn công thức</span>
              <strong>{money(Math.round(analysis.formulaCost))}<small>đ/ổ</small></strong>
              <span className="gv-kpi-sub">{analysis.skuLabel}</span>
            </div>
            <div className="gv-kpi">
              <span className="gv-kpi-label">Giá vốn thực tế TB tháng</span>
              <strong>{money(Math.round(analysis.actualCost))}<small>đ/ổ</small></strong>
              <span className="gv-kpi-sub">Tháng {analysis.period}</span>
            </div>
            <div className="gv-kpi">
              <span className="gv-kpi-label">Chênh lệch</span>
              <strong className={analysis.diff > 0 ? "gv-bad" : "gv-good"}>{analysis.diff > 0 ? "+" : ""}{money(Math.round(analysis.diff))}<small>đ/ổ</small></strong>
              <span className="gv-kpi-sub"><DeltaBadge value={analysis.diffPct} /></span>
            </div>
            <div className="gv-kpi">
              <span className="gv-kpi-label">Lần chạy</span>
              <strong>{runAt?.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" })}</strong>
              <span className="gv-kpi-sub">{runAt?.toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric" })}</span>
            </div>
          </section>

          {warningRows.length > 0 ? (
            <div className="gv-notice" role="status">
              <AlertTriangle />
              <p><b>{warningRows.length} NVL cần kiểm tra quy đổi.</b> Giá mua lệch từ 100% trở lên so với giá công thức, nên app giữ giá công thức cho các dòng này để xu hướng không bị méo.</p>
            </div>
          ) : null}

          <div className="gv-grid">
            <section className="gv-panel is-flush" aria-label="NVL công thức và giá thực tế">
              <div className="gv-panel-h">
                <div>
                  <h2>Công thức ↔ giá mua thực tế</h2>
                  <p>{analysis.skuLabel}</p>
                </div>
                <span className="gv-chip">{analysis.matchedRows}/{analysis.totalRows} NVL</span>
              </div>
              {analysis.rows.length === 0 ? <p className="gv-empty"><b>SKU này chưa có công thức NVL</b>Thêm NVL ở tab Quản trị SKU để so với giá mua thực tế.</p> : null}
              <div className="gv-table-wrap" hidden={analysis.rows.length === 0}>
                <table className="gv-table">
                  <thead>
                    <tr>
                      <th>NVL</th>
                      <th className="is-num">Giá CT</th>
                      <th className="is-num">Giá TT TB</th>
                      <th className="is-num">Định lượng</th>
                      <th className="is-num">Δ giá vốn</th>
                      <th className="is-num">Δ %</th>
                    </tr>
                  </thead>
                  <tbody>
                    {analysis.rows.map((row) => (
                      <tr key={`${row.materialCode || row.rawName}-${row.dosage}`}>
                        <td>
                          <b>{row.name}</b>
                          <small>{row.materialCode || "—"}{row.rawName && row.rawName !== row.name ? ` · ${row.rawName}` : ""} · {row.source} · {row.sampleCount}</small>
                          {row.warning ? <div className="gv-warnline"><AlertTriangle />{row.warning}</div> : null}
                        </td>
                        <td className="is-num gv-dim">{decimalMoney(row.formulaPrice)}</td>
                        <td className="is-num">{decimalMoney(row.actualPrice)}</td>
                        <td className="is-num gv-dim">{decimalMoney(row.dosage, 2)} {row.unit}</td>
                        <td className={cn("is-num", row.diffCost !== null && (row.diffCost > 0 ? "gv-bad" : "gv-good"))}>{row.diffCost === null ? "—" : compactMoney(row.diffCost)}</td>
                        <td className="is-num"><DeltaBadge value={row.diffPct} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <ul className="gv-mlist">
                {displayRows.map((row) => (
                  <li key={`${row.rawName}-${row.dosage}`}>
                    <div className="gv-mlist-top">
                      <b>{row.name}</b>
                      <DeltaBadge value={row.diffPct} />
                    </div>
                    <div className="gv-mlist-meta">{row.materialCode ? `${row.materialCode} · ` : ""}{decimalMoney(row.dosage, 2)} {row.unit} · {row.source}</div>
                    <div className="gv-mlist-figs">
                      <span>Giá CT<b>{decimalMoney(row.formulaPrice)}</b></span>
                      <span>Giá TT TB<b>{decimalMoney(row.actualPrice)}</b></span>
                    </div>
                    {row.warning ? <div className="gv-warnline"><AlertTriangle />{row.warning}</div> : null}
                  </li>
                ))}
              </ul>
              {hiddenRows > 0 ? (
                <button type="button" className="gv-more" onClick={() => setShowAllRows(true)}>Xem thêm {hiddenRows} NVL</button>
              ) : analysis.rows.length > 3 ? (
                <button type="button" className="gv-more" onClick={() => setShowAllRows(false)}>Thu gọn</button>
              ) : null}
            </section>

            <section className="gv-panel" aria-label="Biến động trong tháng">
              <div className="gv-panel-h">
                <div>
                  <h2>Biến động trong tháng</h2>
                  <p>Theo từng đợt thanh toán</p>
                </div>
              </div>
              <div className="gv-legend">
                <span><i />Giá mua thật</span>
                <span><i className="is-dash" />Giá công thức</span>
              </div>
              <div className="gv-chart">
                {analysis.chartRows.length === 0 ? (
                  <div className="gv-chart-empty">Chưa có PR/PO đã duyệt trong tháng khớp mã NVL của SKU này, nên chưa vẽ được giá mua thật.</div>
                ) : null}
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={analysis.chartRows} margin={{ top: 16, right: 12, left: -12, bottom: 4 }}>
                    <CartesianGrid stroke="#e2e2df" vertical={false} />
                    <XAxis dataKey="label" axisLine={false} tickLine={false} tick={{ fill: "#6b6b69", fontSize: 11 }} dy={8} />
                    <YAxis domain={["auto", "auto"]} axisLine={false} tickLine={false} tick={{ fill: "#6b6b69", fontSize: 11 }} tickFormatter={(value) => money(Number(value))} width={60} />
                    <Tooltip cursor={{ stroke: "#d6d6d3", strokeWidth: 1 }} contentStyle={{ background: "#fdfdfc", border: "1px solid #e2e2df", borderRadius: 12, color: "#272727", fontSize: 12 }} formatter={(value: number | null, name: string, item: any) => [value === null ? "Chưa có giá mua thật" : `${money(Math.round(Number(value)))} đ/ổ`, name === "actual" ? `Giá mua thật (${Math.round(item?.payload?.coveragePct || 0)}% NVL)` : "Giá công thức"]} labelFormatter={(label) => `Đợt ${label}`} />
                    <Line type="monotone" dataKey="baseline" stroke="#a3a3a0" strokeWidth={2} strokeDasharray="5 6" dot={false} isAnimationActive={false} />
                    <Line type="monotone" dataKey="actual" stroke="#272727" strokeWidth={2.5} connectNulls={false} dot={{ r: 3.5, fill: "#272727", stroke: "#fdfdfc", strokeWidth: 2 }} activeDot={{ r: 5, fill: "#272727", stroke: "#fdfdfc", strokeWidth: 2 }} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
              <p className="gv-foot">Dùng PR đã thanh toán trong tháng (theo ngày thanh toán). NVL không mua trong tháng giữ giá công thức.</p>
            </section>
          </div>
        </>
      )}
    </div>
  );
}
