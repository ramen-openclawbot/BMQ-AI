import { useLanguage } from "@/contexts/LanguageContext";
import { dSku } from "./dSku";

export function useDSkuCopy() {
  const { language } = useLanguage();
  return dSku[language];
}
