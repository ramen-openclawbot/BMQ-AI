import { useLanguage } from "@/contexts/LanguageContext";
import { warehouse, type WarehouseCopyKey } from "./warehouse";

export function useWarehouseCopy() {
  const { language } = useLanguage();
  return (key: WarehouseCopyKey, values: Record<string, string | number> = {}) =>
    warehouse[language][key].replace(/\{(\w+)\}/g, (token, name) =>
      Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : token);
}
