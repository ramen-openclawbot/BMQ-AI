/** Permission predicate shared by the app drawer (Sidebar) and the top navigation. */
export interface NavAccessRule {
  moduleKey?: string;
  ownerOnly?: boolean;
  dataPlatformOnly?: boolean;
}

export interface NavAccess {
  isOwner: boolean;
  canAccessModule: (moduleKey: string) => boolean;
  dataPlatformEnabled: boolean;
}

export function canViewNavItem(item: NavAccessRule, access: NavAccess): boolean {
  if (item.dataPlatformOnly && !access.dataPlatformEnabled) return false;
  if (item.ownerOnly && !access.isOwner) return false;
  if (item.moduleKey && !item.ownerOnly) return access.canAccessModule(item.moduleKey);
  return true;
}
