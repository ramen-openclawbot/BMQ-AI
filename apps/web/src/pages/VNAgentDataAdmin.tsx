// Owner-only VNAgent data-assets admin (route /data-admin and future admin.vnagent.ai).
import { useMemo, useState } from "react";
import { ClipboardCheck, Database, FileDown, LayoutDashboard, MessageSquarePlus, Activity } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { DataAdminShell, type DataAdminSection } from "@/components/data-admin/DataAdminShell";
import { OverviewPanel } from "@/components/data-admin/OverviewPanel";
import { RepositoryPanel } from "@/components/data-admin/RepositoryPanel";
import { ReviewQueuePanel } from "@/components/data-admin/ReviewQueuePanel";
import { ContributionsPanel } from "@/components/data-admin/ContributionsPanel";
import { JevLogsPanel } from "@/components/data-admin/JevLogsPanel";
import { ExportPanel } from "@/components/data-admin/ExportPanel";
import { ADMIN_LANGUAGE } from "@/lib/dataAssets";
import "@/styles/data-admin.css";

type SectionKey = "overview" | "repository" | "review" | "contributions" | "jev" | "export";

export default function VNAgentDataAdmin() {
  const { isOwner, user } = useAuth();
  // English is the admin default and comes from its own constant, NOT from
  // LanguageContext or the shared `app-language` localStorage key. A BMQ user
  // with a Vietnamese app preference still gets an English admin.
  const language = ADMIN_LANGUAGE;
  const [active, setActive] = useState<SectionKey>("overview");

  const sections = useMemo<DataAdminSection[]>(() => [
    { key: "overview", label: language === "en" ? "Overview" : "Tổng quan", icon: <LayoutDashboard size={16} /> },
    { key: "repository", label: language === "en" ? "Repository" : "Kho dữ liệu", icon: <Database size={16} /> },
    { key: "review", label: language === "en" ? "Review queue" : "Hàng chờ duyệt", icon: <ClipboardCheck size={16} /> },
    { key: "contributions", label: language === "en" ? "Contributions" : "Đóng góp câu hỏi", icon: <MessageSquarePlus size={16} /> },
    { key: "jev", label: language === "en" ? "Jev logs" : "Nhật ký Jev", icon: <Activity size={16} /> },
    { key: "export", label: language === "en" ? "Markdown export" : "Xuất Markdown", icon: <FileDown size={16} /> },
  ], [language]);

  if (!isOwner || !user) {
    return (
      <div className="da-root">
        <div className="da-layout" style={{ gridTemplateColumns: "minmax(0, 1fr)" }}>
          <main className="da-main">
            <div className="da-alert da-alert--error" role="alert" data-da-denied="owner-only">
              {language === "en"
                ? "The VNAgent data admin is available to business owners only."
                : "Trang quản trị dữ liệu VNAgent chỉ dành cho chủ doanh nghiệp."}
            </div>
          </main>
        </div>
      </div>
    );
  }

  return (
    // Remount the whole panel subtree when the signed-in actor changes, so an
    // account switch can never show the previous owner's cached rows and an
    // in-flight response from the old session cannot land on the new one.
    <DataAdminShell
      key={user.id}
      sections={sections}
      active={active}
      onSelect={(key) => setActive(key as SectionKey)}
      onExport={() => setActive("export")}
      language={language}
    >
      {active === "overview" && <OverviewPanel language={language} />}
      {active === "repository" && <RepositoryPanel language={language} />}
      {active === "review" && <ReviewQueuePanel language={language} />}
      {active === "contributions" && <ContributionsPanel language={language} />}
      {active === "jev" && <JevLogsPanel language={language} />}
      {active === "export" && <ExportPanel language={language} />}
    </DataAdminShell>
  );
}
