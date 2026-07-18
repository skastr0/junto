import { afterEach, describe, expect, it } from "vitest";
import { ScriptedMirrorTransport } from "../src/main/vellum/demo/scripted-mirror-transport";
import { HerdrMirror } from "../src/main/vellum/herdr/mirror";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const waitFor = async (cond: () => boolean, ms = 2_000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await sleep(5);
  }
};

// Same fast-cycle opts tests/herdr-mirror.test.ts uses so waitFor stays cheap.
const mirrorOpts = { backoffMs: [10], resubscribeDebounceMs: 10, changeCoalesceMs: 0 };

let cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup) fn();
  cleanup = [];
});

const freshMirror = async (transport: ScriptedMirrorTransport): Promise<HerdrMirror> => {
  const mirror = new HerdrMirror("local", transport, mirrorOpts);
  cleanup.push(() => mirror.stop());
  mirror.start();
  await waitFor(() => mirror.isFresh());
  return mirror;
};

describe("ScriptedMirrorTransport + HerdrMirror", () => {
  it("bootstraps fresh from an empty host", async () => {
    const transport = new ScriptedMirrorTransport();
    const mirror = await freshMirror(transport);
    expect(mirror.listWorkspaces()).toEqual([]);
    expect(mirror.listTabs()).toEqual([]);
    expect(mirror.listPanes()).toEqual([]);
    expect(mirror.listAgents()).toEqual([]);
  });

  it("ensurePane makes a pane appear in mirror.listPanes()", async () => {
    const transport = new ScriptedMirrorTransport();
    const mirror = await freshMirror(transport);

    transport.ensurePane({ host: "local", paneId: "p1", agent: "claude", cwd: "/proj" }, "idle");

    await waitFor(() => (mirror.listPanes() ?? []).length === 1);
    const panes = mirror.listPanes()!;
    expect(panes[0]?.pane_id).toBe("p1");
    expect(panes[0]?.agent).toBe("claude");
    expect(panes[0]?.cwd).toBe("/proj");
    expect(panes[0]?.terminal_id).toBe("term-p1");
    expect(mirror.listWorkspaces()?.map((w) => w.workspace_id)).toEqual(["w1"]);
    expect(mirror.listTabs()?.map((t) => t.tab_id)).toEqual(["w1:t1"]);
    expect(mirror.listAgents()?.[0]?.agent).toBe("claude");

    // The pane-set change schedules a debounced resubscribe (mirror.ts
    // self-heal) — the mirror must land back fresh, not wedge stale.
    await waitFor(() => mirror.isFresh());
  });

  it('setStatus("blocked") updates the mirrored pane record', async () => {
    const transport = new ScriptedMirrorTransport();
    const mirror = await freshMirror(transport);
    transport.ensurePane({ host: "local", paneId: "p1", agent: "claude" }, "idle");
    await waitFor(() => mirror.paneRecord("p1") !== undefined);
    await waitFor(() => mirror.isFresh());

    const applied = transport.setStatus("p1", "blocked");
    expect(applied).toBe(true);

    await waitFor(() => mirror.paneRecord("p1")?.agent_status === "blocked");
    expect(mirror.listAgents()?.[0]?.agent_status).toBe("blocked");

    // Unknown pane: no-op, reported back to the caller.
    expect(transport.setStatus("nope", "working")).toBe(false);
  });

  it("resubscribing after a second pane does not wedge the mirror", async () => {
    const transport = new ScriptedMirrorTransport();
    const mirror = await freshMirror(transport);

    transport.ensurePane({ host: "local", paneId: "p1", agent: "claude" });
    await waitFor(() => mirror.isFresh() && (mirror.listPanes() ?? []).length === 1);

    transport.ensurePane({ host: "local", paneId: "p2", agent: "codex" });
    await waitFor(() => mirror.isFresh() && (mirror.listPanes() ?? []).length === 2);

    expect(mirror.listPanes()?.map((p) => p.pane_id).sort()).toEqual(["p1", "p2"]);
    // Both panes carry a live agent_status_changed subscription post-rebuild.
    expect(transport.setStatus("p1", "working")).toBe(true);
    expect(transport.setStatus("p2", "done")).toBe(true);
    await waitFor(
      () =>
        mirror.paneRecord("p1")?.agent_status === "working" &&
        mirror.paneRecord("p2")?.agent_status === "done",
    );
  });

  it("resetHost empties the mirror and it comes back fresh", async () => {
    const transport = new ScriptedMirrorTransport();
    const mirror = await freshMirror(transport);
    transport.ensurePane({ host: "local", paneId: "p1", agent: "claude" });
    await waitFor(() => (mirror.listPanes() ?? []).length === 1);
    await waitFor(() => mirror.isFresh());

    transport.resetHost();

    await waitFor(() => mirror.isFresh() && (mirror.listPanes() ?? []).length === 0);
    expect(mirror.listWorkspaces()).toEqual([]);
    expect(mirror.listTabs()).toEqual([]);
    expect(mirror.listAgents()).toEqual([]);
  });
});
