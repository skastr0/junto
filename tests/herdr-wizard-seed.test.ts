import { describe, expect, it } from "vitest";
import { bootstrapHerdrWizard, type HerdrWizardApi } from "../src/renderer/lib/herdr-wizard-seed";

const mockApi = (overrides: Partial<HerdrWizardApi> = {}): HerdrWizardApi => ({
  herdrHosts: async () => [{ id: "local", label: "local" }, { id: "remote-a", label: "remote-a" }],
  herdrEnsureServer: async () => ({ ok: true }),
  herdrListSessions: async () => ({ ok: true, data: [{ name: "dev", running: true }] }),
  herdrListWorkspaces: async () => ({
    ok: true,
    data: [{ workspaceId: "w1", label: "main", paneCount: 1 }],
  }),
  herdrListTabs: async () => ({
    ok: true,
    data: [{ tabId: "t1", label: "tab", workspaceId: "w1" }],
  }),
  herdrListPanes: async () => ({
    ok: true,
    data: [{ paneId: "p1", tabId: "t1", workspaceId: "w1" }],
  }),
  ...overrides,
});

describe("bootstrapHerdrWizard", () => {
  it("stays on host when no seed", async () => {
    const snap = await bootstrapHerdrWizard(mockApi(), null);
    expect(snap.step).toBe("host");
    expect(snap.seedApplied).toBe(false);
    expect(snap.hosts).toHaveLength(2);
  });

  it("advances to pane when full seed is present and valid", async () => {
    const snap = await bootstrapHerdrWizard(mockApi(), {
      host: "local",
      session: "dev",
      workspaceId: "w1",
      tabId: "t1",
    });
    expect(snap.seedApplied).toBe(true);
    expect(snap.step).toBe("pane");
    expect(snap.hostId).toBe("local");
    expect(snap.session).toBe("dev");
    expect(snap.workspaceId).toBe("w1");
    expect(snap.tabId).toBe("t1");
    expect(snap.panes[0]?.paneId).toBe("p1");
  });

  it("fails loud when workspace id is missing on host", async () => {
    const snap = await bootstrapHerdrWizard(mockApi(), {
      host: "local",
      session: null,
      workspaceId: "gone",
    });
    expect(snap.seedApplied).toBe(true);
    expect(snap.step).toBe("workspace");
    expect(snap.error).toMatch(/workspace missing/);
  });

  it("stops at session when only host is seeded", async () => {
    const snap = await bootstrapHerdrWizard(mockApi(), { host: "remote-a" });
    expect(snap.step).toBe("session");
    expect(snap.hostId).toBe("remote-a");
    expect(snap.seedApplied).toBe(true);
  });
});
