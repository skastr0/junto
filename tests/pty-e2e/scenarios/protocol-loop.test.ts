/**
 * protocol-loop.test.ts — CUSTOMER-REPORT protocol defects (PROTO-1..9)
 *
 * Reproduces the CodeCanary factory complaint through the REAL protocol stack:
 * canvases commits -> onCanvasChangeForEdgeMap -> deliverEdgeMapChangeNotices
 * -> WorkService.workSystemMailboxNotify -> repository.appendMessage ->
 * messageDelivery.notifyAppended -> attemptOne -> REAL ManagedTerminalDrive ->
 * ScriptedTui -> REAL SessionObserver/SeatStateRuntime.
 *
 * Wiring + fakes are documented in tests/pty-e2e/proto-harness.ts. Every test
 * asserts CORRECT behavior (what the product law demands); a failure on the
 * current tree IS the reproduction.
 *
 *   PROTO-1  A->B->C in one flush window -> exactly ONE notice (today: one per commit)
 *   PROTO-2  pre-write refusals remain retryable; accepted mail never re-pastes
 *   PROTO-3  stale "Added" notice must not be pasted after the edge is removed
 *   PROTO-4  A->B->A nets to zero -> ZERO notices (today: two)
 *   PROTO-5  delivery paste is a compact one-liner with ids only (today: full contract table)
 *   PROTO-6  no durable receipt without marker-confirmed submit (SKIPPED — see reason)
 *   PROTO-8  paused seat reports paused:true + next_step (today: absent)
 *   PROTO-9  agent<->agent edge add -> exactly one notice per seat
 */
import { mkdirSync, readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createConnection } from "node:net";
import {
  BRACKETED_PASTE_START,
} from "../../../src/main/junto/term/drive/typing";
import { encodeWorkFrame } from "../../../src/shared/work-control";
import type { CanvasDoc } from "../../../src/shared/canvas";
import { ProtoHarness, makeProtoRoot } from "../proto-harness";
import { startWorkControlServer, type WorkControlServer } from "../../../src/main/junto/work/control";
import { createMainAuthoringGate } from "../../../src/main/junto/main-authoring-gate";
import { makeProcessIdentityMap } from "../../../src/main/junto/process-identity";
import { resetSeatBlocks } from "../../../src/main/junto/work/blocked-seat";

// ---------------------------------------------------------------------------
// Shared doc builders
// ---------------------------------------------------------------------------

const seatNode = (id: string, bindingId?: string): CanvasDoc["nodes"][number] => ({
  id,
  type: "text",
  text: id,
  x: 0,
  y: 0,
  width: 120,
  height: 48,
  ether: {
    entity: { kind: "agent", name: `local:${id}` },
    terminal: {
      bindingId: bindingId ?? `bind-${id}`,
      harness: "claude",
      launch: { kind: "harness", argv: ["claude"] },
    },
  },
});

const kindNode = (id: string, kind: string): CanvasDoc["nodes"][number] => ({
  id,
  type: "text",
  text: id,
  x: 200,
  y: 0,
  width: 120,
  height: 48,
  ether: { entity: { kind } },
});

const edge = (id: string, fromNode: string, toNode: string) => ({
  id,
  fromNode,
  toNode,
});

// ---------------------------------------------------------------------------
// Fake-timer loop setup (same discipline as tests/pty-e2e/scenarios/drive-law.test.ts)
// ---------------------------------------------------------------------------

// Effect's module-level Scheduler.default captured the REAL setImmediate at
// import time; vitest fake timers fake globalThis.setImmediate, so
// fire-and-forget Effect continuations (attemptOne's store effects) only
// progress when the REAL event loop gets a turn. Captured before any
// vi.useFakeTimers() call.
const realSetImmediate: (fn: () => void) => unknown =
  (globalThis as { setImmediate?: (fn: () => void) => unknown }).setImmediate ??
  ((fn: () => void) => setTimeout(fn, 0));
const realTick = () => new Promise<void>((resolve) => realSetImmediate(resolve));

const setupLoop = async (over: {
  readonly wedged?: boolean;
  readonly wireChangeListener?: boolean;
  readonly canvasName?: string;
  readonly tui?: ConstructorParameters<typeof ProtoHarness>[0]["tui"];
} = {}) => {
  vi.useFakeTimers({ now: 1_000_000 });
  const root = makeProtoRoot("proto-loop");
  const harness = new ProtoHarness({
    root,
    loop: true,
    harness: "claude",
    now: () => Date.now(),
    stallTimeoutMs: 5_000,
    pasteToCrSettleMs: 40,
    wedged: over.wedged,
    wireChangeListener: over.wireChangeListener,
    tui: { workingFrames: 1, ...over.tui },
  });
  await harness.start();
  await harness.setStationCommandCenter();
  // Delivery scenarios run on a PLAYING canvas (operator played it); a
  // born-paused canvas keeps every notice pending by law.
  if (over.canvasName !== undefined) {
    await harness.playCanvas(over.canvasName);
  }
  const advance = async (ms: number) => {
    await vi.advanceTimersByTimeAsync(ms);
  };
  const flush = async () => {
    // Model timers (setTimeout) -> observer feed; xterm parse timer -> snapshot.
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(1);
    // Effect scheduler continuations -> REAL event loop turns.
    await realTick();
    await realTick();
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  };
  // Canonicality gate: boot paint must evaluate idle through the REAL observer.
  await flush();
  const loop = harness.loop!;
  expect(loop.runtime.getState(loop.bindingId)).toBe("idle");
  expect(loop.runtime.isSeatIdle(loop.bindingId)).toBe(true);
  expect(loop.observer.snapshotNow().signals.title).toBe("✳ Claude Code");
  return { harness, loop, advance, flush, root };
};

const docWith = (nodes: CanvasDoc["nodes"], edges: CanvasDoc["edges"]): CanvasDoc => ({
  nodes,
  edges,
});

const seatTasksDocs = {
  empty: (seatId: string, tasksId: string, bindingId?: string): CanvasDoc =>
    docWith([seatNode(seatId, bindingId), kindNode(tasksId, "task")], []),
  linked: (seatId: string, tasksId: string, bindingId?: string): CanvasDoc =>
    docWith([seatNode(seatId, bindingId), kindNode(tasksId, "task")], [edge("e1", seatId, tasksId)]),
};

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// PROTO-1 / PROTO-4 / PROTO-9 — notify generation over real commits
// ---------------------------------------------------------------------------

describe("PROTO-1/4/9 — edge-map notice generation over real commits", () => {
  it("PROTO-1: A->B->C inside one flush window => exactly ONE notice (today: one per commit)", async () => {
    const root = makeProtoRoot("proto1");
    const harness = new ProtoHarness({ root });
    await harness.start();
    await harness.setStationCommandCenter();
    try {
      const NAME = "proto1";
      const doc0 = seatTasksDocs.empty("A", "B");
      const doc1 = seatTasksDocs.linked("A", "B"); // A->B
      const doc2 = docWith(
        [seatNode("A"), kindNode("B", "task"), kindNode("C", "task")],
        [edge("e1", "A", "B"), edge("e2", "A", "C")], // A->B->C
      );
      await harness.writeDoc(NAME, doc0);
      const mid = (await harness.readDoc(NAME))!;
      // Commit 1 (A->B) and commit 2 (A->C) land in the same flush window.
      await harness.writeDoc(NAME, doc1);
      const after1 = (await harness.readDoc(NAME))!;
      await harness.writeDoc(NAME, doc2);
      const after2 = (await harness.readDoc(NAME))!;
      await harness.notifyEdgeMap(NAME, mid, after1);
      await harness.notifyEdgeMap(NAME, after1, after2);
      await harness.settle(100);

      const notices = await harness.pendingEdgeNotices(NAME, "A");
      // ACTUAL today: one notice per commit (no coalescing) => 2.
      // PRODUCT LAW: one flush window => one net-diff notice (added B, C).
      expect(notices.length).toBe(1);
      const all = notices.map((n) => n.message.parts.map((p) => ("text" in p ? p.text : "")).join(" "));
      expect(all.join(" ")).toContain("B");
      expect(all.join(" ")).toContain("C");
    } finally {
      await harness.dispose();
    }
  });

  it("PROTO-4: A->B->A nets to zero => ZERO notices (today: two)", async () => {
    const root = makeProtoRoot("proto4");
    const harness = new ProtoHarness({ root });
    await harness.start();
    await harness.setStationCommandCenter();
    try {
      const NAME = "proto4";
      const doc0 = seatTasksDocs.empty("A", "B");
      const doc1 = seatTasksDocs.linked("A", "B"); // A->B
      const doc2 = seatTasksDocs.empty("A", "B");  // A->B->A (edge removed)
      await harness.writeDoc(NAME, doc0);
      const mid = (await harness.readDoc(NAME))!;
      await harness.writeDoc(NAME, doc1);
      const after1 = (await harness.readDoc(NAME))!;
      await harness.writeDoc(NAME, doc2);
      const after2 = (await harness.readDoc(NAME))!;
      await harness.notifyEdgeMap(NAME, mid, after1);
      await harness.notifyEdgeMap(NAME, after1, after2);
      await harness.settle(100);

      const notices = await harness.pendingEdgeNotices(NAME, "A");
      // ACTUAL today: 2 notices (add + remove) even though the grant set
      // netted to zero. PRODUCT LAW: no-op round-trip => 0 notices.
      expect(notices.length).toBe(0);
    } finally {
      await harness.dispose();
    }
  });

  it("PROTO-9: agent<->agent edge add => exactly ONE notice per seat, each naming only the peer", async () => {
    const root = makeProtoRoot("proto9");
    const harness = new ProtoHarness({ root });
    await harness.start();
    await harness.setStationCommandCenter();
    try {
      const NAME = "proto9";
      const doc0 = docWith([seatNode("A"), seatNode("B")], []);
      const doc1 = docWith([seatNode("A"), seatNode("B")], [edge("e1", "A", "B")]);
      await harness.writeDoc(NAME, doc0);
      const mid = (await harness.readDoc(NAME))!;
      await harness.writeDoc(NAME, doc1);
      const after = (await harness.readDoc(NAME))!;
      await harness.notifyEdgeMap(NAME, mid, after);
      await harness.settle(100);

      const all = await harness.pendingEdgeNotices(NAME);
      // Total across the canvas: one per endpoint seat.
      expect(all.length).toBe(2);
      const seatA = all.filter((n) => n.nodeId === "A");
      const seatB = all.filter((n) => n.nodeId === "B");
      expect(seatA.length).toBe(1);
      expect(seatB.length).toBe(1);
      const textA = seatA[0]!.message.parts.map((p) => ("text" in p ? p.text : "")).join(" ");
      const textB = seatB[0]!.message.parts.map((p) => ("text" in p ? p.text : "")).join(" ");
      // Each seat's notice names only the peer it gained — never itself.
      expect(textA).toContain("`B`");
      expect(textA).not.toContain("`A`");
      expect(textB).toContain("`A`");
      expect(textB).not.toContain("`B`");
    } finally {
      await harness.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// PROTO-2 — delivery re-drive loop
// ---------------------------------------------------------------------------

describe("PROTO-2 — rejected calls are not accepted physical pastes", () => {
  it("retries a refused write, delivers once when available, and never repeats accepted mail", async () => {
    const { harness, loop, advance, flush } = await setupLoop({ wedged: true, canvasName: "proto2" });
    try {
      const NAME = "proto2";
      const doc0 = seatTasksDocs.empty("A", "B", "seat-b1");
      const doc1 = seatTasksDocs.linked("A", "B", "seat-b1");
      await harness.writeDoc(NAME, doc0);
      const mid = (await harness.readDoc(NAME))!;
      await harness.writeDoc(NAME, doc1);
      const after = (await harness.readDoc(NAME))!;

      // The notice lands while the PTY is wedged: the drive's paste write is
      // refused (write-failed) and the message stays pending, unreceipted.
      await harness.notifyEdgeMap(NAME, mid, after);
      await advance(20);
      await flush();
      expect(loop.pasteWrites().length).toBe(1); // one refused attempt
      expect((await harness.pendingEdgeNotices(NAME, "A")).length).toBe(1);
      const notice = (await harness.pendingEdgeNotices(NAME, "A"))[0]!;
      expect(loop.deliveredPastePayloads()).toEqual([]);
      expect(loop.drive.pasteWriteCount(loop.bindingId)).toBe(0);
      expect(await harness.hasReceipt(NAME, "A", notice.message.messageId)).toBe(false);

      // Three real working->idle cycles can retry a rejection before bytes.
      // The writer logs those calls, but the fake PTY accepts no envelope and
      // the durable source remains pending. Failed calls are not paste proof.
      const attemptsPerIdle: number[] = [];
      for (let i = 0; i < 3; i += 1) {
        const before = loop.pasteWrites().length;
        await loop.runTurn(advance, flush);
        attemptsPerIdle.push(loop.pasteWrites().length - before);
        expect(loop.deliveredPastePayloads()).toEqual([]);
        expect(loop.drive.pasteWriteCount(loop.bindingId)).toBe(0);
        expect(await harness.hasReceipt(NAME, "A", notice.message.messageId)).toBe(false);
      }
      await advance(20);
      await flush();

      expect(attemptsPerIdle).toEqual([1, 1, 1]);
      expect(loop.pasteWrites().every((write) => write.refused)).toBe(true);
      expect((await harness.pendingEdgeNotices(NAME, "A")).length).toBe(1);
      expect(await harness.hasReceipt(NAME, "A", notice.message.messageId)).toBe(false);

      // A no-write refusal must not park the message forever. Once the PTY
      // accepts writes, the next idle submits the same durable row once.
      loop.wedged = false;
      await loop.runTurn(advance, flush);
      await advance(2_500);
      await flush();
      expect(loop.deliveredPastePayloads()).toHaveLength(1);
      expect(loop.drive.pasteWriteCount(loop.bindingId)).toBe(1);
      expect(await harness.hasReceipt(NAME, "A", notice.message.messageId)).toBe(true);
      // The helper enumerates edge notices even after delivery; the durable
      // mailbox row stays present and its projection now carries the receipt.
      expect(await harness.pendingEdgeNotices(NAME, "A")).toMatchObject([{
        message: { messageId: notice.message.messageId, metadata: { deliveredAt: expect.any(Number) } },
      }]);

      const callsAfterReceipt = loop.pasteWrites().length;
      for (let i = 0; i < 3; i += 1) await loop.runTurn(advance, flush);
      expect(loop.pasteWrites()).toHaveLength(callsAfterReceipt);
      expect(loop.deliveredPastePayloads()).toHaveLength(1);
      expect(loop.drive.pasteWriteCount(loop.bindingId)).toBe(1);
    } finally {
      await harness.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// PROTO-3 — stale notice (inject-vs-admission mismatch)
// ---------------------------------------------------------------------------

describe("PROTO-3 — stale 'Added' notice must not be pasted after the edge is gone", () => {
  it("notice composed at T1 (edge present), edge removed at T2, delivered at T3 => today the stale Added payload is pasted", async () => {
    const { harness, loop, advance, flush } = await setupLoop({
      wedged: true,
      wireChangeListener: true,
      canvasName: "proto3",
    });
    try {
      const NAME = "proto3";
      const doc0 = seatTasksDocs.empty("A", "B", "seat-b1");
      const doc1 = seatTasksDocs.linked("A", "B", "seat-b1");
      const doc2 = seatTasksDocs.empty("A", "B", "seat-b1");
      // T1: edge add — the real change stream appends the Added notice.
      await harness.writeDoc(NAME, doc0);
      await harness.writeDoc(NAME, doc1);
      await advance(30);
      await flush();
      // T2: edge remove — the real change stream appends the Removed notice.
      await harness.writeDoc(NAME, doc2);
      await advance(30);
      await flush();
      const pending = await harness.pendingEdgeNotices(NAME, "A");
      expect(pending.length).toBe(2);
      const first = pending[0]!.message.parts.map((p) => ("text" in p ? p.text : "")).join(" ");
      expect(first).toContain("Added");

      // T3: seat idles (real turn), delivery un-wedges: both notices deliver
      // in mailbox order. The Added notice is STALE — its edge was removed at
      // T2 — and attemptOne never re-validates against the current map.
      loop.wedged = false;
      await loop.runTurn(advance, flush);
      await advance(2_600);
      await flush();
      // Delivered (un-refused) pastes only — the wedged attempts earlier were
      // refused at the PTY boundary and never reached the composer.
      const pastes = loop.deliveredPastePayloads();
      expect(pastes.length).toBeGreaterThanOrEqual(1);
      // ACTUAL today: the stale "Added" payload is pasted verbatim — the
      // first delivered paste names the removed target `B` (documented).
      expect(pastes[0]).toContain("`B`");
      // PRODUCT LAW: delivery must refuse/supersede a notice whose addedIds
      // are no longer connected — no paste may claim Added for a removed edge.
      for (const paste of pastes) {
        expect(paste).not.toContain("Added");
      }
    } finally {
      await harness.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// PROTO-5 — payload flattening
// ---------------------------------------------------------------------------

describe("PROTO-5 — delivery paste is one compact line with ids only", () => {
  it("the whole edge contract is flattened into ONE giant line today (expected: compact one-liner, ids only)", async () => {
    const { harness, loop, advance, flush } = await setupLoop({ wedged: false, canvasName: "proto5" });
    try {
      const NAME = "proto5";
      const doc0 = seatTasksDocs.empty("A", "B", "seat-b1");
      const doc1 = seatTasksDocs.linked("A", "B", "seat-b1");
      await harness.writeDoc(NAME, doc0);
      const mid = (await harness.readDoc(NAME))!;
      await harness.writeDoc(NAME, doc1);
      const after = (await harness.readDoc(NAME))!;
      await harness.notifyEdgeMap(NAME, mid, after);
      await advance(200);
      await flush();

      const pastes = loop.pastePayloads();
      expect(pastes.length).toBe(1);
      const payload = pastes[0]!;
      // The delivery path collapses every newline (sanitizeDeliveryLine) —
      // the paste is ONE line. (Passes today; documents the flattening.)
      expect(payload).not.toMatch(/\n/);
      // ACTUAL today (pre-fix): the whole contract table was inline in that
      // one line — documented as a comment, not an assertion (a payload cannot
      // simultaneously contain and not contain "Edge contract"; the law is the
      // not.toContain pair below).
      // PRODUCT LAW: the paste is a compact orient one-liner — ids only,
      // no contract table, no command recipes (they live in onboard output).
      expect(payload).not.toContain("Edge contract");
      expect(payload).not.toContain("| intent | command |");
      expect(payload.length).toBeLessThan(200);
      expect(payload).toContain("B");
    } finally {
      await harness.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// PROTO-6 — receipt on unproven submit
// ---------------------------------------------------------------------------

describe("PROTO-6 — no durable receipt without marker-confirmed submit", () => {
  it.skip(
    "delivery receipts a drive-true that was resolved by false-working while a chip is visible",
    async () => {
      // SKIPPED — cannot be built honestly on the current tree:
      //
      // The receipt-on-unproven-submit hole requires the delivery's own
      // paste+CR to leave a chip in the composer and a false-working paint to
      // resolve awaitTurnStart (drive-law D2). But composeMessageDeliveryPayload
      // flattens EVERY delivery payload to one line (shared/message-delivery.ts
      // sanitizeDeliveryLine), and the scripted Claude TUI only chips on
      // MULTI-line pastes (K3) — so a delivery paste can never chip today and
      // the receipt is always backed by a real submit. The D2 drive-level
      // defect (writePrompt resolves true while its own multiline chip is
      // pending) is reproduced in scenarios/drive-law.test.ts; the delivery
      // layer's blind stamp-on-transport-true becomes reachable only when a
      // delivery payload can chip (e.g., if PROTO-5's one-line collapse is
      // replaced by compact multi-line notices). Enabling this test without
      // that precondition would require faking the drive's true — encoding
      // the buggy behavior as the transport, which the anti-hacking bar forbids.
      const { harness, loop, advance, flush } = await setupLoop({
        tui: { secondCrSubmits: false },
      });
      try {
        const NAME = "proto6";
        const doc0 = seatTasksDocs.empty("A", "B");
        const doc1 = seatTasksDocs.linked("A", "B");
        await harness.writeDoc(NAME, doc0);
        const mid = (await harness.readDoc(NAME))!;
        await harness.writeDoc(NAME, doc1);
        const after = (await harness.readDoc(NAME))!;
        await harness.notifyEdgeMap(NAME, mid, after);
        await advance(200);
        await flush();
        // With a one-line delivery paste the model submits and the receipt is
        // backed by a real working turn — the law holds today.
        const notice = (await harness.pendingEdgeNotices(NAME, "A"))[0]!;
        expect(
          await harness.hasReceipt(NAME, "A", notice.message.messageId),
        ).toBe(true);
        expect(loop.tui.chipPending()).toBe(false);
      } finally {
        await harness.dispose();
      }
    },
  );
});

// ---------------------------------------------------------------------------
// PROTO-8 — paused seat surfaces paused:true + next_step
// ---------------------------------------------------------------------------

const call = (socketPath: string, body: unknown): Promise<{
  readonly ok: boolean;
  readonly data?: Record<string, unknown>;
  readonly error?: { readonly type: string; readonly details?: { readonly next_step?: string } };
}> =>
  new Promise((resolve, reject) => {
    const socket = createConnection({ path: socketPath });
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("timeout"));
    }, 5_000);
    socket.on("connect", () => {
      socket.write(encodeWorkFrame(body));
    });
    socket.on("data", (chunk: Buffer | string) => {
      const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      buf = Buffer.concat([buf, part]);
      const nl = buf.indexOf(0x0a);
      if (nl < 0) return;
      clearTimeout(timer);
      const line = buf.subarray(0, nl).toString("utf8");
      socket.destroy();
      resolve(JSON.parse(line));
    });
    socket.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });

const controlSeedDoc = (): CanvasDoc => docWith(
  [
    seatNode("agent"),
    kindNode("tasks", "task"),
    kindNode("req", "requests"),
    kindNode("artifacts", "artifacts"),
  ],
  [
    edge("e1", "agent", "tasks"),
    edge("e2", "agent", "req"),
    edge("e3", "agent", "artifacts"),
  ],
);

describe("PROTO-8 — paused seat reports paused:true + next_step", () => {
  let harness: ProtoHarness;
  let server: WorkControlServer;
  const roots: string[] = [];

  beforeAll(async () => {
    resetSeatBlocks();
    const root = await mkdtemp(join(tmpdir(), "vellum-proto8-"));
    roots.push(root);
    const canvasesDir = join(root, "canvases");
    const workHome = join(root, "work");
    mkdirSync(canvasesDir, { recursive: true });
    mkdirSync(workHome, { recursive: true });
    process.env.JUNTO_CANVASES_DIR = canvasesDir;
    process.env.JUNTO_WORK_HOME = workHome;
    harness = new ProtoHarness({ root });
    await harness.start();
    await harness.setStationCommandCenter();
    await harness.writeDoc("work-cli", controlSeedDoc());
    const processMap = makeProcessIdentityMap();
    processMap.bind(process.pid, { agentKey: "local:agent" });
    server = await startWorkControlServer({
      version: "test",
      workHome,
      home: root,
      processMap,
      readPeerPid: () => process.pid,
      run: (effect) => harness.runtime.runPromise(effect as never),
      authoringGate: createMainAuthoringGate(),
    });
  });

  afterAll(async () => {
    if (server) await server.close();
    if (harness) await harness.dispose();
    for (const root of roots) {
      try {
        const { rm } = await import("node:fs/promises");
        await rm(root, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
  });

  it("capabilities for a born-paused canvas lacks paused (expected paused:true + next_step)", async () => {
    // The canvas was never played — the factory pause law says it is paused.
    const state = harness.pause.stateFor("work-cli");
    expect(state.playing).toBe(false);
    const res = await call(server.socketPath, {
      token: readFileSync(server.tokenPath, "utf8").trim(),
      op: "capabilities",
    });
    expect(res.ok).toBe(true);
    // PRODUCT LAW: a paused seat must surface paused:true + next_step so the
    // agent can distinguish pause from a broken grant. ACTUAL today: absent.
    expect(res.data?.paused).toBe(true);
    expect(res.data?.next_step).toEqual(expect.stringContaining("resume"));
  });

  it("onboard for a paused seat lacks paused (expected paused:true + next_step)", async () => {
    const res = await call(server.socketPath, {
      token: readFileSync(server.tokenPath, "utf8").trim(),
      op: "onboard",
    });
    expect(res.ok).toBe(true);
    expect(res.data?.paused).toBe(true);
    expect(res.data?.next_step).toEqual(expect.stringContaining("resume"));
  });

  it("gate sanity: a paused seat still refuses mutating ops with a Paused error (works today)", async () => {
    const res = await call(server.socketPath, {
      token: readFileSync(server.tokenPath, "utf8").trim(),
      op: "tasks.create",
      args: { target: "tasks", brief: "do the thing", metadata: { details: "sanity gate" } },
    });
    expect(res.ok).toBe(false);
    expect(res.error?.type).toBe("Paused");
    expect(res.error?.details?.next_step).toContain("resume");
  });

  it("node-paused inside a playing canvas also lacks paused in capabilities", async () => {
    await harness.runtime.runPromise(harness.pause.setPlaying("work-cli", true));
    await harness.runtime.runPromise(
      harness.pause.setScopePaused("work-cli", { kind: "node", id: "agent" }, true),
    );
    const res = await call(server.socketPath, {
      token: readFileSync(server.tokenPath, "utf8").trim(),
      op: "capabilities",
    });
    expect(res.ok).toBe(true);
    expect(res.data?.paused).toBe(true);
    expect(res.data?.next_step).toEqual(expect.stringContaining("resume"));
  });
});
