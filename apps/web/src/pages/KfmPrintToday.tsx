import KfmPrintWorkspace from "@/components/production/KfmPortalDialog";
import { useLanguage } from "@/contexts/LanguageContext";

export default function KfmPrintToday() {
  const { language } = useLanguage();
  return <KfmPrintWorkspace isVi={language === "vi"} />;
}
