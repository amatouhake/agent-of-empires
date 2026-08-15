import { isSessionActive } from "./session";
import type { SessionResponse, SessionStatus, Workspace } from "./types";

/** Stable order used for visible children inside a grouped worktree. */
export function compareSessionsByDisplayOrder(a: SessionResponse, b: SessionResponse): number {
  return b.created_at.localeCompare(a.created_at) || a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
}

export function sessionsInDisplayOrder(sessions: readonly SessionResponse[]): SessionResponse[] {
  return [...sessions].sort(compareSessionsByDisplayOrder);
}

const ACTIVE_DISPLAY_STATUS_RANK: Partial<Record<SessionStatus, number>> = {
  Waiting: 0,
  Running: 1,
  Starting: 2,
  Idle: 3,
};

/** The pre-existing grouped lifecycle candidate-class precedence. */
export function groupedStatusCandidates(
  sessions: readonly SessionResponse[],
  idleDecayWindowMs: number,
): SessionResponse[] {
  const active = sessions.filter((session) => isSessionActive(session, idleDecayWindowMs));
  if (active.length > 0) return active;
  const errors = sessions.filter((session) => session.status === "Error");
  return errors.length > 0 ? errors : [...sessions];
}

function compareStatusRepresentatives(a: SessionResponse, b: SessionResponse, activeClass: boolean): number {
  const navigability = Number(isSessionNavigable(b)) - Number(isSessionNavigable(a));
  if (navigability !== 0) return navigability;
  const activePriority = activeClass
    ? (ACTIVE_DISPLAY_STATUS_RANK[a.status] ?? Number.POSITIVE_INFINITY) -
      (ACTIVE_DISPLAY_STATUS_RANK[b.status] ?? Number.POSITIVE_INFINITY)
    : 0;
  return activePriority || compareSessionsByDisplayOrder(a, b);
}

export interface AggregateSessionDisplay {
  status: SessionStatus;
  createdAt: string | null;
  idleEnteredAt: string | null;
  dormant: boolean;
}

/**
 * Pick the grouped parent's display state from the same semantic candidate
 * class as lifecycle actions. Within that class, active states have explicit
 * user-significance priority; resting states use stable visible order, with a
 * usable sibling ahead of Deleting.
 */
export function aggregateSessionDisplay(
  sessions: readonly SessionResponse[],
  idleDecayWindowMs: number,
): AggregateSessionDisplay {
  const candidates = groupedStatusCandidates(sessions, idleDecayWindowMs);
  const activeClass = candidates.some((session) => isSessionActive(session, idleDecayWindowMs));
  const representative = candidates.sort((a, b) => compareStatusRepresentatives(a, b, activeClass))[0];
  if (representative?.status === "Error") {
    return {
      status: "Error",
      createdAt: representative.created_at,
      idleEnteredAt: null,
      dormant: false,
    };
  }
  return {
    status: representative?.status ?? "Unknown",
    createdAt: representative?.created_at ?? null,
    idleEnteredAt: representative?.idle_entered_at ?? null,
    dormant: representative?.dormant ?? false,
  };
}

export function isSessionNavigable(session: SessionResponse): boolean {
  return session.status !== "Deleting";
}

/** Resolve a grouped parent to the active child or its first visible usable child. */
export function groupedParentNavigationSession(
  sessions: readonly SessionResponse[],
  activeSessionId: string | null | undefined,
): SessionResponse | null {
  const visible = sessionsInDisplayOrder(sessions);
  const active = activeSessionId == null ? undefined : visible.find((session) => session.id === activeSessionId);
  if (active && isSessionNavigable(active)) return active;
  return visible.find(isSessionNavigable) ?? null;
}

type SidebarGroupLike = {
  workspaces: readonly { workspace: Workspace }[];
};

/** Flatten sessions exactly as parent rows and their child rows are displayed. */
export function sidebarSessionsInDisplayOrder(groups: readonly SidebarGroupLike[]): SessionResponse[] {
  return groups.flatMap((group) =>
    group.workspaces.flatMap(({ workspace }) =>
      workspace.sessions.length > 1 ? sessionsInDisplayOrder(workspace.sessions) : workspace.sessions,
    ),
  );
}
