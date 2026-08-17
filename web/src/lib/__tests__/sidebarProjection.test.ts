// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SIDEBAR_PROJECTION_KEY,
  loadSidebarProjection,
  saveSidebarProjection,
} from "../sidebarProjection";

describe("sidebar projection persistence", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps All, Projects, and Groups as independent reloadable choices", () => {
    const values = ["all", "projects", "groups"] as const;
    for (const value of values) {
      localStorage.clear();
      saveSidebarProjection(value);
      expect(localStorage.getItem(SIDEBAR_PROJECTION_KEY)).toBe(value);
      expect(loadSidebarProjection()).toBe(value);
    }
  });
});
