import { useMemo } from "react";
import { useLocation } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { useLanguage } from "@/contexts/LanguageContext";
import type { NavAccess } from "./navAccess";
import {
  UTILITY_GROUPS,
  ZONES,
  utilityGroupForPath,
  visiblePages,
  zoneForPath,
  type ShellPage,
  type UtilityGroup,
  type Zone,
} from "./navigation";

export interface VisibleZone {
  zone: Zone;
  pages: ShellPage[];
  /** Where the tab goes: the first page the user may open. */
  href: string | null;
}

export interface VisibleUtilityGroup {
  group: UtilityGroup;
  pages: ShellPage[];
}

export function useShellNav() {
  const { pathname } = useLocation();
  const { language } = useLanguage();
  const { isOwner, canAccessModule, authzLoaded, session, user } = useAuth();

  // Same gate as GlobalAgentChatWidget: the chat only mounts for signed-in owners.
  const agentChatEnabled = Boolean(authzLoaded && isOwner && session?.access_token && user?.id);

  const access: NavAccess = useMemo(
    () => ({
      isOwner,
      canAccessModule,
      dataPlatformEnabled: import.meta.env.VITE_BMQ_DATA_PLATFORM_ENABLED === "true",
    }),
    [isOwner, canAccessModule],
  );

  const zones: VisibleZone[] = useMemo(
    () =>
      ZONES.map((zone) => {
        const pages = visiblePages(zone.paths, access);
        return { zone, pages, href: pages[0]?.path ?? null };
      }).filter(({ zone, pages }) => (zone.id === "ai" ? agentChatEnabled : pages.length > 0)),
    [access, agentChatEnabled],
  );

  const utilities: VisibleUtilityGroup[] = useMemo(
    () =>
      UTILITY_GROUPS.map((group) => ({ group, pages: visiblePages(group.paths, access) })).filter(
        ({ pages }) => pages.length > 0,
      ),
    [access],
  );

  const activeZone = zoneForPath(pathname);
  const activeUtility = activeZone ? null : utilityGroupForPath(pathname);
  const label = (value: { vi: string; en: string }) => (language === "en" ? value.en : value.vi);

  return { pathname, language, access, zones, utilities, activeZone, activeUtility, agentChatEnabled, label };
}

export const openAgentChat = () => window.dispatchEvent(new Event("bmq:open-agent-chat"));
export const openAppDrawer = () => window.dispatchEvent(new Event("bmq:open-sidebar"));
