// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRef, type ReactNode } from "react";

import { DragSuppressContext, SessionRow, type RowBulkApi } from "../WorkspaceSidebar";
import { IdleDecayWindowContext } from "../../lib/idleDecay";
import { buildSessionGroups } from "../../lib/sidebarGroups";
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
      delete_to_trash: false,
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

function Wrap({ children, idleDecayWindowMs }: { children: ReactNode; idleDecayWindowMs: number }) {
  const dragSuppressRef = useRef(0);
  return (
    <IdleDecayWindowContext.Provider value={idleDecayWindowMs}>
      <DragSuppressContext.Provider value={dragSuppressRef}>{children}</DragSuppressContext.Provider>
    </IdleDecayWindowContext.Provider>
  );
}

function renderRow(
  ws: Workspace,
  callbacks: Partial<React.ComponentProps<typeof SessionRow>> = {},
  idleDecayWindowMs = 0,
) {
  return render(
    <Wrap idleDecayWindowMs={idleDecayWindowMs}>
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

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

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

  it("selects an exact sibling for ambiguous Start and Stop actions regardless of array order", () => {
    const cases = [
      {
        action: "start" as const,
        first: session({ id: "stopped-a", title: "Stopped A", status: "Stopped" }),
        selected: session({ id: "stopped-b", title: "Stopped B", status: "Stopped" }),
      },
      {
        action: "stop" as const,
        first: session({ id: "running-a", title: "Running A", status: "Running" }),
        selected: session({ id: "waiting-b", title: "Waiting B", status: "Waiting" }),
      },
    ];

    for (const { action, first, selected } of cases) {
      for (const candidates of [
        [first, selected],
        [selected, first],
      ]) {
        const onStart = vi.fn();
        const onStop = vi.fn();
        renderRow(workspace(candidates), { onStart, onStop });
        openMenu();

        expect(screen.queryByTestId(`sidebar-context-menu-${action}`)).toBeNull();
        expect(screen.getByTestId(`sidebar-context-menu-${action}-picker`)).toBeTruthy();
        fireEvent.click(screen.getByTestId(`sidebar-context-menu-${action}-session-${selected.id}`));

        const callback = action === "start" ? onStart : onStop;
        expect(callback).toHaveBeenCalledOnce();
        expect(callback).toHaveBeenCalledWith(selected.id);
        expect(callback).not.toHaveBeenCalledWith(first.id);
        cleanup();
      }
    }
  });

  it("keeps the canonical workspace id while a group slice targets its exact session id", () => {
    const canonical = workspace([
      session({ id: "primary-a", title: "Primary", group_path: "alpha", status: "Idle" }),
      session({ id: "sliced-b", title: "Sliced", group_path: "beta", status: "Running" }),
    ]);
    const groups = buildSessionGroups([canonical], {
      idleDecayWindowMs: 0,
      sortMode: "manual",
      isCollapsed: () => false,
    });
    const sliced = groups.find((group) => group.id === "beta")!.workspaces[0]!.workspace;
    const onStop = vi.fn();

    expect(sliced.id).toBe(canonical.id);
    expect(sliced.sessions.map((candidate) => candidate.id)).toEqual(["sliced-b"]);

    renderRow(sliced, { onStop });
    openMenu();
    fireEvent.click(screen.getByTestId("sidebar-context-menu-stop"));

    expect(onStop).toHaveBeenCalledWith("sliced-b");
    expect(onStop).not.toHaveBeenCalledWith(canonical.id);
  });

  it("gives Error precedence and keeps equal Error targets explicit", () => {
    const stopped = session({ id: "stopped-a", title: "Stopped", status: "Stopped" });
    const error = session({ id: "error-b", title: "Errored", status: "Error" });
    const onStop = vi.fn();

    renderRow(workspace([stopped, error]), { onStop });
    expect(screen.getByLabelText("Error · needs attention (error)")).toBeTruthy();
    openMenu();
    fireEvent.click(screen.getByTestId("sidebar-context-menu-stop"));
    expect(onStop).toHaveBeenCalledWith(error.id);
    expect(onStop).not.toHaveBeenCalledWith(stopped.id);

    for (const selectedId of ["error-a", "error-b"]) {
      cleanup();
      const onAmbiguousStop = vi.fn();
      renderRow(
        workspace([
          session({ id: "error-a", title: "Error A", status: "Error" }),
          session({ id: "error-b", title: "Error B", status: "Error" }),
        ]),
        { onStop: onAmbiguousStop },
      );
      expect(screen.getByLabelText("Error · needs attention (error)")).toBeTruthy();
      openMenu();
      expect(screen.queryByTestId("sidebar-context-menu-stop")).toBeNull();
      expect(screen.getByTestId("sidebar-context-menu-stop-picker")).toBeTruthy();
      fireEvent.click(screen.getByTestId(`sidebar-context-menu-stop-session-${selectedId}`));
      expect(onAmbiguousStop).toHaveBeenCalledOnce();
      expect(onAmbiguousStop).toHaveBeenCalledWith(selectedId);
    }
  });

  it("includes exact ids when lifecycle candidates otherwise have duplicate identities", () => {
    const candidates = [
      session({ id: "duplicate-a", title: "Same title", tool: "claude", status: "Stopped" }),
      session({ id: "duplicate-b", title: "Same title", tool: "claude", status: "Stopped" }),
    ];

    for (const selected of candidates) {
      const onStart = vi.fn();
      renderRow(workspace(candidates), { onStart });
      openMenu();

      for (const candidate of candidates) {
        expect(screen.getByTestId(`sidebar-context-menu-start-session-${candidate.id}`).textContent).toContain(
          candidate.id,
        );
      }
      fireEvent.click(screen.getByTestId(`sidebar-context-menu-start-session-${selected.id}`));
      expect(onStart).toHaveBeenCalledOnce();
      expect(onStart).toHaveBeenCalledWith(selected.id);
      expect(onStart).not.toHaveBeenCalledWith(candidates.find((candidate) => candidate.id !== selected.id)!.id);
      cleanup();
    }
  });

  it("treats only a fresh Idle sibling as active within the configured decay window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T12:00:00Z"));
    const decayed = session({ id: "idle-decayed", idle_entered_at: "2026-01-01T11:55:00Z" });
    const fresh = session({ id: "idle-fresh", idle_entered_at: "2026-01-01T11:59:30Z" });
    const onStop = vi.fn();

    renderRow(workspace([decayed, fresh]), { onStop }, 60_000);
    expect(screen.getByTestId("sidebar-session-row").querySelector(".text-status-fresh-idle")).toBeTruthy();
    openMenu();
    expect(screen.queryByTestId("sidebar-context-menu-stop-picker")).toBeNull();
    fireEvent.click(screen.getByTestId("sidebar-context-menu-stop"));

    expect(onStop).toHaveBeenCalledWith(fresh.id);
    expect(onStop).not.toHaveBeenCalledWith(decayed.id);
  });
});
