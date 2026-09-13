import { useLanguage } from "@/contexts/LanguageContext";
import { productionCopy } from "./production";

export function useProductionCopy() {
  const { language } = useLanguage();
  return productionCopy[language];
}
