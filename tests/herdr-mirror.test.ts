import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { CliResult } from "../src/main/vellum/adapters/exec";
import { HerdrMirror, type HerdrMirrorReads } from "../src/main/vellum/herdr/mirror";
import {
  LocalMirrorTransport,
  RemoteMirrorTransport,
  type MirrorTransport,
} from "../src/main/vellum/herdr/mirror-transport";
import { parsePaneList, parseTabList, parseWorkspaceList } from "../src/main/vellum/herdr/parse";
import { HerdrService, type HerdrRunner } from "../src/main/vellum/herdr/service";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const waitFor = async (cond: () => boolean, ms = 2_000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await sleep(5);
  }
};

// Field names taken verbatim from a live `herdr api snapshot` (0.7.3, protocol 16).
const snapshotFixture = () => ({
  snapshot: {
    workspaces: [
      { workspace_id: "w1", label: "demo", tab_count: 1, pane_count: 1, agent_status: "idle", focused: true, number: 1 },
    ],
    tabs: [
      { tab_id: "w1:t1", workspace_id: "w1", label: "1", pane_count: 1, agent_status: "idle", focused: true, number: 1 },
    ],
    panes: [
      {
        pane_id: "w1:p1",
        workspace_id: "w1",
        tab_id: "w1:t1",
        terminal_id: "term_1",
        cwd: "/proj",
        foreground_cwd: "/proj",
        agent: "codex",
        agent_status: "idle",
        focused: false,
        revision: 0,
      },
    ],
    agents: [
      {
        pane_id: "w1:p1",
        workspace_id: "w1",
        tab_id: "w1:t1",
        terminal_id: "term_1",
        cwd: "/proj",
        agent: "codex",
        agent_status: "idle",
        focused: false,
      },
    ],
    layouts: [{ workspace_id: "w1", tab_id: "w1:t1", panes: [], splits: [], zoomed: false }],
    focused_workspace_id: "w1",
    focused_tab_id: "w1:t1",
    focused_pane_id: "w1:p1",
    protocol: 16,
    version: "0.7.3",
  },
});

class FakeTransport implements MirrorTransport {
  snapshot: unknown = snapshotFixture();
  failSnapshots = false;
  snapshotCount = 0;
  subscribeCalls: Array<Array<Record<string, unknown>>> = [];
  handlers?: {
    onEvent: (evt: Record<string, unknown>) => void;
    onClose: (reason: string) => void;
  };
  disposed = false;

  async request(method: string): Promise<unknown> {
    if (method === "session.snapshot") {
      this.snapshotCount += 1;
      if (this.failSnapshots) throw new Error("snapshot down");
      return this.snapshot;
    }
    throw new Error(`unexpected method ${method}`);
  }

  async openEvents(
    subscriptions: ReadonlyArray<Record<string, unknown>>,
    onEvent: (evt: Record<string, unknown>) => void,
    onClose: (reason: string) => void,
  ): Promise<() => void> {
    this.subscribeCalls.push([...subscriptions]);
    this.handlers = { onEvent, onClose };
    return () => {
      this.handlers = undefined;
    };
  }

  dispose(): void {
    this.disposed = true;
  }
}

const mirrorOpts = { backoffMs: [10], resubscribeDebounceMs: 10, changeCoalesceMs: 0 };

const startFresh = async (transport: FakeTransport): Promise<HerdrMirror> => {
  const mirror = new HerdrMirror("local", transport, mirrorOpts);
  mirror.start();
  await waitFor(() => mirror.isFresh());
  return mirror;
};

let cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup) fn();
  cleanup = [];
});

describe("HerdrMirror", () => {
  it("is not fresh before start; bootstrap populates state from the snapshot", async () => {
    const transport = new FakeTransport();
    const mirror = new HerdrMirror("local", transport, mirrorOpts);
    cleanup.push(() => mirror.stop());
    expect(mirror.isFresh()).toBe(false);
    expect(mirror.listWorkspaces()).toBeUndefined();

    mirror.start();
    await waitFor(() => mirror.isFresh());

    expect(mirror.listWorkspaces()?.map((w) => w.workspace_id)).toEqual(["w1"]);
    expect(mirror.listTabs("w1")?.map((t) => t.tab_id)).toEqual(["w1:t1"]);
    expect(mirror.listTabs("nope")).toEqual([]);
    expect(mirror.listPanes()?.map((p) => p.pane_id)).toEqual(["w1:p1"]);
    expect(mirror.listAgents()?.length).toBe(1);
    expect(mirror.paneRecord("w1:p1")?.terminal_id).toBe("term_1");
    // Fixture ships pane.focused:false while focused_pane_id=w1:p1 — normalize.
    expect(mirror.focused().paneId).toBe("w1:p1");
    expect(mirror.paneRecord("w1:p1")?.focused).toBe(true);
    expect(mirror.lastSyncAt).toBeTypeOf("number");

    // subscriptions: all unscoped kinds + agent_status scoped per known pane
    const subs = transport.subscribeCalls[0]!;
    expect(subs.some((s) => s.type === "workspace.created")).toBe(true);
    expect(subs.some((s) => s.type === "layout.updated")).toBe(true);
    expect(subs).toContainEqual({ type: "pane.agent_status_changed", pane_id: "w1:p1" });
  });

  it("applies lifecycle events: create adds, close removes, status updates", async () => {
    const transport = new FakeTransport();
    const mirror = await startFresh(transport);
    cleanup.push(() => mirror.stop());

    // Herdr wire: lifecycle EventEnvelope uses snake_case `event` + nested `data`.
    transport.handlers!.onEvent({
      event: "workspace_created",
      data: { type: "workspace_created", workspace: { workspace_id: "w2", label: "new" } },
    });
    expect(mirror.listWorkspaces()?.map((w) => w.workspace_id)).toEqual(["w1", "w2"]);

    transport.handlers!.onEvent({
      event: "tab_closed",
      data: { type: "tab_closed", tab_id: "w1:t1", workspace_id: "w1" },
    });
    expect(mirror.listTabs()).toEqual([]);

    // Subscription kinds stay dotted on the wire (SubscriptionEventEnvelope).
    transport.handlers!.onEvent({
      event: "pane.agent_status_changed",
      data: { pane_id: "w1:p1", workspace_id: "w1", agent_status: "working" },
    });
    expect(mirror.paneRecord("w1:p1")?.agent_status).toBe("working");
    expect(mirror.listAgents()?.[0]?.agent_status).toBe("working");
  });

  it("emits coalesced onChange when events apply", async () => {
    const transport = new FakeTransport();
    const mirror = await startFresh(transport);
    cleanup.push(() => mirror.stop());
    let changes = 0;
    mirror.onChange(() => {
      changes += 1;
    });
    transport.handlers!.onEvent({
      event: "workspace_renamed",
      data: { type: "workspace_renamed", workspace_id: "w1", label: "x" },
    });
    await waitFor(() => changes >= 1);
    expect(mirror.listWorkspaces()?.[0]?.label).toBe("x");
  });

  it("pane.focused updates focused() and normalizes row flags", async () => {
    const transport = new FakeTransport();
    // Two-pane snapshot so focus can move off p1 onto p2.
    transport.snapshot = {
      snapshot: {
        ...snapshotFixture().snapshot,
        panes: [
          { ...snapshotFixture().snapshot.panes[0]!, pane_id: "w1:p1", focused: true },
          {
            pane_id: "w1:p2",
            workspace_id: "w1",
            tab_id: "w1:t1",
            terminal_id: "term_2",
            cwd: "/other",
            agent: "amp",
            agent_status: "idle",
            focused: false,
            revision: 0,
          },
        ],
        focused_pane_id: "w1:p1",
      },
    };
    const mirror = await startFresh(transport);
    cleanup.push(() => mirror.stop());
    expect(mirror.paneRecord("w1:p1")?.focused).toBe(true);
    expect(mirror.paneRecord("w1:p2")?.focused).toBe(false);

    transport.handlers!.onEvent({
      event: "pane.focused",
      data: { pane_id: "w1:p2", workspace_id: "w1", tab_id: "w1:t1" },
    });
    expect(mirror.focused().paneId).toBe("w1:p2");
    expect(mirror.paneRecord("w1:p1")?.focused).toBe(false);
    expect(mirror.paneRecord("w1:p2")?.focused).toBe(true);
  });

  it("pane.scroll_changed does not upsert or emitChange", async () => {
    const transport = new FakeTransport();
    const mirror = await startFresh(transport);
    cleanup.push(() => mirror.stop());
    let changes = 0;
    mirror.onChange(() => {
      changes += 1;
    });
    const before = mirror.paneRecord("w1:p1");
    transport.handlers!.onEvent({
      event: "pane.scroll_changed",
      data: {
        pane_id: "w1:p1",
        scroll: { offset_from_bottom: 12 },
        noise: "must-not-merge",
      },
    });
    // Coalesce window would fire within ~100ms if emitChange ran.
    await sleep(50);
    expect(changes).toBe(0);
    expect(mirror.paneRecord("w1:p1")).toEqual(before);
    expect(mirror.paneRecord("w1:p1")?.noise).toBeUndefined();
  });

  it("pane.created triggers a debounced resubscribe including the new pane id", async () => {
    const transport = new FakeTransport();
    const mirror = await startFresh(transport);
    cleanup.push(() => mirror.stop());

    // The rebuilt connection re-snapshots; serve the updated pane set.
    const next = snapshotFixture();
    (next.snapshot.panes as Array<Record<string, unknown>>).push({
      pane_id: "w1:p2",
      workspace_id: "w1",
      tab_id: "w1:t1",
      terminal_id: "term_2",
    });
    transport.snapshot = next;

    transport.handlers!.onEvent({
      event: "pane_created",
      data: {
        type: "pane_created",
        pane: { pane_id: "w1:p2", workspace_id: "w1", tab_id: "w1:t1", terminal_id: "term_2" },
      },
    });

    await waitFor(() => transport.subscribeCalls.length >= 2);
    await waitFor(() => mirror.isFresh());
    const subs = transport.subscribeCalls.at(-1)!;
    expect(subs).toContainEqual({ type: "pane.agent_status_changed", pane_id: "w1:p2" });
    expect(mirror.listPanes()?.map((p) => p.pane_id)).toEqual(["w1:p1", "w1:p2"]);
  });

  it("unknown event kinds schedule a self-healing re-snapshot", async () => {
    const transport = new FakeTransport();
    const mirror = await startFresh(transport);
    cleanup.push(() => mirror.stop());
    expect(transport.snapshotCount).toBe(1);
    transport.handlers!.onEvent({ type: "mystery.kind" });
    await waitFor(() => transport.snapshotCount >= 2);
    await waitFor(() => mirror.isFresh());
  });

  it("re-bootstraps with backoff after events close; stays stale while down", async () => {
    const transport = new FakeTransport();
    const mirror = await startFresh(transport);
    cleanup.push(() => mirror.stop());

    transport.failSnapshots = true;
    transport.handlers!.onClose("connection lost");
    expect(mirror.isFresh()).toBe(false);
    await sleep(50);
    expect(mirror.isFresh()).toBe(false); // reconnect attempts fail — stays stale
    expect(transport.snapshotCount).toBeGreaterThan(1);

    transport.failSnapshots = false;
    await waitFor(() => mirror.isFresh());
    expect(transport.subscribeCalls.length).toBeGreaterThanOrEqual(2);
  });

  it("a pending rebuild timer is dropped when an events-close reconnect wins the race", async () => {
    const transport = new FakeTransport();
    const mirror = new HerdrMirror("local", transport, {
      backoffMs: [5],
      resubscribeDebounceMs: 100,
      changeCoalesceMs: 0,
    });
    cleanup.push(() => mirror.stop());
    mirror.start();
    await waitFor(() => mirror.isFresh());

    // Schedule a debounced rebuild (100ms out)…
    transport.handlers!.onEvent({
      event: "pane_created",
      data: {
        type: "pane_created",
        pane: { pane_id: "w1:p2", workspace_id: "w1", tab_id: "w1:t1" },
      },
    });
    // …then the events connection drops independently before it fires.
    transport.handlers!.onClose("forward blip");
    await waitFor(() => transport.subscribeCalls.length >= 2 && mirror.isFresh());

    // The stale timer must NOT fire and close the fresh reconnect.
    await sleep(150);
    expect(transport.subscribeCalls.length).toBe(2);
    expect(mirror.isFresh()).toBe(true);
    expect(transport.handlers).toBeDefined();
  });

  it("self-heal's stale window emits onChange when freshness flips off", async () => {
    const transport = new FakeTransport();
    const mirror = await startFresh(transport);
    cleanup.push(() => mirror.stop());
    let sawStale = false;
    mirror.onChange(() => {
      if (!mirror.isFresh()) sawStale = true;
    });
    transport.failSnapshots = true; // hold the rebuild open so the window is observable
    transport.handlers!.onEvent({ type: "mystery.kind" });
    await waitFor(() => sawStale);
    transport.failSnapshots = false;
    await waitFor(() => mirror.isFresh());
  });

  it("stop() closes events, disposes the transport, and stays cold", async () => {
    const transport = new FakeTransport();
    const mirror = await startFresh(transport);
    mirror.stop();
    expect(mirror.isFresh()).toBe(false);
    expect(transport.disposed).toBe(true);
    expect(transport.handlers).toBeUndefined();
  });
});

// --- service integration -----------------------------------------------------

class FakeMirror implements HerdrMirrorReads {
  fresh = true;
  constructor(private readonly data = snapshotFixture().snapshot) {}
  isFresh(): boolean {
    return this.fresh;
  }
  listWorkspaces() {
    return this.fresh ? this.data.workspaces : undefined;
  }
  listTabs(workspaceId?: string) {
    if (!this.fresh) return undefined;
    return workspaceId
      ? this.data.tabs.filter((t) => t.workspace_id === workspaceId)
      : this.data.tabs;
  }
  listPanes(workspaceId?: string) {
    if (!this.fresh) return undefined;
    return workspaceId
      ? this.data.panes.filter((p) => p.workspace_id === workspaceId)
      : this.data.panes;
  }
  listAgents() {
    return this.fresh ? this.data.agents : undefined;
  }
  paneRecord(paneId: string) {
    return this.fresh ? this.data.panes.find((p) => p.pane_id === paneId) : undefined;
  }
  lookupPane(paneId: string) {
    // Rollup path: bootstrapped last-known, not gated on eventsLive/fresh.
    return (
      this.data.panes.find((p) => p.pane_id === paneId) ??
      this.data.agents.find((a) => a.pane_id === paneId)
    );
  }
  focused() {
    return {
      workspaceId: this.data.focused_workspace_id as string | undefined,
      tabId: this.data.focused_tab_id as string | undefined,
      paneId: this.data.focused_pane_id as string | undefined,
    };
  }
}

const okCli = (payload: unknown): CliResult => ({ ok: true, stdout: JSON.stringify(payload) });

describe("HerdrService mirror integration", () => {
  it("serves list reads from a fresh mirror without touching the runner", async () => {
    const calls: string[][] = [];
    const runner: HerdrRunner = async (_h, args) => {
      calls.push([...args]);
      throw new Error("runner must not be called");
    };
    const mirror = new FakeMirror();
    const svc = new HerdrService(runner, () => mirror);

    const ws = await svc.listWorkspaces("local");
    expect(ws.ok && ws.data[0]?.workspaceId).toBe("w1");
    const tabs = await svc.listTabs("local", null, "w1");
    expect(tabs.ok && tabs.data[0]?.tabId).toBe("w1:t1");
    const panes = await svc.listPanes("local");
    expect(panes.ok && panes.data[0]?.paneId).toBe("w1:p1");
    const agents = await svc.listAgents("local");
    expect(agents.ok && agents.data[0]?.agent).toBe("codex");
    const ensure = await svc.ensureServer("local");
    expect(ensure).toEqual({ ok: true, data: { running: true, started: false } });
    expect(calls).toEqual([]);
  });

  it("falls back to exec when the mirror is stale", async () => {
    const calls: string[][] = [];
    const runner: HerdrRunner = async (_h, args) => {
      calls.push([...args]);
      return okCli({ id: "x", result: { workspaces: [{ workspace_id: "w9" }] } });
    };
    const mirror = new FakeMirror();
    mirror.fresh = false;
    const svc = new HerdrService(runner, () => mirror);
    const ws = await svc.listWorkspaces("local");
    expect(ws.ok && ws.data[0]?.workspaceId).toBe("w9");
    expect(calls).toEqual([["workspace", "list"]]);
  });

  it("non-default sessions bypass the mirror", async () => {
    const calls: string[][] = [];
    const runner: HerdrRunner = async (_h, args) => {
      calls.push([...args]);
      return okCli({ id: "x", result: { workspaces: [] } });
    };
    const svc = new HerdrService(runner, () => new FakeMirror());
    await svc.listWorkspaces("local", "ops");
    expect(calls.length).toBe(1);
  });

  it("mirror-served rows deep-equal exec-parsed rows for the same data (shape parity)", async () => {
    const data = snapshotFixture().snapshot;
    const runner: HerdrRunner = async (_h, args) => {
      if (args[0] === "workspace") return okCli({ id: "x", result: { workspaces: data.workspaces } });
      if (args[0] === "tab") return okCli({ id: "x", result: { tabs: data.tabs } });
      if (args[0] === "pane") return okCli({ id: "x", result: { panes: data.panes } });
      if (args[0] === "agent") return okCli({ id: "x", result: { agents: data.agents } });
      throw new Error("unexpected");
    };
    const execSvc = new HerdrService(runner, () => undefined);
    const mirrorSvc = new HerdrService(
      async () => {
        throw new Error("runner must not be called");
      },
      () => new FakeMirror(data),
    );

    for (const [viaExec, viaMirror] of [
      [await execSvc.listWorkspaces("local"), await mirrorSvc.listWorkspaces("local")],
      [await execSvc.listTabs("local"), await mirrorSvc.listTabs("local")],
      [await execSvc.listPanes("local"), await mirrorSvc.listPanes("local")],
      [await execSvc.listAgents("local"), await mirrorSvc.listAgents("local")],
    ] as const) {
      expect(viaExec.ok && viaMirror.ok).toBe(true);
      if (viaExec.ok && viaMirror.ok) expect(viaMirror.data).toEqual(viaExec.data);
    }

    // Sanity: the parity is over non-trivial parsed rows, not empty arrays.
    expect(parseWorkspaceList({ workspaces: data.workspaces })[0]?.workspaceId).toBe("w1");
    expect(parseTabList({ tabs: data.tabs })[0]?.tabId).toBe("w1:t1");
    expect(parsePaneList({ panes: data.panes })[0]?.paneId).toBe("w1:p1");
  });

  it("getPaneMeta with a fresh mirror does zero execs (pure local read)", async () => {
    const calls: string[][] = [];
    const runner: HerdrRunner = async (_h, args) => {
      calls.push([...args]);
      throw new Error(`unexpected exec: ${args.join(" ")}`);
    };
    const svc = new HerdrService(runner, () => new FakeMirror());
    const meta = await svc.getPaneMeta("local", null, "w1:p1");
    expect(meta.ok && meta.data.paneId).toBe("w1:p1");
    expect(meta.ok && meta.data.cwd).toBe("/proj");
    // Preview is exec-only; mirror path must not fan out pane read / process-info
    // for every card on every agent_status_changed.
    expect(meta.ok && meta.data.preview).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it("getPaneMeta derives focused from focused_pane_id, not the stale row flag", async () => {
    // Fixture: pane row focused:false while focused_pane_id === w1:p1 (live herdr shape).
    const runner: HerdrRunner = async () => {
      throw new Error("no exec on fresh mirror");
    };
    const svc = new HerdrService(runner, () => new FakeMirror());
    const meta = await svc.getPaneMeta("local", null, "w1:p1");
    expect(meta.ok).toBe(true);
    if (!meta.ok) return;
    expect(meta.data.focused).toBe(true);
  });

  it("getPaneMeta falls back to pane get when the mirror misses the pane", async () => {
    const calls: string[][] = [];
    const runner: HerdrRunner = async (_h, args) => {
      calls.push([...args]);
      if (args[0] === "pane" && args[1] === "get") {
        return okCli({ id: "g", result: { pane: { pane_id: "w1:pZ", cwd: "/z" } } });
      }
      return okCli({ id: "r", result: { text: "" } });
    };
    const svc = new HerdrService(runner, () => new FakeMirror());
    const meta = await svc.getPaneMeta("local", null, "w1:pZ");
    expect(meta.ok && meta.data.cwd).toBe("/z");
    expect(calls[0]).toEqual(["pane", "get", "w1:pZ"]);
  });
});

// --- transport (hermetic in-process unix socket) ------------------------------

describe("LocalMirrorTransport", () => {
  const listen = (server: Server, path: string): Promise<void> =>
    new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, () => resolve());
    });

  it("matches request/response by id and handles the events stream", async () => {
    const sockPath = join(tmpdir(), `vm-${process.pid}-${Date.now()}.sock`);
    const server = createServer((sock) => {
      let buf = "";
      sock.on("data", (chunk) => {
        buf += chunk.toString();
        let idx = buf.indexOf("\n");
        while (idx >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          idx = buf.indexOf("\n");
          if (!line) continue;
          const req = JSON.parse(line) as { id: string; method: string };
          if (req.method === "session.snapshot") {
            // noise line first — client must skip non-matching lines
            sock.write(`${JSON.stringify({ note: "noise" })}\n`);
            sock.write(`${JSON.stringify({ id: req.id, result: { snapshot: { panes: [] } } })}\n`);
            sock.end();
          } else if (req.method === "events.subscribe") {
            sock.write(`${JSON.stringify({ id: req.id, result: { subscribed: true } })}\n`);
            setTimeout(() => {
              sock.write(`${JSON.stringify({ type: "workspace.created", workspace_id: "w9" })}\n`);
            }, 10);
            setTimeout(() => sock.end(), 40);
          } else if (req.method === "bad.method") {
            sock.write(`${JSON.stringify({ id: req.id, error: { message: "nope" } })}\n`);
            sock.end();
          }
        }
      });
    });
    await listen(server, sockPath);
    cleanup.push(() => {
      server.close();
      try {
        unlinkSync(sockPath);
      } catch {
        // gone
      }
    });

    const transport = new LocalMirrorTransport(sockPath);
    const res = await transport.request("session.snapshot", {});
    expect(res).toEqual({ snapshot: { panes: [] } });

    await expect(transport.request("bad.method", {})).rejects.toThrow(/nope/);

    const events: Array<Record<string, unknown>> = [];
    let closedReason: string | undefined;
    await transport.openEvents(
      [{ type: "workspace.created" }],
      (evt) => events.push(evt),
      (reason) => {
        closedReason = reason;
      },
    );
    await waitFor(() => events.length === 1 && closedReason !== undefined);
    expect(events[0]?.workspace_id).toBe("w9");
    expect(closedReason).toMatch(/closed/);
  });

  it("deliberate close does not fire onClose", async () => {
    const sockPath = join(tmpdir(), `vm2-${process.pid}-${Date.now()}.sock`);
    const server = createServer((sock) => {
      let buf = "";
      sock.on("data", (chunk) => {
        buf += chunk.toString();
        const idx = buf.indexOf("\n");
        if (idx < 0) return;
        const req = JSON.parse(buf.slice(0, idx)) as { id: string };
        sock.write(`${JSON.stringify({ id: req.id, result: {} })}\n`);
      });
    });
    await listen(server, sockPath);
    cleanup.push(() => {
      server.close();
      try {
        unlinkSync(sockPath);
      } catch {
        // gone
      }
    });

    const transport = new LocalMirrorTransport(sockPath);
    let closed = false;
    const close = await transport.openEvents([{ type: "tab.created" }], () => {}, () => {
      closed = true;
    });
    close();
    await sleep(30);
    expect(closed).toBe(false);
  });

  it("decodes a multi-byte UTF-8 char split across TCP chunks", async () => {
    const sockPath = join(tmpdir(), `vm3-${process.pid}-${Date.now()}.sock`);
    const label = "café 🚀";
    const server = createServer((sock) => {
      let buf = "";
      sock.on("data", (chunk) => {
        buf += chunk.toString();
        const idx = buf.indexOf("\n");
        if (idx < 0) return;
        const req = JSON.parse(buf.slice(0, idx)) as { id: string };
        const line = Buffer.from(
          `${JSON.stringify({ id: req.id, result: { label } })}\n`,
          "utf8",
        );
        // Split inside the emoji's 4-byte sequence.
        const cut = line.indexOf(Buffer.from("🚀", "utf8")) + 2;
        sock.write(line.subarray(0, cut));
        setTimeout(() => {
          sock.write(line.subarray(cut));
          sock.end();
        }, 10);
      });
    });
    await listen(server, sockPath);
    cleanup.push(() => {
      server.close();
      try {
        unlinkSync(sockPath);
      } catch {
        // gone
      }
    });

    const transport = new LocalMirrorTransport(sockPath);
    const res = (await transport.request("session.snapshot", {})) as { label: string };
    expect(res.label).toBe(label);
  });
});

// --- remote transport (fake ssh forward, real local socket) -------------------

class FakeForward extends EventEmitter {
  exitCode: number | null = null;
  killed = false;
  kill(): boolean {
    if (this.exitCode === null) {
      this.killed = true;
      this.exitCode = 0;
      this.emit("exit", 0);
    }
    return true;
  }
}

describe("RemoteMirrorTransport", () => {
  const okHome = (stdout: string): CliResult => ({ ok: true, stdout });

  /** Fake `ssh -N -L`: serves session.snapshot on a real unix socket at the
   * forward's local path, exactly like the real forward would. */
  const makeHarness = (localSock: string, home = "/Users/remote") => {
    const execCalls: string[][] = [];
    const spawnCalls: string[][] = [];
    const children: FakeForward[] = [];
    const servers: Server[] = [];
    const transport = new RemoteMirrorTransport("remote-a", {
      exec: async (_cmd, argv) => {
        execCalls.push([...argv]);
        return okHome(home);
      },
      spawnFn: (_cmd, argv) => {
        spawnCalls.push([...argv]);
        const child = new FakeForward();
        children.push(child);
        const server = createServer((sock) => {
          let buf = "";
          sock.on("data", (chunk) => {
            buf += chunk.toString();
            const idx = buf.indexOf("\n");
            if (idx < 0) return;
            const req = JSON.parse(buf.slice(0, idx)) as { id: string };
            sock.write(`${JSON.stringify({ id: req.id, result: { via: "forward" } })}\n`);
            sock.end();
          });
        });
        servers.push(server);
        server.listen(localSock);
        return child as unknown as ChildProcess;
      },
      localSockPath: localSock,
    });
    cleanup.push(() => {
      transport.dispose();
      for (const server of servers) server.close();
      try {
        unlinkSync(localSock);
      } catch {
        // gone
      }
    });
    return { transport, execCalls, spawnCalls, children };
  };

  it("resolves $HOME once, pre-unlinks a stale socket, spawns -N -L, and serves requests", async () => {
    const localSock = join(tmpdir(), `vmr-${process.pid}-${Date.now()}.sock`);
    writeFileSync(localSock, ""); // stale leftover — ssh -L would refuse to bind
    const { transport, execCalls, spawnCalls } = makeHarness(localSock);

    const res = await transport.request("session.snapshot", {});
    expect(res).toEqual({ via: "forward" });

    expect(execCalls.length).toBe(1);
    expect(execCalls[0]!.join(" ")).toContain('printf %s "$HOME"');
    expect(spawnCalls.length).toBe(1);
    expect(spawnCalls[0]).toContain("-N");
    // Must not mux onto ControlMaster — mux accepts -L unix with exit 0 but
    // never binds the local sock when the master was started without that -L.
    expect(spawnCalls[0]).toContain("ControlMaster=no");
    expect(spawnCalls[0]).not.toContain("ControlMaster=auto");
    expect(spawnCalls[0]).toContain(`${localSock}:/Users/remote/.config/herdr/herdr.sock`);
    expect(spawnCalls[0]!.at(-1)).toBe("remote-a");

    // Second request reuses the live forward and the cached $HOME.
    await transport.request("session.snapshot", {});
    expect(execCalls.length).toBe(1);
    expect(spawnCalls.length).toBe(1);
  });

  it("rejects when remote $HOME cannot be resolved", async () => {
    const localSock = join(tmpdir(), `vmr2-${process.pid}-${Date.now()}.sock`);
    const transport = new RemoteMirrorTransport("remote-a", {
      exec: async () => ({ ok: false, stdout: "", error: "ssh down" }),
      spawnFn: () => {
        throw new Error("must not spawn without $HOME");
      },
      localSockPath: localSock,
    });
    cleanup.push(() => transport.dispose());
    await expect(transport.request("session.snapshot", {})).rejects.toThrow(
      /failed to resolve remote \$HOME/,
    );
  });

  it("forward death invalidates the handle; the next request respawns", async () => {
    const localSock = join(tmpdir(), `vmr3-${process.pid}-${Date.now()}.sock`);
    const { transport, spawnCalls, children } = makeHarness(localSock);

    await transport.request("session.snapshot", {});
    expect(spawnCalls.length).toBe(1);

    children[0]!.exitCode = 1;
    children[0]!.emit("exit", 1);
    unlinkSync(localSock); // forward death takes its socket with it

    await transport.request("session.snapshot", {});
    expect(spawnCalls.length).toBe(2);
  });

  it("unlinked socket under a live forward respawns instead of looping ENOENT", async () => {
    const localSock = join(tmpdir(), `vmr-stale-${process.pid}-${Date.now()}.sock`);
    const { transport, spawnCalls, children } = makeHarness(localSock);

    await transport.request("session.snapshot", {});
    expect(spawnCalls.length).toBe(1);
    expect(spawnCalls[0]).toContain("ExitOnForwardFailure=yes");

    // Prod failure mode: path unlinked while ssh -N still alive (no exit event).
    unlinkSync(localSock);
    expect(children[0]!.exitCode).toBeNull();

    await transport.request("session.snapshot", {});
    expect(spawnCalls.length).toBe(2);
    expect(children[0]!.killed).toBe(true);
  });

  it("coalesces concurrent stale-socket recovery into one replacement forward", async () => {
    const localSock = join(tmpdir(), `vmr-stale-race-${process.pid}-${Date.now()}.sock`);
    const { transport, spawnCalls, children } = makeHarness(localSock);

    await transport.request("session.snapshot", {});
    unlinkSync(localSock);

    const results = await Promise.all([
      transport.request("session.snapshot", {}),
      transport.request("session.snapshot", {}),
    ]);

    expect(results).toEqual([{ via: "forward" }, { via: "forward" }]);
    expect(spawnCalls.length).toBe(2);
    expect(children[0]!.killed).toBe(true);
  });

  it("dispose kills the forward and refuses further requests", async () => {
    const localSock = join(tmpdir(), `vmr4-${process.pid}-${Date.now()}.sock`);
    const { transport, children } = makeHarness(localSock);
    await transport.request("session.snapshot", {});

    transport.dispose();
    expect(children[0]!.killed).toBe(true);
    await expect(transport.request("session.snapshot", {})).rejects.toThrow(/disposed/);
  });
});
