import { describe, expect, it } from "vitest";

import { buildSessionActionTarget, buildSessionProjectionRow } from "../sessionProjection";
import type { SessionResponse, Workspace } from "../types";

function session(id: string): SessionResponse {
  return { id } as SessionResponse;
}

function workspace(...sessions: SessionResponse[]): Workspace {
  return {
    id: "workspace-1",
    branch: "feature/projection",
    projectPath: "/repo",
    displayName: "projection",
    agents: [],
    primaryAgent: "claude",
    status: "idle",
    sessions,
  };
}

describe("session projection target construction", () => {
  it("does not construct a Session action target for an aggregate row", () => {
    const row = buildSessionProjectionRow(workspace(session("session-a"), session("session-b")));

    expect(row.kind).toBe("aggregate");
    expect(buildSessionActionTarget(row)).toBeNull();
  });

  it("constructs a target only for the requested exact Session member", () => {
    const row = buildSessionProjectionRow(workspace(session("session-a"), session("session-b")), "session-b");

    expect(row.kind).toBe("session");
    expect(buildSessionActionTarget(row)).toEqual({ sessionId: "session-b" });
  });

  it("does not fall back when an explicit Session member is missing", () => {
    const row = buildSessionProjectionRow(workspace(session("session-a")), "stale-session");

    expect(row.kind).toBe("aggregate");
    expect(buildSessionActionTarget(row)).toBeNull();
  });
});
