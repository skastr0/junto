import { describe, expect, it, vi } from "vitest";
import { Effect, Result } from "effect";
import type { CanvasDoc, CanvasNode, TextNode } from "../src/shared/canvas";
import { decodeOverseerArgs } from "../src/shared/overseer-control";
import { INTERRUPT_BYTE } from "../src/main/vellum-command/term/drive";
import { TerminalNodeDeleteService } from "../src/main/vellum-command/term/node-delete";
import { NodeDeleteService } from "../src/main/vellum-command/chat/node-delete";
import {
  admitOverseerPage,
  overseerPageNodeIds,
} from "../src/main/vellum-command/overseer/authz";
import { callerMayAccessPage } from "../src/main/vellum-command/browser/authz";
import {
  makeOverseerNativeLive,
  type OverseerNativeLiveOptions,
} from "../src/main/vellum-command/overseer/native";
import type { TermPlane } from "../src/main/vellum-command/term/plane";
import type { ChatService } from "../src/main/vellum-command/chat/service";
import type { BrowserSessionService } from "../src/main/vellum-command/browser/sessions";
import type { ActorSeatOccupyApi } from "../src/main/vellum-command/term/actor-seat-occupy";

const PNG = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);

const agent = (
  id: string,
  extra?: { readonly bindingId?: string; readonly harness?: "codex" | "claude" },
): TextNode => ({
  id,
  type: "text",
  text: id,
  x: 0,
  y: 0,
  width: 200,
  height: 80,
  ether: {
    entity: { kind: "agent", name: `local:${id}` },
    host: "local",
    terminal: {
      bindingId: extra?.bindingId ?? `bind-${id}`,
      harness: extra?.harness ?? "codex",
      launch: { kind: "harness", argv: ["codex"] },
    },
  },
});

const page = (id: string, url = "https://example.com/"): CanvasNode => ({
  id,
  type: "link",
  url,
  x: 200,
  y: 0,
  width: 100,
  height: 40,
  ether: { entity: { kind: "page" }, browser: { profile: "personal" }, host: "local" },
});

const cron = (id: string): CanvasNode => ({
  id,
  type: "text",
  text: id,
  x: 0,
  y: 80,
  width: 120,
  height: 40,
  ether: { entity: { kind: "cron" }, host: "local", timer: { everyMinutes: 5 } },
});

const git = (id: string, cwd: string): CanvasNode => ({
  id,
  type: "text",
  text: id,
  x: 0,
  y: 160,
  width: 120,
  height: 40,
  ether: { entity: { kind: "git" }, host: "local", git: { cwd } },
});

const doc = (nodes: CanvasDoc["nodes"], edges: CanvasDoc["edges"] = []): CanvasDoc => ({
  nodes,
  edges,
});

const makeTermPlane = (overrides: {
  readonly kill?: (bindingId: string, hostId?: string) => Promise<boolean>;
  readonly get?: (bindingId: string, hostId?: string) => Promise<unknown>;
  readonly create?: (input: unknown) => Promise<unknown>;
  readonly writeManagedSeat?: (bindingId: string, data: string) => boolean;
  readonly resizeManagedSeat?: (bindingId: string, cols: number, rows: number) => boolean;
  readonly deleteBinding?: (bindingId: string, hostId?: string) => Promise<boolean>;
} = {}): TermPlane => {
  const router = {
    isLocalHostId: (hostId: string | undefined | null) =>
      hostId === undefined || hostId === null || hostId.trim() === "" || hostId === "local",
    attach: vi.fn(async () => ({ ok: false, message: "no attach in test" })),
    release: vi.fn(async () => undefined),
    write: vi.fn(async () => false),
    resize: vi.fn(async () => false),
    get: overrides.get ?? (async () => undefined),
    kill: overrides.kill ?? (async () => true),
    create: overrides.create ?? (async (input: { bindingId: string }) => ({
      bindingId: input.bindingId,
      hostId: "local",
      status: "running",
      epoch: "e1",
      detached: true,
      createdAt: 1,
    })),
    deleteBinding: overrides.deleteBinding ?? (async () => true),
  };
  const host = {
    writeManagedSeat: overrides.writeManagedSeat ?? vi.fn(() => true),
    resizeManagedSeat: overrides.resizeManagedSeat ?? vi.fn(() => true),
  };
  const plane = {
    router,
    host,
    nodeDelete: undefined as unknown as TerminalNodeDeleteService,
  };
  plane.nodeDelete = new TerminalNodeDeleteService(router as never);
  return plane as unknown as TermPlane;
};

const makeChats = (): ChatService => {
  const chats = {
    isLive: vi.fn(() => false),
    chatClose: vi.fn(async () => ({ ok: true, clean: true })),
    admitDeleteTombstone: vi.fn(() => ({ ok: true as const })),
    releaseDeleteTombstone: vi.fn(),
    nodeDelete: undefined as unknown as NodeDeleteService,
  };
  chats.nodeDelete = new NodeDeleteService(chats as never);
  return chats as unknown as ChatService;
};

const occupy: ActorSeatOccupyApi = {
  occupy: () => Effect.succeed({
    bindingId: "bind-a1",
    hostId: "local",
    status: "running",
    epoch: "e1",
    detached: true,
    createdAt: 1,
  } as never),
  occupancy: () => Effect.succeed({ _tag: "vacant" } as never),
};

const live = (
  documents: ReadonlyArray<{ name: string; doc: CanvasDoc }>,
  extra: Partial<OverseerNativeLiveOptions> = {},
) => {
  const termPlane = extra.termPlane ?? makeTermPlane();
  const chats = extra.chats ?? makeChats();
  return makeOverseerNativeLive({
    termPlane,
    chats,
    captureApplicationPage: extra.captureApplicationPage ?? (async () => ({
      ok: true,
      png: PNG,
    })),
    liveOverseerGrant: extra.liveOverseerGrant ?? (async () => true),
    listCanvasDocuments: extra.listCanvasDocuments ?? (async () => documents),
    actorSeatOccupy: extra.actorSeatOccupy ?? occupy,
    ...extra,
  });
};

const run = async (
  native: ReturnType<typeof makeOverseerNativeLive>,
  operation: string,
  args?: unknown,
) =>
  Effect.runPromise(
    native.executeResult(
      { canvasName: "factory", nodeId: "overseer-1" },
      { operation: operation as never, ...(args === undefined ? {} : { args }) },
    ),
  );

describe("overseer page authz", () => {
  it("admits local pages without an edge and leaves normal agents edge-bound", () => {
    const board = doc([agent("a1"), page("p1")]);
    expect(admitOverseerPage(board, "p1").ok).toBe(true);
    expect(overseerPageNodeIds(board)).toEqual(["p1"]);
    expect(callerMayAccessPage(board, "a1", "p1")).toBe(false);
  });

  it("refuses a missing or unprofiled page", () => {
    const board = doc([
      {
        id: "p-bad",
        type: "link",
        url: "https://example.com/",
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        ether: { entity: { kind: "page" } },
      },
    ]);
    expect(admitOverseerPage(board, "missing").ok).toBe(false);
    expect(admitOverseerPage(board, "p-bad").ok).toBe(false);
  });
});

describe("overseer native adapters", () => {
  const board = doc([agent("a1"), page("p1"), cron("c1")]);

  it("lists agents and pages without requiring edges", async () => {
    const native = live([{ name: "factory", doc: board }]);
    const agents = await run(native, "agent.list", {});
    expect(agents.ok).toBe(true);
    if (!agents.ok) return;
    expect((agents.data as { agents: ReadonlyArray<{ nodeId: string }> }).agents.map((row) => row.nodeId)).toEqual(["a1"]);

    const pages = await run(native, "page.list", {});
    expect(pages.ok).toBe(true);
    if (!pages.ok) return;
    expect((pages.data as { pages: ReadonlyArray<{ nodeId: string }> }).pages.map((row) => row.nodeId)).toEqual(["p1"]);
  });

  it("prompts through managedDrive without a renderer control lease", async () => {
    const writePrompt = vi.fn(async () => true);
    const native = live([{ name: "factory", doc: board }], {
      managedDrive: { writePrompt, interrupt: vi.fn(async () => true) },
    });
    const result = await run(native, "agent.prompt", { nodeId: "a1", text: "hello" });
    expect(result.ok).toBe(true);
    expect(writePrompt).toHaveBeenCalledWith("bind-a1", "hello");
  });

  it("interrupts via Ctrl+C on the managed seat when no drive is bound", async () => {
    const writeManagedSeat = vi.fn(() => true);
    const native = live([{ name: "factory", doc: board }], {
      termPlane: makeTermPlane({ writeManagedSeat }),
    });
    const result = await run(native, "agent.interrupt", { nodeId: "a1" });
    expect(result.ok).toBe(true);
    expect(writeManagedSeat).toHaveBeenCalledWith("bind-a1", INTERRUPT_BYTE);
  });

  it("rechecks live grant after the async prompt boundary", async () => {
    let granted = true;
    const writePrompt = vi.fn(async () => {
      granted = false;
      return true;
    });
    const native = live([{ name: "factory", doc: board }], {
      managedDrive: { writePrompt, interrupt: vi.fn(async () => true) },
      liveOverseerGrant: async () => granted,
    });
    const result = await run(native, "agent.prompt", { nodeId: "a1", text: "hello" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.type).toBe("Forbidden");
    expect(writePrompt).toHaveBeenCalled();
  });

  it("returns an honest PNG for canvas.screenshot and refuses a labelled fake", async () => {
    const native = live([{ name: "factory", doc: board }]);
    const shot = await run(native, "canvas.screenshot", {});
    expect(shot.ok).toBe(true);
    if (!shot.ok) return;
    const png = Buffer.from((shot.data as { pngBase64: string }).pngBase64, "base64");
    expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);

    const unavailable = live([{ name: "factory", doc: board }], {
      captureApplicationPage: async () => ({
        ok: false,
        unavailable: true,
        reason: "headless Remote has no application view to capture",
      }),
    });
    const missing = await run(unavailable, "canvas.screenshot", {});
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.error.type).toBe("RuntimeDown");
    expect(missing.error.details).toMatchObject({ unavailable: true });
  });

  it("reports page.* RuntimeDown when browser composition is absent", async () => {
    const native = live([{ name: "factory", doc: board }]);
    const opened = await run(native, "page.open", { nodeId: "p1" });
    expect(opened.ok).toBe(false);
    if (opened.ok) return;
    expect(opened.error.type).toBe("RuntimeDown");
  });

  it("opens a page through BrowserSessionService after live-grant revalidation", async () => {
    const openForOwner = vi.fn(async (
      _owner: string,
      target: { url: string },
      _signal?: unknown,
      revalidate?: () => Promise<{ ok: true; data: unknown } | { ok: false; code: string; message: string }>,
    ) => {
      const refreshed = revalidate === undefined ? { ok: true as const, data: target } : await revalidate();
      if (!refreshed.ok) return refreshed;
      return { ok: true as const, data: { sessionId: "sess-1", url: target.url } };
    });
    const pages = {
      admitAutomationHost: () => ({ ok: true, host: { id: "local" } }),
      openForOwner,
      sessionIdForRefForOwner: () => undefined,
      sessionIdForRef: () => undefined,
    } as unknown as BrowserSessionService;
    const native = live([{ name: "factory", doc: board }], { pages });
    const opened = await run(native, "page.open", { nodeId: "p1" });
    expect(opened.ok).toBe(true);
    expect(openForOwner).toHaveBeenCalled();
    expect(openForOwner.mock.calls[0]?.[0]).toBe("overseer");
  });

  it("starts an agent through actorSeatOccupy", async () => {
    const occupySpy = vi.fn(() => occupy.occupy("unused" as never));
    const native = live([{ name: "factory", doc: board }], {
      actorSeatOccupy: { ...occupy, occupy: occupySpy },
    });
    const started = await run(native, "agent.start", { nodeId: "a1" });
    expect(started.ok).toBe(true);
    expect(occupySpy).toHaveBeenCalled();
  });

  it("reseats by killing the prior generation and committing canvas-owned fields", async () => {
    const kill = vi.fn(async () => true);
    const commitAgentReseat = vi.fn(async () => ({ ok: true as const }));
    const native = live([{ name: "factory", doc: board }], {
      termPlane: makeTermPlane({ kill }),
      commitAgentReseat,
    });
    const reseated = await run(native, "agent.reseat", { nodeId: "a1", harness: "claude" });
    expect(reseated.ok).toBe(true);
    expect(kill).toHaveBeenCalledWith("bind-a1", "local");
    expect(commitAgentReseat).toHaveBeenCalled();
    const committedArg = (commitAgentReseat.mock.calls as unknown as ReadonlyArray<
      ReadonlyArray<{ next: TextNode }>
    >)[0]?.[0];
    const next = committedArg?.next;
    expect(next?.ether?.terminal?.harness).toBe("claude");
    expect(next?.ether?.terminal?.bindingId).not.toBe("bind-a1");
    expect(next?.id).toBe("a1");
  });

  it("refuses reseat without the canvas commit hook", async () => {
    const native = live([{ name: "factory", doc: board }]);
    const reseated = await run(native, "agent.reseat", { nodeId: "a1", harness: "claude" });
    expect(reseated.ok).toBe(false);
    if (reseated.ok) return;
    expect(reseated.error.type).toBe("Unsupported");
  });

  it("does not silently write scheduler.configure without the canvas hook", async () => {
    const native = live([{ name: "factory", doc: board }]);
    const configured = await run(native, "scheduler.configure", { nodeId: "c1" });
    expect(configured.ok).toBe(false);
    if (configured.ok) return;
    expect(configured.error.type).toBe("Unsupported");
  });

  it("rejects unknown native operations and invalid args via the contract decoder", () => {
    expect(Result.isFailure(decodeOverseerArgs("agent.prompt", {}))).toBe(true);
    const native = live([{ name: "factory", doc: board }]);
    return expect(run(native, "canvas.list", {})).resolves.toMatchObject({
      ok: false,
      error: { type: "Unsupported" },
    });
  });
});

describe("overseer deletion fences share TermPlane/ChatService identity", () => {
  it("locks the same TerminalNodeDeleteService renderer IPC would use", async () => {
    const termPlane = makeTermPlane({
      deleteBinding: vi.fn(async () => true),
    });
    const chats = makeChats();
    const native = live([{ name: "factory", doc: doc([agent("a1")]) }], { termPlane, chats });
    const admitted = termPlane.nodeDelete.admitCreate("bind-a1", "local");
    const prepared = await native.prepareOverseerNodeDelete([
      { kind: "terminal", bindingId: "bind-a1", hostId: "local" },
    ]);
    expect(prepared.ok).toBe(true);
    expect(() => termPlane.nodeDelete.assertCreate(admitted)).toThrow(/revoked by node deletion/u);
    if (!prepared.ok) return;
    expect(native.finishOverseerNodeDelete(prepared.leaseId, "committed")).toEqual({ ok: true });
    expect(termPlane.nodeDelete.isLocked("bind-a1", "local")).toBe(false);
  });

  it("reuses ChatService.nodeDelete rather than constructing a second fence", async () => {
    const chats = makeChats();
    const native = live([{ name: "factory", doc: doc([agent("a1")]) }], { chats });
    expect(chats.nodeDelete.isLocked("local:a1")).toBe(false);
    const prepared = await native.prepareOverseerNodeDelete([
      { kind: "agent", agentKey: "local:a1" },
    ]);
    expect(prepared.ok).toBe(true);
    expect(chats.nodeDelete.isLocked("local:a1")).toBe(true);
    if (!prepared.ok) return;
    native.finishOverseerNodeDelete(prepared.leaseId, "aborted");
    expect(chats.nodeDelete.isLocked("local:a1")).toBe(false);
  });

  it("stops pages through BrowserSessionService and reports partial failure honestly", async () => {
    const stopForOwner = vi.fn(async () => ({ ok: false, code: "failed", message: "view still destroying" }));
    const pages = { stopForOwner } as unknown as BrowserSessionService;
    const native = live([{ name: "factory", doc: doc([page("p1")]) }], { pages });
    const prepared = await native.prepareOverseerNodeDelete([
      { kind: "page", sessionId: "sess-1" },
    ]);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.pageStops).toEqual([
      { sessionId: "sess-1", stopped: false, error: "view still destroying" },
    ]);
    expect(stopForOwner).toHaveBeenCalled();
  });
});
