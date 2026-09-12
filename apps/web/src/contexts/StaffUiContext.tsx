import { createContext, useContext, type ReactNode } from "react";
import { useLanguage } from "./LanguageContext";
import { staff } from "@/i18n/staff";

// Only the staff layout opts in. Dealer/kiosk primitives retain their existing copy.
const StaffUiContext = createContext(staff.en);

export function StaffUiProvider({ children }: { children: ReactNode }) {
  const { messages } = useLanguage();
  return <StaffUiContext.Provider value={messages.staff}>{children}</StaffUiContext.Provider>;
}

export function useStaffUi() {
  return useContext(StaffUiContext);
}
