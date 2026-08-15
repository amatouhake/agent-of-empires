import type { Page } from "@playwright/test";
import { test, expect } from "./helpers/mockedTest";

type LifecycleStatus = "Idle" | "Running" | "Starting" | "Stopped";

interface MockSession {
  id: string;
  title: string;
  status: LifecycleStatus;
}

interface LifecycleHandle {
  sessions: Map<string, MockSession>;
  starts: string[];
  stops: string[];
}

function sessionResponse(session: MockSession) {
  return {
    ...session,
    project_path: "/tmp/repo/.worktrees/shared",
    artifact_dir: "/tmp/repo/.worktrees/shared/.artifacts",
    group_path: "shared-worktree",
    tool: "claude",
    yolo_mode: false,
    created_at: "2026-01-01T00:00:00Z",
    last_accessed_at: null,
    idle_entered_at: null,
    last_error: null,
    branch: "feature/shared",
    main_repo_path: "/tmp/repo",
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
    workspace_repos: [],
  };
}

async function installLifecycleMocks(page: Page, sessions: MockSession[]): Promise<LifecycleHandle> {
  const handle: LifecycleHandle = {
    sessions: new Map(sessions.map((session) => [session.id, { ...session }])),
    starts: [],
    stops: [],
  };

  await page.route("**/api/login/status", (route) => route.fulfill({ json: { required: false, authenticated: true } }));
  await page.route("**/api/sessions", (route) => {
    if (route.request().method() !== "GET") return route.fulfill({ status: 400 });
    return route.fulfill({
      json: {
        sessions: [...handle.sessions.values()].map(sessionResponse),
        workspace_ordering: [],
      },
    });
  });
  await page.route("**/api/sessions/*/stop", (route) => {
    if (route.request().method() !== "POST") return route.fulfill({ status: 400 });
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-2) ?? "");
    handle.stops.push(id);
    const session = handle.sessions.get(id);
    if (!session) return route.fulfill({ status: 404 });
    session.status = "Stopped";
    return route.fulfill({ json: sessionResponse(session) });
  });
  await page.route("**/api/sessions/*/start", (route) => {
    if (route.request().method() !== "POST") return route.fulfill({ status: 400 });
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-2) ?? "");
    handle.starts.push(id);
    const session = handle.sessions.get(id);
    if (!session) return route.fulfill({ status: 404 });
    session.status = "Running";
    return route.fulfill({ json: sessionResponse(session) });
  });
  await page.route("**/api/sessions/*/ensure", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/sessions/*/terminal", (route) => route.fulfill({ status: 200, body: "" }));
  await page.route("**/api/sessions/*/diff/files", (route) =>
    route.fulfill({ json: { files: [], per_repo_bases: [], warning: null } }),
  );
  for (const path of ["settings", "themes", "agents", "profiles", "groups", "devices", "docker/status", "about"]) {
    await page.route(`**/api/${path}`, (route) =>
      route.fulfill({ json: path === "docker/status" ? {} : path === "about" ? { read_only: false } : [] }),
    );
  }
  await page.routeWebSocket(/\/sessions\/.*\/(ws|acp-ws|container-ws)$/, () => {});

  return handle;
}

function groupedRow(page: Page) {
  return page.locator('[data-testid="sidebar-session-row"]').filter({ hasText: "feature/shared" }).first();
}

test.describe("Grouped workspace lifecycle App wiring", () => {
  test("Stop confirms and mutates the exact non-first active sibling", async ({ page }) => {
    const handle = await installLifecycleMocks(page, [
      { id: "sibling-a", title: "Non-target sibling", status: "Idle" },
      { id: "target-b", title: "Lifecycle target B", status: "Running" },
    ]);
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto("/");

    const row = groupedRow(page);
    await expect(row).toBeVisible({ timeout: 10_000 });
    await row.click({ button: "right" });
    await expect(page.locator('[data-testid="sidebar-context-menu-stop-picker"]')).toHaveCount(0);
    await page.locator('[data-testid="sidebar-context-menu-stop"]').click();

    const dialog = page.locator('[data-testid="stop-session-dialog"]');
    await expect(dialog).toContainText("Lifecycle target B");
    await expect(dialog).not.toContainText("Non-target sibling");
    await dialog.getByRole("button", { name: "Stop" }).click();

    await expect.poll(() => handle.stops).toEqual(["target-b"]);
    expect(handle.stops).not.toContain("sibling-a");
    expect(handle.sessions.get("sibling-a")?.status).toBe("Idle");
    expect(handle.sessions.get("target-b")?.status).toBe("Stopped");

    // Before the next sessions poll, App's optimistic state must still expose
    // A as stoppable and B as startable. Marking A Stopped would invert this.
    await row.click({ button: "right" });
    await expect(page.locator('[data-testid="sidebar-context-menu-stop-session-sibling-a"]')).toBeVisible();
    await expect(page.locator('[data-testid="sidebar-context-menu-start-session-target-b"]')).toBeVisible();
  });

  test("ambiguous Start mutates the explicitly selected non-first sibling", async ({ page }) => {
    const handle = await installLifecycleMocks(page, [
      { id: "sibling-a", title: "Stopped sibling A", status: "Stopped" },
      { id: "target-b", title: "Stopped target B", status: "Stopped" },
    ]);
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto("/");

    const row = groupedRow(page);
    await expect(row).toBeVisible({ timeout: 10_000 });
    await row.click({ button: "right" });
    await expect(page.locator('[data-testid="sidebar-context-menu-start"]')).toHaveCount(0);
    await page.locator('[data-testid="sidebar-context-menu-start-session-target-b"]').click();

    await expect.poll(() => handle.starts).toEqual(["target-b"]);
    expect(handle.starts).not.toContain("sibling-a");
    expect(handle.sessions.get("sibling-a")?.status).toBe("Stopped");
    expect(handle.sessions.get("target-b")?.status).toBe("Running");

    // The optimistic Starting state belongs to B, so the unique Stop action
    // resolves back to B rather than the canonical first sibling.
    await row.click({ button: "right" });
    await page.locator('[data-testid="sidebar-context-menu-stop"]').click();
    const dialog = page.locator('[data-testid="stop-session-dialog"]');
    await expect(dialog).toContainText("Stopped target B");
    await expect(dialog).not.toContainText("Stopped sibling A");
  });
});
