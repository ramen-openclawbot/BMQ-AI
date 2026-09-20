// Sidebar shell for the VNAgent data-assets admin.
import type { ReactNode } from "react";
import { FileDown } from "lucide-react";
import type { Language } from "@/lib/dataAssets";

export interface DataAdminSection {
  key: string;
  label: string;
  icon: ReactNode;
  count?: number | null;
}

function t(language: Language, vi: string, en: string): string {
  return language === "en" ? en : vi;
}

export function DataAdminShell({
  sections,
  active,
  onSelect,
  language,
  onExport,
  children,
}: {
  sections: DataAdminSection[];
  active: string;
  onSelect: (key: string) => void;
  language: Language;
  onExport: () => void;
  children: ReactNode;
}) {
  return (
    <div className="da-root" data-vnagent-data-admin="v2" data-da-language={language}>
      <div className="da-layout">
        <aside className="da-sidebar">
          <div className="da-brand">
            <span className="da-brand-mark">VNAgent</span>
            <span className="da-brand-title">{t(language, "Quản trị dữ liệu", "Data assets admin")}</span>
            <span className="da-brand-note">{t(language, "Chỉ chủ doanh nghiệp · không huấn luyện model", "Owner only · no model training")}</span>
          </div>
          <nav className="da-nav" aria-label={t(language, "Khu vực quản trị dữ liệu", "Data admin sections")}>
            {sections.map((section) => (
              <button
                key={section.key}
                type="button"
                className="da-navbtn"
                aria-current={active === section.key ? "page" : undefined}
                onClick={() => onSelect(section.key)}
              >
                <span aria-hidden="true" style={{ display: "inline-flex" }}>{section.icon}</span>
                <span>{section.label}</span>
                {typeof section.count === "number" && <span className="da-navbtn-count">{section.count}</span>}
              </button>
            ))}
          </nav>
        </aside>

        <main className="da-main">
          <header className="da-head">
            <div>
              <h1 className="da-title">{t(language, "Tài sản dữ liệu", "Data assets")}</h1>
              <p className="da-sub">
                {t(
                  language,
                  "Thu thập lượt chat phân tích thành bộ dữ liệu riêng (không phải sổ nghiệp vụ). Raw → Curated → Gold có kiểm toán; Gold cần người duyệt thật và bằng chứng.",
                  "Analytics chat interactions are collected into a separate dataset (not a business ledger). Raw → Curated → Gold are audited; Gold needs a real reviewer and evidence.",
                )}
              </p>
            </div>
            <button type="button" className="da-btn da-btn--primary da-export-cta" onClick={onExport} data-da-export-cta="true">
              <FileDown size={16} aria-hidden="true" />
              {t(language, "Xuất .md", "Export .md")}
            </button>
          </header>
          {children}
        </main>
      </div>
    </div>
  );
}
