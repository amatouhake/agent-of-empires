import { safeGetItem, safeSetItem } from "./safeStorage";

/** The three user-facing projection axes in the sidebar. */
export type SidebarProjection = "all" | "projects" | "groups";

export const SIDEBAR_PROJECTION_KEY = "aoe-sidebar-projection";

export function loadSidebarProjection(): SidebarProjection {
  const value = safeGetItem(SIDEBAR_PROJECTION_KEY);
  return value === "all" || value === "groups" ? value : "projects";
}

export function saveSidebarProjection(projection: SidebarProjection): void {
  safeSetItem(SIDEBAR_PROJECTION_KEY, projection);
}

