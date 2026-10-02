import { Link } from "react-router-dom";
import { AlertTriangle, ArrowUpRight, Factory, FileCheck, Inbox, Sparkles, Store, type LucideIcon } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAuth } from "@/contexts/AuthContext";
import { AddPaymentRequestDialog } from "@/components/dialogs/AddPaymentRequestDialog";
import { RevenueChannelChart, CHANNEL_META, CHANNEL_ORDER, formatMillions } from "@/components/overview/RevenueChannelChart";
import { useOverviewSummary } from "@/hooks/useOverviewSummary";
import type { OverviewMetric } from "@/lib/overview/overview-summary";
import { openAgentChat } from "@/components/layout/useShellNav";
import { cn } from "@/lib/utils";
import "@/styles/bmq-overview.css";

type Lang = "vi" | "en";

const PRODUCTION_STATUS: Record<string, { vi: string; en: string }> = {
  draft: { vi: "Nháp", en: "Draft" },
  planned: { vi: "Đã lên kế hoạch", en: "Planned" },
  in_progress: { vi: "Đang làm", en: "In progress" },
  completed: { vi: "Hoàn thành", en: "Completed" },
  cancelled: { vi: "Đã huỷ", en: "Cancelled" },
};

const longDate = (language: Lang) =>
  new Intl.DateTimeFormat(language === "en" ? "en-GB" : "vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh",
    weekday: "long",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(new Date());

const visible = (m: OverviewMetric<unknown>) => m.note !== "no_permission";

/** Value area of a metric card: loading, error and missing-source never read as 0. */
function MetricValue({ m, loading, language }: { m: OverviewMetric<number>; loading: boolean; language: Lang }) {
  const en = language === "en";
  if (m.status === "error") return <p className="d3-ov-state is-error">{en ? "Could not load" : "Không tải được"}</p>;
  if (m.status === "unavailable") {
    return loading ? (
      <span className="d3-ov-skel" aria-label={en ? "Loading" : "Đang tải"} />
    ) : (
      <p className="d3-ov-state">{en ? "No source yet" : "Chưa có nguồn"}</p>
    );
  }
  return <span className="d3-ov-n">{(m.value ?? 0).toLocaleString(en ? "en-US" : "vi-VN")}</span>;
}

interface InsightCardProps {
  m: OverviewMetric<number>;
  loading: boolean;
  icon: LucideIcon;
  title: string;
  hint: string;
  tone?: "alert";
  language: Lang;
  index: number;
}

function InsightCard({ m, loading, icon: Icon, title, hint, tone, language, index }: InsightCardProps) {
  const hot = tone === "alert" && m.status === "ok" && (m.value ?? 0) > 0;
  return (
    <Link to={m.href} className={cn("d3-ov-insight", hot && "is-hot")} style={{ ["--i" as string]: index }}>
      <span className="d3-ov-insight-top">
        <Icon className="h-4 w-4" aria-hidden="true" />
        <ArrowUpRight className="d3-ov-go h-4 w-4" aria-hidden="true" />
      </span>
      <h3>{title}</h3>
      <p>{hint}</p>
      <div className="d3-ov-insight-foot">
        <MetricValue m={m} loading={loading} language={language} />
      </div>
    </Link>
  );
}

const Index = () => {
  const { language } = useLanguage();
  const { isOwner, session, user, authzLoaded } = useAuth();
  const lang: Lang = language === "en" ? "en" : "vi";
  const en = lang === "en";
  const s = useOverviewSummary();
  // Same gate as the VNAgent chat widget.
  const agentChatEnabled = Boolean(authzLoaded && isOwner && session?.access_token && user?.id);

  const revenue = s.revenue14d;
  const revenueSummary = revenue.value;
  const lastDayWithRevenue = revenueSummary ? [...revenueSummary.days].reverse().find((day) => day.total > 0)?.day : undefined;

  const insights = [
    {
      m: s.pendingApprovalsToday,
      icon: FileCheck,
      tone: "alert" as const,
      title: en ? "Payment requests to approve" : "Phiếu chờ duyệt",
      hint: en ? "Created today, waiting for a decision" : "Đề nghị chi tạo hôm nay đang chờ quyết định",
    },
    {
      m: s.lowStock,
      icon: AlertTriangle,
      tone: "alert" as const,
      title: en ? "Low stock items" : "Hàng sắp hết",
      hint: en ? "At or below the reorder level" : "Mặt hàng chạm mức cảnh báo tồn",
    },
    {
      m: s.salesPoNewToday,
      icon: Inbox,
      title: en ? "New sales POs to confirm" : "PO bán mới chờ xác nhận",
      hint: en ? "Arrived today, awaiting confirmation" : "Về trong hôm nay, chưa xác nhận",
    },
    {
      m: s.kioskReportsToday,
      icon: Store,
      title: en ? "Points reported today" : "Điểm bán đã báo cáo",
      hint: en ? "Kiosks that submitted today's report" : "Số điểm đã gửi báo cáo ngày hôm nay",
    },
  ].filter((item) => visible(item.m));

  const production = s.productionToday;
  const showRevenue = visible(revenue);
  const showProduction = visible(production);
  const nothingToShow = !showRevenue && insights.length === 0 && !showProduction && !agentChatEnabled;

  return (
    <div className="d3-ov" data-bmq-overview="demo3-v1">
      <header className="d3-ov-head">
        <div>
          <span className="d3-ov-date">{longDate(lang)}</span>
          <h1>
            {en ? "Overview" : "Tổng quan"} <b>{en ? "today" : "hôm nay"}</b>
          </h1>
        </div>
        <AddPaymentRequestDialog />
      </header>

      {showRevenue && (
        <div className="d3-ov-row is-revenue">
          <section className="d3-ov-card d3-ov-hero" style={{ ["--i" as string]: 1 }}>
            <span className="d3-ov-glow is-red" aria-hidden="true" />
            <span className="d3-ov-glow is-green" aria-hidden="true" />
            <div className="d3-ov-card-h">
              <h2>{en ? "Revenue, 14 days" : "Doanh thu 14 ngày"}</h2>
              <Link to={revenue.href} className="d3-ov-ghost">
                {en ? "Details" : "Chi tiết"}
              </Link>
            </div>
            {revenue.status === "error" ? (
              <p className="d3-ov-state is-error">{en ? "Could not load the revenue ledger." : "Không tải được sổ doanh thu."}</p>
            ) : !revenueSummary ? (
              <span className="d3-ov-skel is-big" aria-label={en ? "Loading" : "Đang tải"} />
            ) : (
              <>
                <div className="d3-ov-big">
                  <span>{formatMillions(revenueSummary.total, lang)}</span>
                  <small>{en ? "million VND" : "triệu đồng"}</small>
                </div>
                <p className="d3-ov-sub">
                  {en ? "Controlled ledger" : "Sổ doanh thu đã kiểm soát"}
                  {lastDayWithRevenue
                    ? ` · ${en ? "latest day with figures" : "ngày gần nhất có số"} ${lastDayWithRevenue.slice(8, 10)}/${lastDayWithRevenue.slice(5, 7)}`
                    : ` · ${en ? "no figures in this window" : "chưa có số trong 14 ngày"}`}
                </p>
                <ul className="d3-ov-share">
                  {CHANNEL_ORDER.filter((group) => revenueSummary.totals[group] > 0).map((group, k) => {
                    const share = revenueSummary.total ? revenueSummary.totals[group] / revenueSummary.total : 0;
                    return (
                      <li
                        key={group}
                        style={{ ["--c" as string]: CHANNEL_META[group].color, ["--p" as string]: share, ["--dl" as string]: `${500 + k * 120}ms` }}
                      >
                        <span>{en ? CHANNEL_META[group].en : CHANNEL_META[group].vi}</span>
                        <em>
                          {formatMillions(revenueSummary.totals[group], lang)} {en ? "M" : "tr"} · {Math.round(share * 100)}%
                        </em>
                        <i aria-hidden="true">
                          <b />
                        </i>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
          </section>

          <section className="d3-ov-card" style={{ ["--i" as string]: 2 }}>
            <div className="d3-ov-card-h">
              <h2>{en ? "Sales channels" : "Kênh bán hàng"}</h2>
              <span className="d3-ov-unit">{en ? "million VND / day" : "triệu / ngày"}</span>
            </div>
            {revenue.status === "error" ? (
              <p className="d3-ov-state is-error">
                {en ? "Chart unavailable while the ledger cannot be read." : "Chưa vẽ được biểu đồ vì không đọc được sổ doanh thu."}
              </p>
            ) : !revenueSummary ? (
              <span className="d3-ov-skel is-chart" />
            ) : revenueSummary.total === 0 ? (
              <p className="d3-ov-state">{en ? "No controlled revenue in the last 14 days." : "14 ngày gần nhất chưa có doanh thu đã kiểm soát."}</p>
            ) : (
              <RevenueChannelChart summary={revenueSummary} language={lang} />
            )}
          </section>
        </div>
      )}

      {insights.length > 0 && (
        <section className="d3-ov-block" style={{ ["--i" as string]: 3 }}>
          <div className="d3-ov-block-h">
            <h2>{en ? "Needs attention today" : "Cần chú ý hôm nay"}</h2>
          </div>
          <div className="d3-ov-insights" data-count={insights.length}>
            {insights.map((item, k) => (
              <InsightCard key={item.title} {...item} loading={s.isLoading} language={lang} index={k} />
            ))}
          </div>
        </section>
      )}

      {(showProduction || agentChatEnabled) && (
        <div className={cn("d3-ov-row", showProduction && agentChatEnabled ? "is-split" : "is-single")}>
          {showProduction && (
            <section className="d3-ov-card" style={{ ["--i" as string]: 4 }}>
              <span className="d3-ov-glow is-green is-low" aria-hidden="true" />
              <div className="d3-ov-card-h">
                <h2>{en ? "Production today" : "Sản xuất hôm nay"}</h2>
                <Link to={production.href} className="d3-ov-ghost">
                  {en ? "Open plan" : "Mở kế hoạch"}
                </Link>
              </div>
              {production.status === "error" ? (
                <p className="d3-ov-state is-error">{en ? "Could not load production orders." : "Không tải được lệnh sản xuất."}</p>
              ) : !production.value ? (
                <span className="d3-ov-skel is-big" />
              ) : production.value.total === 0 ? (
                <p className="d3-ov-state">{en ? "No production orders start today." : "Hôm nay chưa có lệnh sản xuất nào bắt đầu."}</p>
              ) : (
                <>
                  <div className="d3-ov-big is-mid">
                    <span>{production.value.total}</span>
                    <small>
                      <Factory className="mr-1 inline h-3.5 w-3.5" aria-hidden="true" />
                      {en ? "orders starting today" : "lệnh bắt đầu hôm nay"}
                    </small>
                  </div>
                  <ul className="d3-ov-status">
                    {Object.entries(production.value.byStatus).map(([status, count]) => (
                      <li key={status} data-status={status}>
                        <span>{PRODUCTION_STATUS[status]?.[lang] ?? status}</span>
                        <b>{count}</b>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </section>
          )}

          {agentChatEnabled && (
            <section className="d3-ov-card d3-ov-ai" style={{ ["--i" as string]: 5 }}>
              <span className="d3-ov-glow is-pink" aria-hidden="true" />
              <div className="d3-ov-card-h">
                <h2>{en ? "Ask BMQ AI" : "Hỏi BMQ AI"}</h2>
              </div>
              <p className="d3-ov-sub">
                {en
                  ? "Ask about revenue, stock or costs. Answers cite their source; the AI never approves or pays."
                  : "Hỏi về doanh thu, kho, chi phí. Câu trả lời có nguồn; AI không tự duyệt hay thanh toán."}
              </p>
              <button type="button" className="d3-ov-ask" onClick={openAgentChat}>
                <span className="d3-ov-spark">
                  <Sparkles className="h-4 w-4" aria-hidden="true" />
                </span>
                <span>{en ? "Open the AI chat" : "Mở trò chuyện với BMQ AI"}</span>
                <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
              </button>
            </section>
          )}
        </div>
      )}

      {nothingToShow && (
        <p className="d3-ov-state">
          {en
            ? "Your account has no overview figures. Use the areas in the top bar."
            : "Tài khoản chưa có chỉ số tổng quan. Hãy chọn khu chức năng ở thanh trên."}
        </p>
      )}
    </div>
  );
};

export default Index;
