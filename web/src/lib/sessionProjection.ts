import type { SessionResponse, Workspace } from "./types";

/**
 * A sidebar row is either an aggregate presentation of a workspace or an
 * exact Session member. Only the latter can be the target of a Session
 * mutation.
 */
export type SessionProjectionRow =
  | {
      kind: "aggregate";
      workspaceId: string;
      sessionIds: readonly string[];
      sessionCount: number;
    }
  | {
      kind: "session";
      workspaceId: string;
      session: SessionResponse;
    };

/** Build the row model used at the sidebar action boundary. */
export function buildSessionProjectionRow(workspace: Workspace, sessionId?: string): SessionProjectionRow {
  if (sessionId !== undefined) {
    const session = workspace.sessions.find((candidate) => candidate.id === sessionId);
    if (session) {
      return { kind: "session", workspaceId: workspace.id, session };
    }

    return {
      kind: "aggregate",
      workspaceId: workspace.id,
      sessionIds: workspace.sessions.map((session) => session.id),
      sessionCount: workspace.sessions.length,
    };
  }

  if (workspace.sessions.length === 1) {
    return { kind: "session", workspaceId: workspace.id, session: workspace.sessions.at(0)! };
  }

  return {
    kind: "aggregate",
    workspaceId: workspace.id,
    sessionIds: workspace.sessions.map((session) => session.id),
    sessionCount: workspace.sessions.length,
  };
}

/** Construct an exact mutation target, or no target for an aggregate row. */
export function buildSessionActionTarget(row: SessionProjectionRow): { sessionId: string } | null {
  return row.kind === "session" ? { sessionId: row.session.id } : null;
}
