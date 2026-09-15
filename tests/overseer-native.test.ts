import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Effect, Fiber, ManagedRuntime, Result } from "effect";
import type { CanvasDoc, CanvasNode, TextNode } from "../src/shared/canvas";
import type { ManagedPromptOutcome } from "../src/shared/managed-prompt";
import { decodeOverseerArgs } from "../src/shared/overseer-control";
import {
  INTERRUPT_BYTE,
  ManagedTerminalDrive,
} from "../src/main/vellum-command/term/drive";
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
import {
  BrowserSessionService,
  type BrowserViewAdapter,
} from "../src/main/vellum-command/browser/sessions";
import { makeBrowserProfileService } from "../src/main/vellum-command/browser/profiles";
import { makeStateEngineLive } from "../src/main/vellum-command/state/engine";
import { StateEngine } from "../src/main/vellum-command/state/service";
import { LOCAL_BROWSER_TEST_AUTHORITY } from "./browser-host-test-authority";
import type { ResolvedPageTarget } from "../src/main/vellum-command/browser/page-target";


const PNG = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);

const submittedPrompt = (): ManagedPromptOutcome => ({
  status: "submitted",
  bindingGeneration: 2,
  writesBefore: 3,
  writesAfter: 4,
  pasteWrites: 1,
  wrotePhysicalBytes: true,
});

const refusedPrompt = (
  reason: "seat-busy" | "written-unresolved" = "seat-busy",
): ManagedPromptOutcome => ({
  status: "refused",
  reason,
  bindingGeneration: 2,
  writesBefore: 4,
  writesAfter: 4,
  pasteWrites: 0,
  wrotePhysicalBytes: false,
});

const unresolvedPrompt = (
  reason: "no-turn-start" | "chip-pending",
): ManagedPromptOutcome => ({
  ...submittedPrompt(),
  status: "unresolved",
  reason,
});

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
  readonly attach?: (input: {
    readonly bindingId?: string;
    readonly hostId?: string;
    readonly mode: string;
  }) => Promise<unknown>;
  readonly release?: (lease: unknown, hostId?: string) => Promise<void>;
} = {}): TermPlane => {
  const router = {
    isLocalHostId: (hostId: string | undefined | null) =>
      hostId === undefined || hostId === null || hostId.trim() === "" || hostId === "local",
    attach: overrides.attach ?? vi.fn(async () => ({ ok: false, message: "no attach in test" })),
    release: overrides.release ?? vi.fn(async () => undefined),
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

const occupySeatDefault = async (
  _spec: unknown,
  signal: AbortSignal,
): Promise<boolean> => !signal.aborted;

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
    occupySeat: extra.occupySeat ?? occupySeatDefault,
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
    const writePrompt = vi.fn(async () => submittedPrompt());
    const native = live([{ name: "factory", doc: board }], {
      managedDrive: { writePrompt, interrupt: vi.fn(async () => true) },
    });
    const result = await run(native, "agent.prompt", { nodeId: "a1", text: "hello" });
    expect(result).toMatchObject({
      ok: true,
      data: { delivered: true, bindingId: "bind-a1" },
    });
    expect(writePrompt).toHaveBeenCalledWith("bind-a1", "hello", {
      queueIfBusy: false,
      signal: expect.any(AbortSignal),
    });
  });

  it("returns a refusal when the managed drive writes no prompt bytes", async () => {
    const writePrompt = vi.fn(async () => refusedPrompt());
    const native = live([{ name: "factory", doc: board }], {
      managedDrive: { writePrompt, interrupt: vi.fn(async () => true) },
    });
    const result = await run(native, "agent.prompt", { nodeId: "a1", text: "hello" });
    expect(result).toMatchObject({
      ok: false,
      error: { type: "RuntimeDown" },
    });
    expect(writePrompt).toHaveBeenCalledTimes(1);
  });

  it.each([
    unresolvedPrompt("no-turn-start"),
    unresolvedPrompt("chip-pending"),
    refusedPrompt("written-unresolved"),
  ])("surfaces $status/$reason as uncertain without retrying", async (outcome) => {
    const writePrompt = vi.fn(async () => outcome);
    const native = live([{ name: "factory", doc: board }], {
      managedDrive: { writePrompt, interrupt: vi.fn(async () => true) },
    });
    const result = await run(native, "agent.prompt", { nodeId: "a1", text: "hello" });
    expect(result).toMatchObject({
      ok: true,
      data: {
        delivered: false,
        uncertain: true,
        bindingId: "bind-a1",
        message: expect.stringContaining("do not repaste automatically"),
      },
    });
    expect(writePrompt).toHaveBeenCalledTimes(1);
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
      return submittedPrompt();
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

  it("controls an existing UI-owned page without impersonating the UI sender", async () => {
    const gotoForOwner = vi.fn(() => ({
      ok: true as const,
      data: { sessionId: "ui-sess", url: "https://example.com/next" },
    }));
    const pages = {
      overseerSessionsForRef: () => [{ owner: "vellum-command-ui", sessionId: "ui-sess" }],
      overseerSessionOwner: (sessionId: string) =>
        sessionId === "ui-sess" ? "vellum-command-ui" : undefined,
      sessionIdForRefForOwner: () => undefined,
      sessionIdForRef: () => "ui-sess",
      stateForOwner: (owner: string, sessionId: string) => ({
        ok: true as const,
        data: { sessionId, owner, url: "https://example.com/" },
      }),
      gotoForOwner,
      admitAutomationHost: () => ({ ok: true, host: { id: "local" } }),
    } as unknown as BrowserSessionService;
    const native = live([{ name: "factory", doc: board }], { pages });
    const got = await run(native, "page.get", { nodeId: "p1" });
    expect(got.ok).toBe(true);
    const moved = await run(native, "page.goto", {
      sessionId: "ui-sess",
      url: "https://example.com/next",
    });
    expect(moved.ok).toBe(true);
    expect(gotoForOwner).toHaveBeenCalledWith(
      "vellum-command-ui",
      "ui-sess",
      "https://example.com/next",
    );
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

  it("starts an agent through occupySeat", async () => {
    const occupySpy = vi.fn(async () => true);
    const native = live([{ name: "factory", doc: board }], {
      occupySeat: occupySpy,
    });
    const started = await run(native, "agent.start", { nodeId: "a1" });
    expect(started.ok).toBe(true);
    expect(occupySpy).toHaveBeenCalled();
  });

  it("wakes an already-occupied seat through occupy (activate path), never a second occupy-vacant", async () => {
    const { occupiedSeat, seatAdmission } = await import(
      "../src/shared/terminal-seat-occupancy"
    );
    const occupied = occupiedSeat("bind-a1", "live-epoch", "local");
    const admission = seatAdmission(occupied);
    expect(admission._tag).toBe("ActivateOccupiedSeat");
    const occupySpy = vi.fn(async (spec: { bindingId: string; hostId?: string }) => {
      expect(spec.bindingId).toBe("bind-a1");
      expect(spec.hostId).toBe("local");
      expect(seatAdmission(occupied)._tag).toBe("ActivateOccupiedSeat");
      return true;
    });
    const native = live([{ name: "factory", doc: board }], {
      occupySeat: occupySpy,
    });
    const woken = await run(native, "agent.wake", { nodeId: "a1" });
    expect(woken.ok).toBe(true);
    expect(occupySpy).toHaveBeenCalledTimes(1);
    expect(occupySpy.mock.calls[0]?.[0]).toMatchObject({
      bindingId: "bind-a1",
      hostId: "local",
      canvasName: "factory",
      nodeId: "a1",
    });
  });

  it("reads remote agent output via router observe attach, not the local observer", async () => {
    const remoteAgent: TextNode = {
      ...agent("remote-a", { bindingId: "bind-remote" }),
      ether: { ...agent("remote-a", { bindingId: "bind-remote" }).ether!, host: "studio" },
    };
    const attach = vi.fn(async (input: { hostId?: string; mode: string }) => {
      expect(input.hostId).toBe("studio");
      expect(input.mode).toBe("observe");
      return {
        ok: true,
        lease: { leaseId: "obs", bindingId: "bind-remote", epoch: "e", mode: "observe" },
        screen: { serialized: "remote-screen", seq: 9n, epoch: "e" },
      };
    });
    const release = vi.fn(async () => undefined);
    const plane = makeTermPlane({ attach, release });
    const native = live([{ name: "factory", doc: doc([remoteAgent]) }], { termPlane: plane });
    const output = await run(native, "agent.output", { nodeId: "remote-a" });
    expect(output.ok).toBe(true);
    if (!output.ok) return;
    expect((output.data as { text: string }).text).toBe("remote-screen");
    expect(attach).toHaveBeenCalled();
    expect(release).toHaveBeenCalled();
  });

  it("starts a Remote-hosted agent via occupy hostId, never CC-derived seat identity", async () => {
    const remoteAgent: TextNode = {
      ...agent("remote-a", { bindingId: "bind-remote" }),
      ether: { ...agent("remote-a", { bindingId: "bind-remote" }).ether!, host: "studio" },
    };
    const occupySpy = vi.fn(async (spec: { hostId?: string; bindingId: string }) => {
      expect(spec.hostId).toBe("studio");
      expect(spec.bindingId).toBe("bind-remote");
      return true;
    });
    const native = live([{ name: "factory", doc: doc([remoteAgent]) }], {
      occupySeat: occupySpy,
      stationScope: () => ({
        hostId: "local",
        installationId: "cc-install",
        role: "command-center",
      }),
    });
    const started = await run(native, "agent.start", { nodeId: "remote-a" });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect((started.data as { hostId: string }).hostId).toBe("studio");
    expect(occupySpy).toHaveBeenCalled();
  });

  it("refuses self and same-binding alias reseat before kill or commit", async () => {
    const kill = vi.fn(async () => true);
    const commitAgentReseat = vi.fn(async () => ({ ok: true as const }));
    const selfBoard = doc([agent("overseer-1")]);
    const native = live([{ name: "factory", doc: selfBoard }], {
      termPlane: makeTermPlane({ kill }),
      commitAgentReseat,
    });
    const self = await run(native, "agent.reseat", {
      nodeId: "overseer-1",
      harness: "claude",
    });
    expect(self.ok).toBe(false);
    if (self.ok) return;
    expect(self.error.type).toBe("Forbidden");
    expect(kill).not.toHaveBeenCalled();
    expect(commitAgentReseat).not.toHaveBeenCalled();

    const aliasBoard = doc([
      agent("overseer-1", { bindingId: "shared-bind" }),
      agent("alias", { bindingId: "shared-bind" }),
    ]);
    const aliasNative = live([{ name: "factory", doc: aliasBoard }], {
      termPlane: makeTermPlane({ kill }),
      commitAgentReseat,
    });
    const aliased = await run(aliasNative, "agent.reseat", {
      nodeId: "alias",
      harness: "claude",
    });
    expect(aliased.ok).toBe(false);
    if (aliased.ok) return;
    expect(aliased.error.type).toBe("Forbidden");
    expect(kill).not.toHaveBeenCalled();
    expect(commitAgentReseat).not.toHaveBeenCalled();
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
    expect(commitAgentReseat).toHaveBeenCalledWith(
      expect.objectContaining({
        caller: { canvasName: "factory", nodeId: "overseer-1" },
        canvasName: "factory",
        nodeId: "a1",
      }),
      expect.any(AbortSignal),
    );
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

  it("keeps the remote prompt pending on the destination op without a control lease", async () => {
    let releasePrompt!: (outcome: boolean | "uncertain") => void;
    const heldPrompt = new Promise<boolean | "uncertain">((resolve) => {
      releasePrompt = resolve;
    });
    const managedPrompt = vi.fn(async () => heldPrompt);
    const attach = vi.fn(async () => ({
      ok: true as const,
      lease: { leaseId: "ctl", bindingId: "bind-remote", epoch: "e", mode: "control" as const },
    }));
    const release = vi.fn(async () => undefined);
    const remoteAgent: TextNode = {
      ...agent("remote-a", { bindingId: "bind-remote" }),
      ether: { ...agent("remote-a", { bindingId: "bind-remote" }).ether!, host: "studio" },
    };
    const plane = makeTermPlane({ attach, release });
    (plane.router as unknown as { managedPrompt: unknown }).managedPrompt = managedPrompt;
    const native = live([{ name: "factory", doc: doc([remoteAgent]) }], {
      termPlane: plane,
    });
    const fiber = Effect.runFork(
      native.executeResult(
        { canvasName: "factory", nodeId: "overseer-1" },
        { operation: "agent.prompt" as never, args: { nodeId: "remote-a", text: "hello" } },
      ),
    );
    await vi.waitFor(() => expect(managedPrompt).toHaveBeenCalled());
    // No control lease is taken for a managed remote prompt.
    expect(attach).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    let promptDone = false;
    const finished = Effect.runPromise(Fiber.join(fiber)).then(() => {
      promptDone = true;
    });
    await Promise.resolve();
    expect(promptDone).toBe(false);
    releasePrompt(true);
    await finished;
    expect(promptDone).toBe(true);
  });

  it("does not mutate after Effect interrupt even if the grant is restored", async () => {
    let releaseGrant!: () => void;
    const heldGrant = new Promise<void>((resolve) => {
      releaseGrant = resolve;
    });
    let grantChecks = 0;
    const writePrompt = vi.fn(async () => submittedPrompt());
    const native = live([{ name: "factory", doc: board }], {
      managedDrive: { writePrompt, interrupt: vi.fn(async () => true) },
      liveOverseerGrant: async () => {
        grantChecks += 1;
        if (grantChecks === 1) await heldGrant;
        return true;
      },
    });
    const fiber = Effect.runFork(
      native.executeResult(
        { canvasName: "factory", nodeId: "overseer-1" },
        { operation: "agent.prompt" as never, args: { nodeId: "a1", text: "hello" } },
      ),
    );
    await vi.waitFor(() => expect(grantChecks).toBeGreaterThan(0));
    const interrupted = Effect.runPromise(Fiber.interrupt(fiber));
    releaseGrant();
    await interrupted;
    expect(writePrompt).not.toHaveBeenCalled();
  });

  it("does not start a seat if occupy is aborted mid-flight", async () => {
    let releaseOccupy!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseOccupy = resolve;
    });
    let occupyStarted = false;
    let occupyFinished = false;
    let spawnedAfterAbort = false;
    const occupySeat = vi.fn(async (_spec: unknown, signal: AbortSignal) => {
      occupyStarted = true;
      await held;
      occupyFinished = true;
      if (signal.aborted) return false;
      spawnedAfterAbort = true;
      return true;
    });
    const native = live([{ name: "factory", doc: board }], { occupySeat });
    const fiber = Effect.runFork(
      native.executeResult(
        { canvasName: "factory", nodeId: "overseer-1" },
        { operation: "agent.start" as never, args: { nodeId: "a1" } },
      ),
    );
    await vi.waitFor(() => expect(occupyStarted).toBe(true));
    let interruptDone = false;
    const interrupted = Effect.runPromise(Fiber.interrupt(fiber)).then(() => {
      interruptDone = true;
    });
    await Promise.resolve();
    expect(interruptDone).toBe(false);
    expect(occupyFinished).toBe(false);
    expect(spawnedAfterAbort).toBe(false);
    releaseOccupy();
    await interrupted;
    expect(interruptDone).toBe(true);
    expect(occupyFinished).toBe(true);
    expect(spawnedAfterAbort).toBe(false);
    expect(occupySeat).toHaveBeenCalledTimes(1);
    expect(occupySeat.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);
  });

  it("rejects unknown native operations and invalid args via the contract decoder", () => {
    expect(Result.isFailure(decodeOverseerArgs("agent.prompt", {}))).toBe(true);
    const native = live([{ name: "factory", doc: board }]);
    return expect(run(native, "canvas.list", {})).resolves.toMatchObject({
      ok: false,
      error: { type: "Unsupported" },
    });
  });

  it("does not queue a prompt when the target is busy then later idle", async () => {
    const writes: string[] = [];
    let idle = false;
    const drive = new ManagedTerminalDrive({
      write: (_bindingId, data) => {
        writes.push(data);
        return true;
      },
      isSeatIdle: () => idle,
      stallWatch: false,
      pasteToCrSettleMs: 0,
    });
    const native = live([{ name: "factory", doc: board }], { managedDrive: drive });
    const result = await run(native, "agent.prompt", { nodeId: "a1", text: "queued?" });
    expect(result.ok).toBe(false);
    expect(drive.queuedCount("bind-a1")).toBe(0);
    idle = true;
    drive.onSeatIdle("bind-a1");
    await Promise.resolve();
    expect(writes).toEqual([]);
  });

  it("passes the invocation AbortSignal into page.eval and page.screenshot", async () => {
    const evalForOwner = vi.fn(async (
      _owner: string,
      _sessionId: string,
      _code: string,
      signal?: AbortSignal,
    ) => {
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal?.aborted).toBe(false);
      return { ok: true as const, data: { result: 1 } };
    });
    const screenshotForOwner = vi.fn(async (
      _owner: string,
      _sessionId: string,
      signal?: AbortSignal,
    ) => {
      expect(signal).toBeInstanceOf(AbortSignal);
      return { ok: true as const, data: { png: PNG } };
    });
    const pages = {
      overseerSessionOwner: () => "job-a",
      evalForOwner,
      screenshotForOwner,
    } as unknown as BrowserSessionService;
    const native = live([{ name: "factory", doc: board }], { pages });
    const evaluated = await run(native, "page.eval", { sessionId: "sess-1", code: "1" });
    expect(evaluated.ok).toBe(true);
    expect(evalForOwner).toHaveBeenCalledWith("job-a", "sess-1", "1", expect.any(AbortSignal));
    const shot = await run(native, "page.screenshot", { sessionId: "sess-1" });
    expect(shot.ok).toBe(true);
    expect(screenshotForOwner).toHaveBeenCalledWith("job-a", "sess-1", expect.any(AbortSignal));
  });

  it("interrupts an in-flight eval through the session AbortSignal", async () => {
    let captured: AbortSignal | undefined;
    let releaseEval!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseEval = resolve;
    });
    const evalForOwner = vi.fn(async (
      _owner: string,
      _sessionId: string,
      _code: string,
      signal?: AbortSignal,
    ) => {
      captured = signal;
      await held;
      if (signal?.aborted) return { ok: false as const, code: "cancelled" as const, message: "eval cancelled" };
      return { ok: true as const, data: { result: "late" } };
    });
    const pages = {
      overseerSessionOwner: () => "job-a",
      evalForOwner,
    } as unknown as BrowserSessionService;
    const native = live([{ name: "factory", doc: board }], { pages });
    const fiber = Effect.runFork(
      native.executeResult(
        { canvasName: "factory", nodeId: "overseer-1" },
        { operation: "page.eval" as never, args: { sessionId: "sess-1", code: "1" } },
      ),
    );
    await vi.waitFor(() => expect(captured).toBeInstanceOf(AbortSignal));
    const interrupted = Effect.runPromise(Fiber.interrupt(fiber));
    await vi.waitFor(() => expect(captured?.aborted).toBe(true));
    releaseEval();
    await interrupted;
    expect(evalForOwner).toHaveBeenCalledTimes(1);
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

  it("uses late-bound pages for delete after construct-time undefined", async () => {
    const stopForOwner = vi.fn(async () => ({
      ok: true as const,
      data: { sessionId: "sess-late", stopped: true },
    }));
    let pages: BrowserSessionService | undefined;
    const options: OverseerNativeLiveOptions = {
      termPlane: makeTermPlane(),
      chats: makeChats(),
      get pages() { return pages; },
      captureApplicationPage: async () => ({ ok: true, png: PNG }),
      liveOverseerGrant: async () => true,
      listCanvasDocuments: async () => [{ name: "factory", doc: doc([page("p1")]) }],
      occupySeat: occupySeatDefault,
    };
    const native = makeOverseerNativeLive(options);
    const unbound = await native.prepareOverseerNodeDelete([
      { kind: "page", canvasName: "factory", nodeId: "p1" },
    ]);
    expect(unbound.ok).toBe(false);
    if (unbound.ok) return;
    expect(unbound.error).toMatch(/browser runtime is unavailable/u);

    pages = {
      stopForOwner,
      overseerSessionsForRef: () => [{ owner: "vellum-command-ui", sessionId: "sess-late" }],
      overseerDeleteSessionsForRef: () => [{ owner: "vellum-command-ui", sessionId: "sess-late" }],
      beginOverseerPageDelete: vi.fn(),
      finishOverseerPageDelete: vi.fn(),
    } as unknown as BrowserSessionService;
    const bound = await native.prepareOverseerNodeDelete([
      { kind: "page", canvasName: "factory", nodeId: "p1" },
    ]);
    expect(bound.ok).toBe(true);
    if (!bound.ok) return;
    expect(stopForOwner).toHaveBeenCalledWith("vellum-command-ui", "sess-late");
    expect(bound.pageStops).toEqual([{ sessionId: "sess-late", stopped: true }]);
  });

  it("stops pages through BrowserSessionService and reports partial failure honestly", async () => {
    const stopForOwner = vi.fn(async () => ({ ok: false, code: "failed", message: "view still destroying" }));
    const pages = {
      stopForOwner,
      overseerSessionsForRef: () => [{ owner: "job-a", sessionId: "sess-1" }],
      overseerDeleteSessionsForRef: () => [{ owner: "job-a", sessionId: "sess-1" }],
      beginOverseerPageDelete: vi.fn(),
      finishOverseerPageDelete: vi.fn(),
    } as unknown as BrowserSessionService;
    const native = live([{ name: "factory", doc: doc([page("p1")]) }], { pages });
    const prepared = await native.prepareOverseerNodeDelete([
      { kind: "page", canvasName: "factory", nodeId: "p1" },
    ]);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.pageStops).toEqual([
      { sessionId: "sess-1", stopped: false, error: "view still destroying" },
    ]);
    expect(stopForOwner).toHaveBeenCalledWith("job-a", "sess-1");
  });

  it("treats an unopened page as no live resource and does not fabricate a session id", async () => {
    const stopForOwner = vi.fn();
    const pages = {
      stopForOwner,
      overseerSessionsForRef: () => [],
      overseerDeleteSessionsForRef: () => [],
      beginOverseerPageDelete: vi.fn(),
      finishOverseerPageDelete: vi.fn(),
    } as unknown as BrowserSessionService;
    const native = live([{ name: "factory", doc: doc([page("p1")]) }], { pages });
    const prepared = await native.prepareOverseerNodeDelete([
      { kind: "page", canvasName: "factory", nodeId: "p1" },
    ]);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.leaseId.length).toBeGreaterThan(0);
    expect(prepared.pageStops).toEqual([]);
    expect(stopForOwner).not.toHaveBeenCalled();
    expect(pages.beginOverseerPageDelete).toHaveBeenCalled();
    expect(native.finishOverseerNodeDelete(prepared.leaseId, "committed")).toEqual({ ok: true });
    expect(pages.finishOverseerPageDelete).toHaveBeenCalled();
  });

  it("stops every live owner for one page ref and does not treat node id as a session id", async () => {
    const stopped: Array<{ owner: string; sessionId: string }> = [];
    const pages = {
      stopForOwner: vi.fn(async (owner: string, sessionId: string) => {
        stopped.push({ owner, sessionId });
        return { ok: true as const, data: { sessionId, stopped: true } };
      }),
      overseerSessionsForRef: (ref: string) =>
        ref.includes("p1")
          ? [
              { owner: "vellum-command-ui", sessionId: "ui-sess" },
              { owner: "job-a", sessionId: "auto-a" },
              { owner: "job-b", sessionId: "auto-b" },
            ]
          : [],
      overseerDeleteSessionsForRef: (ref: string) =>
        ref.includes("p1")
          ? [
              { owner: "vellum-command-ui", sessionId: "ui-sess" },
              { owner: "job-a", sessionId: "auto-a" },
              { owner: "job-b", sessionId: "auto-b" },
            ]
          : [],
      beginOverseerPageDelete: vi.fn(),
      finishOverseerPageDelete: vi.fn(),
    } as unknown as BrowserSessionService;
    const native = live([{ name: "factory", doc: doc([page("p1")]) }], { pages });
    const prepared = await native.prepareOverseerNodeDelete([
      { kind: "page", canvasName: "factory", nodeId: "p1" },
    ]);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(pages.beginOverseerPageDelete).toHaveBeenCalled();
    expect(stopped).toEqual([
      { owner: "vellum-command-ui", sessionId: "ui-sess" },
      { owner: "job-a", sessionId: "auto-a" },
      { owner: "job-b", sessionId: "auto-b" },
    ]);
    expect(stopped.every((row) => row.sessionId !== "p1")).toBe(true);
    expect(prepared.pageStops).toEqual([
      { sessionId: "ui-sess", stopped: true },
      { sessionId: "auto-a", stopped: true },
      { sessionId: "auto-b", stopped: true },
    ]);
  });

  it("does not begin agent/terminal teardown when a live page stop fails", async () => {
    const chats = makeChats();
    const termPlane = makeTermPlane({ deleteBinding: vi.fn(async () => true) });
    const pages = {
      stopForOwner: vi.fn(async () => ({
        ok: false as const,
        code: "failed" as const,
        message: "view still destroying",
      })),
      overseerSessionsForRef: () => [{ owner: "job-a", sessionId: "sess-1" }],
      overseerDeleteSessionsForRef: () => [{ owner: "job-a", sessionId: "sess-1" }],
      beginOverseerPageDelete: vi.fn(),
      finishOverseerPageDelete: vi.fn(),
    } as unknown as BrowserSessionService;
    const native = live([{ name: "factory", doc: doc([agent("a1"), page("p1")]) }], {
      chats,
      termPlane,
      pages,
    });
    const prepared = await native.prepareOverseerNodeDelete([
      { kind: "page", canvasName: "factory", nodeId: "p1" },
      { kind: "agent", agentKey: "local:a1" },
      { kind: "terminal", bindingId: "bind-a1", hostId: "local" },
    ]);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.pageStops).toEqual([
      { sessionId: "sess-1", stopped: false, error: "view still destroying" },
    ]);
    expect(chats.nodeDelete.isLocked("local:a1")).toBe(false);
    expect(termPlane.nodeDelete.isLocked("bind-a1", "local")).toBe(false);
  });

  it("holds a pending open and a new open across prepare-to-finish without a late view", async () => {
    const root = await mkdtemp(join(tmpdir(), "vellum-overseer-page-fence-"));
    const runtime = ManagedRuntime.make(makeStateEngineLive(join(root, "vellum-command.db")));
    const state = await runtime.runPromise(StateEngine);
    const profiles = makeBrowserProfileService(state, root);
    await Effect.runPromise(profiles.ensureDefaults);

    const views: Array<{ partition: string; destroyed: boolean; loadUrl?: string }> = [];
    let releasePartition!: (value: string) => void;
    const partitionHold = new Promise<string>((resolve) => {
      releasePartition = resolve;
    });
    let partitionReads = 0;
    const gatedProfiles = {
      ...profiles,
      partitionName: (profile: string) => {
        if (profile === "personal") {
          return Effect.promise(() => {
            partitionReads += 1;
            return partitionHold;
          });
        }
        return profiles.partitionName(profile);
      },
    };
    const adapter: BrowserViewAdapter = (partition) => {
      const view = { partition, destroyed: false, loadUrl: undefined as string | undefined };
      views.push(view);
      return {
        loadUrl: async (url: string) => {
          view.loadUrl = url;
        },
        attach: () => {},
        setBounds: () => {},
        detach: () => {},
        destroy: () => {
          view.destroyed = true;
        },
      };
    };
    const pages = new BrowserSessionService(
      adapter,
      LOCAL_BROWSER_TEST_AUTHORITY,
      gatedProfiles,
      () => Date.now(),
      (() => {
        let n = 0;
        return () => `session-${++n}`;
      })(),
    );
    pages.setPoolLimitsProvider(async () => ({ maxVisibleSurfaces: 4, maxWarmSessions: 8 }));

    const deleted: ResolvedPageTarget = {
      ref: "vellum-command://canvas/factory?node=p1",
      nodeId: "p1",
      url: "https://p1.example.com",
      hostId: "local",
      profile: "personal",
    };
    const pending = pages.openForOwner("job-a", deleted);
    await vi.waitFor(() => expect(partitionReads).toBe(1));

    const native = live([{ name: "factory", doc: doc([page("p1")]) }], { pages });
    const prepared = await native.prepareOverseerNodeDelete([
      { kind: "page", canvasName: "factory", nodeId: "p1" },
    ]);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;

    const duringLease = pages.openForOwner("job-c", deleted);
    await expect(duringLease).resolves.toMatchObject({ ok: false, code: "cancelled" });

    const sibling = await pages.openForOwner("job-b", {
      ref: "vellum-command://canvas/factory?node=p-sibling",
      nodeId: "p-sibling",
      url: "https://sibling.example.com",
      hostId: "local",
      profile: "work",
    });
    expect(sibling.ok).toBe(true);

    expect(native.finishOverseerNodeDelete(prepared.leaseId, "committed")).toEqual({ ok: true });
    releasePartition("persist:vellum-profile-personal");
    await expect(pending).resolves.toMatchObject({ ok: false, code: "cancelled" });
    expect(views.some((view) => view.partition.includes("personal") && view.loadUrl !== undefined))
      .toBe(false);
    expect(pages.overseerSessionsForRef(deleted.ref)).toEqual([]);

    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  });

  const withRealPages = async (
    timeoutMs: number,
    body: (input: {
      readonly pages: BrowserSessionService;
      readonly native: ReturnType<typeof live>;
      readonly opened: { readonly sessionId: string; readonly ref: string };
      readonly resolveDestroyed: () => void;
      readonly destroyCalls: () => number;
    }) => Promise<void>,
  ): Promise<void> => {
    const root = await mkdtemp(join(tmpdir(), "vellum-overseer-page-receipt-"));
    const runtime = ManagedRuntime.make(makeStateEngineLive(join(root, "vellum-command.db")));
    try {
      const state = await runtime.runPromise(StateEngine);
      const profiles = makeBrowserProfileService(state, root);
      await Effect.runPromise(profiles.ensureDefaults);
      let resolveDestroyed!: () => void;
      const destroyedPromise = new Promise<void>((resolve) => {
        resolveDestroyed = resolve;
      });
      let destroyCalls = 0;
      const adapter: BrowserViewAdapter = () => ({
        loadUrl: async () => {},
        attach: () => {},
        setBounds: () => {},
        detach: () => {},
        destroy: () => {
          destroyCalls += 1;
        },
        whenDestroyed: () => destroyedPromise,
      });
      const pages = new BrowserSessionService(
        adapter,
        LOCAL_BROWSER_TEST_AUTHORITY,
        profiles,
        () => Date.now(),
        (() => {
          let n = 0;
          return () => `session-${++n}`;
        })(),
        undefined,
        undefined,
        timeoutMs,
      );
      pages.setPoolLimitsProvider(async () => ({ maxVisibleSurfaces: 4, maxWarmSessions: 8 }));
      const opened = await pages.openForOwner("job-a", {
        ref: "vellum-command://canvas/factory?node=p1",
        nodeId: "p1",
        url: "https://p1.example.com",
        hostId: "local",
        profile: "personal",
      });
      expect(opened.ok).toBe(true);
      if (!opened.ok) return;
      const native = live([{ name: "factory", doc: doc([page("p1")]) }], { pages });
      await body({
        pages,
        native,
        opened: { sessionId: opened.data.sessionId, ref: opened.data.ref },
        resolveDestroyed,
        destroyCalls: () => destroyCalls,
      });
    } finally {
      await runtime.dispose();
      await rm(root, { recursive: true, force: true });
    }
  };

  it("holds concurrent page delete prepare until whenDestroyed settles", async () => {
    await withRealPages(5_000, async ({ pages, native, opened, resolveDestroyed, destroyCalls }) => {
      const first = native.prepareOverseerNodeDelete([
        { kind: "page", canvasName: "factory", nodeId: "p1" },
      ]);
      await vi.waitFor(() => expect(pages.overseerSessionsForRef(opened.ref)).toEqual([]));
      expect(pages.overseerDeleteSessionsForRef(opened.ref)).toEqual([
        { owner: "job-a", sessionId: opened.sessionId },
      ]);
      const concurrent = native.prepareOverseerNodeDelete([
        { kind: "page", canvasName: "factory", nodeId: "p1" },
      ]);
      let concurrentSettled = false;
      void concurrent.then(() => {
        concurrentSettled = true;
      });
      await Promise.resolve();
      expect(concurrentSettled).toBe(false);
      resolveDestroyed();
      const firstResult = await first;
      const concurrentResult = await concurrent;
      expect(firstResult.ok).toBe(true);
      expect(concurrentResult.ok).toBe(true);
      if (!firstResult.ok || !concurrentResult.ok) return;
      expect(firstResult.pageStops).toEqual([{ sessionId: opened.sessionId, stopped: true }]);
      expect(concurrentResult.pageStops[0]?.sessionId).toBe(opened.sessionId);
      expect(pages.overseerDeleteSessionsForRef(opened.ref)).toEqual([]);
      expect(destroyCalls()).toBe(1);
      native.finishOverseerNodeDelete(firstResult.leaseId, "committed");
      native.finishOverseerNodeDelete(concurrentResult.leaseId, "aborted");
    });
  });

  it("retries a timed-out page delete until the destruction receipt, never claiming empty success", async () => {
    await withRealPages(20, async ({ pages, native, opened, resolveDestroyed, destroyCalls }) => {
      const timed = await native.prepareOverseerNodeDelete([
        { kind: "page", canvasName: "factory", nodeId: "p1" },
      ]);
      expect(timed.ok).toBe(true);
      if (!timed.ok) return;
      expect(timed.pageStops[0]?.sessionId).toBe(opened.sessionId);
      expect(timed.pageStops[0]?.stopped).toBe(false);
      expect(timed.pageStops[0]?.error).toMatch(/did not terminate/u);
      expect(pages.overseerSessionsForRef(opened.ref)).toEqual([]);
      expect(pages.overseerDeleteSessionsForRef(opened.ref)).toEqual([
        { owner: "job-a", sessionId: opened.sessionId },
      ]);
      expect(destroyCalls()).toBe(1);
      native.finishOverseerNodeDelete(timed.leaseId, "aborted");

      const retry = native.prepareOverseerNodeDelete([
        { kind: "page", canvasName: "factory", nodeId: "p1" },
      ]);
      let retrySettled = false;
      void retry.then(() => {
        retrySettled = true;
      });
      await Promise.resolve();
      expect(retrySettled).toBe(false);
      resolveDestroyed();
      const retried = await retry;
      expect(retried.ok).toBe(true);
      if (!retried.ok) return;
      expect(retried.pageStops).toEqual([{ sessionId: opened.sessionId, stopped: true }]);
      expect(pages.overseerDeleteSessionsForRef(opened.ref)).toEqual([]);
      expect(destroyCalls()).toBe(1);
      native.finishOverseerNodeDelete(retried.leaseId, "committed");
    });
  });
});
