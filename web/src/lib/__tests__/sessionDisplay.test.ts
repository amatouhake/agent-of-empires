import { describe, expect, it, vi } from "vitest";
import type { SessionResponse, SessionStatus, Workspace } from "../types";
import {
  aggregateSessionDisplay,
  groupedParentNavigationSession,
  groupedStatusCandidates,
  sessionsInDisplayOrder,
  sidebarSessionsInDisplayOrder,
} from "../sessionDisplay";

function session(over: Partial<SessionResponse> = {}): SessionResponse {
  return {
    id: "s1",
    title: "Session",
    project_path: "/p",
    group_path: "/p",
    tool: "claude",
    status: "Idle",
    dormant: false,
    yolo_mode: false,
    created_at: "2025-01-01T00:00:00Z",
    last_accessed_at: null,
    idle_entered_at: null,
    last_error: null,
    branch: "feature/shared",
    main_repo_path: null,
    is_sandboxed: false,
    favorited: false,
    has_managed_worktree: true,
    has_terminal: true,
    profile: "default",
    cleanup_defaults: {
      delete_worktree: false,
      delete_branch: false,
      delete_sandbox: false,
      delete_to_trash: false,
    },
    remote_owner: null,
    notify_on_waiting: null,
    notify_on_idle: null,
    notify_on_error: null,
    claude_fullscreen: false,
    workspace_repos: [],
    ...over,
  };
}

function sessionsWithStatuses(statuses: readonly SessionStatus[]): SessionResponse[] {
  return statuses.map((status, index) =>
    session({
      id: `${status}-${index}`,
      title: `${status}-${index}`,
      status,
      created_at: `2025-01-${String(index + 1).padStart(2, "0")}T00:00:00Z`,
    }),
  );
}

function workspace(id: string, sessions: SessionResponse[]): Workspace {
  return {
    id,
    branch: "feature/shared",
    projectPath: "/p",
    displayName: id,
    agents: ["claude"],
    primaryAgent: "claude",
    status: "idle",
    sessions,
  };
}

describe("shared-worktree session display", () => {
  it("shares lifecycle candidate classes while aggregating deterministically", () => {
    const cases: Array<{
      statuses: SessionStatus[];
      candidates: SessionStatus[];
      expected: SessionStatus;
      navigable: boolean;
    }> = [
      { statuses: ["Running", "Error"], candidates: ["Running"], expected: "Running", navigable: true },
      { statuses: ["Error", "Running"], candidates: ["Running"], expected: "Running", navigable: true },
      {
        statuses: ["Running", "Waiting"],
        candidates: ["Running", "Waiting"],
        expected: "Waiting",
        navigable: true,
      },
      {
        statuses: ["Waiting", "Running"],
        candidates: ["Running", "Waiting"],
        expected: "Waiting",
        navigable: true,
      },
      { statuses: ["Idle", "Error"], candidates: ["Error"], expected: "Error", navigable: true },
      { statuses: ["Error", "Idle"], candidates: ["Error"], expected: "Error", navigable: true },
      { statuses: ["Idle", "Deleting"], candidates: ["Deleting", "Idle"], expected: "Idle", navigable: true },
      { statuses: ["Deleting", "Idle"], candidates: ["Deleting", "Idle"], expected: "Idle", navigable: true },
      {
        statuses: ["Deleting", "Deleting"],
        candidates: ["Deleting", "Deleting"],
        expected: "Deleting",
        navigable: false,
      },
    ];

    for (const { statuses, candidates, expected, navigable } of cases) {
      const sessions = sessionsWithStatuses(statuses);
      expect(
        groupedStatusCandidates(sessions, 0)
          .map((item) => item.status)
          .sort(),
        statuses.join(" + "),
      ).toEqual(candidates);
      expect(aggregateSessionDisplay(sessions, 0).status, statuses.join(" + ")).toBe(expected);
      expect(groupedParentNavigationSession(sessions, null) !== null, statuses.join(" + ")).toBe(navigable);
    }
  });

  it("ranks fresh Idle separately and uses visible order to resolve representative fields", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-02-01T00:00:00Z"));
    try {
      const freshOlder = session({
        id: "fresh",
        title: "Fresh",
        status: "Idle",
        created_at: "2025-01-01T00:00:00Z",
        idle_entered_at: "2025-01-31T23:59:30Z",
      });
      const ordinaryNewer = session({
        id: "ordinary",
        title: "Ordinary",
        status: "Idle",
        created_at: "2025-01-02T00:00:00Z",
        idle_entered_at: "2025-01-01T00:00:00Z",
      });
      const creatingNewest = session({
        id: "creating",
        title: "Creating",
        status: "Creating",
        created_at: "2025-01-04T00:00:00Z",
      });
      expect(aggregateSessionDisplay([ordinaryNewer, creatingNewest, freshOlder], 60_000).createdAt).toBe(
        freshOlder.created_at,
      );

      const sameRankVisibleFirst = session({
        id: "a",
        title: "A",
        status: "Idle",
        created_at: "2025-01-03T00:00:00Z",
      });
      expect(aggregateSessionDisplay([ordinaryNewer, sameRankVisibleFirst], 0).createdAt).toBe(
        sameRankVisibleFirst.created_at,
      );

      const stoppedNewest = session({
        id: "stopped",
        title: "Stopped",
        status: "Stopped",
        created_at: "2025-01-05T00:00:00Z",
      });
      expect(aggregateSessionDisplay([ordinaryNewer, stoppedNewest], 0).createdAt).toBe(stoppedNewest.created_at);
    } finally {
      vi.useRealTimers();
    }
  });

  it("orders children by created_at descending, then title and id ascending", () => {
    const sessions = [
      session({ id: "z", title: "Zed", created_at: "2025-01-01T00:00:00Z" }),
      session({ id: "b", title: "Alpha", created_at: "2025-01-02T00:00:00Z" }),
      session({ id: "a", title: "Alpha", created_at: "2025-01-02T00:00:00Z" }),
      session({ id: "c", title: "Beta", created_at: "2025-01-02T00:00:00Z" }),
    ];
    expect(sessionsInDisplayOrder(sessions).map((item) => item.id)).toEqual(["a", "b", "c", "z"]);
  });

  it("keeps a navigable active child, otherwise picks the first visible navigable child", () => {
    const older = session({
      id: "older",
      title: "Creator",
      status: "Running",
      created_at: "2025-01-01T00:00:00Z",
    });
    const newest = session({
      id: "newest",
      title: "Reviewer",
      status: "Idle",
      created_at: "2025-01-02T00:00:00Z",
    });
    const deleting = session({
      id: "deleting",
      title: "Deleting",
      status: "Deleting",
      created_at: "2025-01-03T00:00:00Z",
    });

    const cases = [
      { sessions: [newest, older], active: "older", expected: "older" },
      { sessions: [older, newest], active: null, expected: "newest" },
      { sessions: [older, deleting, newest], active: null, expected: "newest" },
      { sessions: [older, deleting, newest], active: "deleting", expected: "newest" },
    ];
    for (const item of cases) {
      expect(groupedParentNavigationSession(item.sessions, item.active)?.id).toBe(item.expected);
    }
  });

  it("flattens attention navigation in the same grouped child display order", () => {
    const older = session({ id: "older", title: "Creator", created_at: "2025-01-01T00:00:00Z" });
    const newest = session({ id: "newest", title: "Reviewer", created_at: "2025-01-02T00:00:00Z" });
    const standalone = session({ id: "standalone", branch: null });
    const groups = [
      {
        workspaces: [
          { workspace: workspace("shared", [older, newest]) },
          { workspace: { ...workspace("single", [standalone]), branch: null } },
        ],
      },
    ];
    expect(sidebarSessionsInDisplayOrder(groups).map((item) => item.id)).toEqual(["newest", "older", "standalone"]);
  });
});
