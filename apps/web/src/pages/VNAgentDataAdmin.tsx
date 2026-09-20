// Owner-only VNAgent data-assets admin (route /data-admin and future admin.vnagent.ai).
import { useMemo, useState } from "react";
import { ClipboardCheck, Database, FileDown, LayoutDashboard, MessageSquarePlus, Activity, Wand2 } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { DataAdminShell, type DataAdminSection } from "@/components/data-admin/DataAdminShell";
import { ErrorBlock, LoadingBlock } from "@/components/data-admin/shared";
import { OverviewPanel } from "@/components/data-admin/OverviewPanel";
import { RepositoryPanel } from "@/components/data-admin/RepositoryPanel";
import { ReviewQueuePanel } from "@/components/data-admin/ReviewQueuePanel";
import { ContributionsPanel } from "@/components/data-admin/ContributionsPanel";
import { GeneratePanel } from "@/components/data-admin/GeneratePanel";
import { JevLogsPanel } from "@/components/data-admin/JevLogsPanel";
import { ExportPanel } from "@/components/data-admin/ExportPanel";
import { ADMIN_LANGUAGE } from "@/lib/dataAssets";
import "@/styles/data-admin.css";

type SectionKey = "overview" | "repository" | "review" | "contributions" | "generate" | "jev" | "export";

export default function VNAgentDataAdmin() {
  const { isOwner, user, authzLoaded, authzError, refreshRoles } = useAuth();
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
    { key: "generate", label: language === "en" ? "Generate data" : "Tạo câu hỏi tổng hợp", icon: <Wand2 size={16} /> },
    { key: "jev", label: language === "en" ? "Jev logs" : "Nhật ký Jev", icon: <Activity size={16} /> },
    { key: "export", label: language === "en" ? "Markdown export" : "Xuất Markdown", icon: <FileDown size={16} /> },
  ], [language]);

  // This page is the single owner gate for the admin surface (the route tree no
  // longer redirects non-owners). Roles/permissions load asynchronously after
  // the session resolves, so never decide "denied" from the initial empty role
  // list: wait for authzLoaded, and fail closed with an English retry if that
  // check errored. Without this wait an owner sees a false denial on first paint.
  if (user && !authzLoaded) {
    return (
      <div className="da-root">
        <div className="da-layout" style={{ gridTemplateColumns: "minmax(0, 1fr)" }}>
          <main className="da-main" data-da-authz={authzError ? "error" : "checking"}>
            {authzError ? (
              <ErrorBlock
                message="We couldn't verify your access rights, so this admin stays locked. Please try again."
                onRetry={() => void refreshRoles()}
                retryLabel="Try again"
              />
            ) : (
              <LoadingBlock label="Checking access…" />
            )}
          </main>
        </div>
      </div>
    );
  }

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
      {active === "generate" && <GeneratePanel language={language} ownerId={user.id} />}
      {active === "jev" && <JevLogsPanel language={language} />}
      {active === "export" && <ExportPanel language={language} />}
    </DataAdminShell>
  );
}
