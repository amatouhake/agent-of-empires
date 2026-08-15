// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRef, type ReactNode } from "react";

import { DragSuppressContext, SessionRow, type RowBulkApi } from "../WorkspaceSidebar";
import { EMPTY_OPTIMISTIC } from "../../lib/sidebarOptimistic";
import type { SessionResponse, Workspace } from "../../lib/types";

const SINGLE_BULK_API: RowBulkApi = {
  prepareScope: () => ({ kind: "single" }),
  pin: () => {},
  archive: () => {},
  snooze: () => {},
};

function session(over: Partial<SessionResponse> = {}): SessionResponse {
  return {
    id: "s1",
    title: "row title",
    project_path: "/repo",
    artifact_dir: "/repo/.artifacts",
    group_path: "",
    tool: "claude",
    status: "Idle",
    dormant: false,
    yolo_mode: false,
    created_at: "2026-01-01T00:00:00Z",
    last_accessed_at: null,
    idle_entered_at: null,
    last_error: null,
    branch: "feature/shared",
    main_repo_path: "/repo",
    is_sandboxed: false,
    scratch: false,
    favorited: false,
    has_managed_worktree: true,
    has_terminal: true,
    profile: "default",
    cleanup_defaults: {
      delete_worktree: false,
      delete_branch: false,
      delete_sandbox: false,
    },
    remote_owner: null,
    remote_owner_key: null,
    notify_on_waiting: null,
    notify_on_idle: null,
    notify_on_error: null,
    claude_fullscreen: false,
    workspace_repos: [],
    ...over,
  };
}

function workspace(sessions: SessionResponse[]): Workspace {
  return {
    id: "/repo::feature/shared",
    branch: "feature/shared",
    projectPath: "/repo",
    displayName: "feature/shared",
    agents: ["claude"],
    primaryAgent: "claude",
    status: sessions.some((candidate) => candidate.status === "Running") ? "active" : "idle",
    sessions,
  };
}

function Wrap({ children }: { children: ReactNode }) {
  const dragSuppressRef = useRef(0);
  return <DragSuppressContext.Provider value={dragSuppressRef}>{children}</DragSuppressContext.Provider>;
}

function renderRow(ws: Workspace, callbacks: Partial<React.ComponentProps<typeof SessionRow>> = {}) {
  return render(
    <Wrap>
      <SessionRow
        workspace={ws}
        isActive={false}
        isSelected={false}
        onActivate={() => {}}
        optimistic={EMPTY_OPTIMISTIC}
        onPinToggle={() => {}}
        onArchiveToggle={() => {}}
        onSnooze={() => {}}
        onUnreadToggle={() => {}}
        bulkApi={SINGLE_BULK_API}
        {...callbacks}
      />
    </Wrap>,
  );
}

function openMenu() {
  fireEvent.contextMenu(screen.getByTestId("sidebar-session-row"));
}

afterEach(cleanup);

describe("grouped SessionRow lifecycle actions", () => {
  it("stops the unique running sibling that supplies the grouped row state", () => {
    const idle = session({ id: "idle-a", status: "Idle" });
    const running = session({ id: "running-b", status: "Running" });
    const onStop = vi.fn();

    renderRow(workspace([idle, running]), { onStop });
    openMenu();
    fireEvent.click(screen.getByTestId("sidebar-context-menu-stop"));

    expect(onStop).toHaveBeenCalledWith("running-b");
    expect(onStop).not.toHaveBeenCalledWith("idle-a");
  });

  it("keeps single-session lifecycle and workspace-level Delete and Archive scopes unchanged", () => {
    const stopped = session({ id: "stopped-only", status: "Stopped" });
    const stoppedWorkspace = workspace([stopped]);
    const onStart = vi.fn();

    renderRow(stoppedWorkspace, { onStart });
    openMenu();
    fireEvent.click(screen.getByTestId("sidebar-context-menu-start"));
    expect(onStart).toHaveBeenCalledWith("stopped-only");

    cleanup();
    const running = session({ id: "running-only", status: "Running" });
    const onStop = vi.fn();
    renderRow(workspace([running]), { onStop });
    openMenu();
    fireEvent.click(screen.getByTestId("sidebar-context-menu-stop"));
    expect(onStop).toHaveBeenCalledWith("running-only");

    cleanup();
    const liveWorkspace = workspace([session({ id: "idle-only" })]);
    const onDelete = vi.fn();
    const onArchiveToggle = vi.fn();
    renderRow(liveWorkspace, { onDelete, onArchiveToggle });
    openMenu();
    fireEvent.click(screen.getByTestId("sidebar-context-menu-archive"));
    expect(onArchiveToggle).toHaveBeenCalledWith(liveWorkspace, true);

    openMenu();
    fireEvent.click(screen.getByTestId("sidebar-context-menu-delete"));
    expect(onDelete).toHaveBeenCalledWith(liveWorkspace.id);
  });

  it("does not select a lifecycle target by array order when the grouped state is ambiguous", () => {
    const running = session({ id: "running-a", status: "Running" });
    const waiting = session({ id: "waiting-b", status: "Waiting" });
    const stoppedA = session({ id: "stopped-a", status: "Stopped" });
    const stoppedB = session({ id: "stopped-b", status: "Stopped" });

    for (const candidates of [
      [running, waiting],
      [waiting, running],
      [stoppedA, stoppedB],
      [stoppedB, stoppedA],
    ]) {
      const ws = workspace(candidates);
      renderRow(ws, { onStop: vi.fn(), onStart: vi.fn() });
      openMenu();
      expect(screen.queryByTestId("sidebar-context-menu-stop")).toBeNull();
      expect(screen.queryByTestId("sidebar-context-menu-start")).toBeNull();
      cleanup();
    }
  });
});
