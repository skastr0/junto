/**
 * Crew waits + observe — bounded seat waits and read-only terminal
 * observation over a messages edge [fake-tui].
 *
 * seat.wait watches the real seat state machine; seat.read returns a
 * bounded window of the settled observer grid. Both are read authority:
 * the fake-tui seats never receive input through these ops, and the
 * ops carry no write/resize/signal path by construction.
 *
 * Laws covered:
 *   1. wait resolves on the first matching state (idle, working,
 *      attention, gone) with generation+epoch evidence;
 *   2. every wait is bounded — Timeout carries from/to and retryable;
 *   3. read returns a settled grid window with seq/generation and never
 *      concatenates generations;
 *   4. follow is bounded — it returns when the cursor advances, the
 *      duration elapses, or the seat exits, and says which;
 *   5. authority is the edge: no messages edge (or a mask that drops the
 *      port) is ScopeError, and removing the edge mid-follow ends it.
 */
import { expect, launchVellum, test } from "../harness/launch";
import {
  crewOccupySeat,
  crewPlayFactory,
  crewMutateCanvas,
  crewSeat,
  crewSeatNode,
  crewDoc,
  crewMessagesEdge,
  crewTasksNode,
  crewWorksEdge,
  installCrewSeatHarness,
  type WorkEnvelope,
} from "../harness/crew-fixture";
import { taskItem } from "../harness/sandbox";

const CANVAS = "crew-wait";
const A = "seat-a";
const B = "seat-b";
const SINK = "sink";

const seatA = crewSeatNode({ id: A, x: 40, y: 40 });
const seatB = crewSeatNode({ id: B, x: 360, y: 40 });
const sink = crewTasksNode({
  id: SINK,
  x: 640,
  y: 40,
  items: [taskItem("task-1", "watch me finish")],
});
const waitDoc = crewDoc(
  [seatA, seatB, sink],
  [
    crewMessagesEdge("e-ab", A, B, [seatA, seatB, sink]),
    crewWorksEdge("w-sink-a", SINK, A, [seatA, seatB, sink]),
    crewWorksEdge("w-sink-b", SINK, B, [seatA, seatB, sink]),
  ],
);

const opData = (env: WorkEnvelope): Record<string, unknown> => {
  expect(env.ok, JSON.stringify(env)).toBe(true);
  if (!env.ok) throw new Error("unreachable");
  return (env.data ?? {}) as Record<string, unknown>;
};

const launch = () =>
  launchVellum({
    seedCanvases: { [CANVAS]: waitDoc },
    afterSeed: installCrewSeatHarness,
  });

const boot = async (vellum: Awaited<ReturnType<typeof launch>>) => {
  const { page, sandbox } = vellum;
  await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
  await crewPlayFactory(page);
  const a = crewSeat(sandbox, CANVAS, A);
  const b = crewSeat(sandbox, CANVAS, B);
  await crewOccupySeat(page, CANVAS, seatA, a);
  await crewOccupySeat(page, CANVAS, seatB, b);
  return { page, sandbox, a, b };
};

test("crew wait [fake-tui]: resolves on first matching state for idle/working/gone", async () => {
  test.setTimeout(300_000);
  const vellum = await launch();
  try {
    const { a, b } = await boot(vellum);

    // Already idle — resolves immediately with evidence fields.
    const idle = await a.op("seat.wait", { target: B, until: "idle", timeoutMs: 20_000 }, { awaitMs: 45_000, timeoutMs: 45_000 });
    const idleData = opData(idle) as {
      target: string; state: string; generation: string; epoch: string;
    };
    expect(idleData.state).toBe("idle");
    expect(idleData.target).toBe(B);
    expect(idleData.generation.length).toBeGreaterThan(0);

    // Flip to working, then wait for the transition — seat.wait must see
    // the same state machine the drive sees.
    await b.control({ screen: { mode: "working" } });
    const working = await a.op("seat.wait", { target: B, until: "working", timeoutMs: 30_000 }, { awaitMs: 45_000, timeoutMs: 45_000 });
    expect((opData(working) as { state: string }).state).toBe("working");

    // Exit the fake — the seat goes gone and the wait sees it. A wait that
    // starts after the exit resolves from the retired-generation tombstone:
    // state gone, reason generation_exited, the retired generation+epoch as
    // witness.
    await b.control({ exit: 0 });
    const gone = await a.op("seat.wait", { target: B, until: "gone", timeoutMs: 30_000 }, { awaitMs: 45_000, timeoutMs: 45_000 });
    const goneData = opData(gone) as {
      state: string; reason?: string; confidence?: string;
      generation?: string; epoch?: string;
    };
    expect(goneData.state).toBe("gone");
    expect(goneData.reason).toBe("generation_exited");
    expect(goneData.confidence).toBe("high");
    expect(goneData.generation?.length).toBeGreaterThan(0);
  } finally {
    await vellum.close();
  }
});

test("crew wait [fake-tui]: bounded timeout returns Timeout with from/to", async () => {
  test.setTimeout(180_000);
  const vellum = await launch();
  try {
    const { a } = await boot(vellum);
    // B never reaches attention inside 3s — the wait must bound itself.
    const res = await a.op("seat.wait", {
      target: B, until: "attention", timeoutMs: 3_000,
    }, { awaitMs: 30_000 });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.type).toBe("Timeout");
    expect(res.error.details?.target).toBe(B);
    expect(res.error.details?.to).toBe("attention");
    expect(res.error.details?.retryable).toBe(true);
  } finally {
    await vellum.close();
  }
});

test("crew wait [fake-tui]: attention resolves while a peer holds a prompt form", async () => {
  test.setTimeout(240_000);
  const vellum = await launch();
  try {
    const { a, b } = await boot(vellum);
    await b.control({ screen: { mode: "attention" } });
    const res = await a.op("seat.wait", {
      target: B, until: "attention", timeoutMs: 30_000,
    }, { awaitMs: 45_000, timeoutMs: 45_000 });
    const data = opData(res) as { state: string; confidence: string };
    expect(data.state).toBe("attention");
  } finally {
    await vellum.close();
  }
});

test("crew observe [fake-tui]: read returns the settled grid, never write authority", async () => {
  test.setTimeout(240_000);
  const vellum = await launch();
  try {
    const { a, b } = await boot(vellum);
    await b.print("unique-transcript-marker-7f3a", "second line of output");
    // Let the grid settle.
    await new Promise((resolve) => setTimeout(resolve, 1_500));

    const res = await a.op("seat.read", { target: B, lines: 50 });
    const data = opData(res) as {
      text: string; seq: number; generation: string; epoch: string;
      state: string; truncated: boolean; stopped: string; replaced: boolean;
    };
    expect(data.text).toContain("unique-transcript-marker-7f3a");
    expect(data.text).toContain("second line of output");
    expect(data.generation.length).toBeGreaterThan(0);
    expect(data.stopped).toBe("not-following");
    expect(data.replaced).toBe(false);

    // Read authority grants nothing else: the peer PTY sees zero bytes
    // attributable to the read (stdin log stays free of read traffic).
    const stdin = await b.stdinLog();
    expect(stdin).not.toContain("unique-transcript-marker-7f3a");
  } finally {
    await vellum.close();
  }
});

test("crew observe [fake-tui]: bounded follow returns on advance, duration, or exit", async () => {
  test.setTimeout(300_000);
  const vellum = await launch();
  try {
    const { a, b } = await boot(vellum);

    // Baseline cursor.
    const first = await a.op("seat.read", { target: B, lines: 20 });
    const base = opData(first) as { seq: number; generation: string };

    // Follow that advances: print mid-follow and the read returns early
    // with the new content.
    const followPromise = a.op("seat.read", {
      target: B, since: base.seq, sinceGeneration: base.generation,
      follow: true, maxSeconds: 60,
    }, { awaitMs: 90_000, timeoutMs: 90_000 });
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    await b.print("follow-advance-marker-9c1d");
    const followed = await followPromise;
    const followedData = opData(followed) as {
      stopped: string; text: string; seq: number;
    };
    expect(followedData.stopped).toBe("advanced");
    expect(followedData.text).toContain("follow-advance-marker-9c1d");
    expect(followedData.seq).toBeGreaterThan(base.seq);

    // Follow that elapses: nothing new prints, the bound is honored.
    const timedOut = await a.op("seat.read", {
      target: B, follow: true, maxSeconds: 4,
    }, { awaitMs: 60_000, timeoutMs: 60_000 });
    const timedOutData = opData(timedOut) as { stopped: string };
    expect(timedOutData.stopped).toBe("duration");

    // Follow whose seat exits mid-stream: returns on the exit, not the
    // deadline — stopped gone, generation_exited, the retired generation's
    // last settled window as evidence.
    const exitFollow = a.op("seat.read", {
      target: B, follow: true, maxSeconds: 60,
    }, { awaitMs: 45_000, timeoutMs: 45_000 });
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    await b.control({ exit: 0 });
    const exited = await exitFollow;
    const exitedData = opData(exited) as {
      stopped: string; state: string; reason?: string; confidence?: string;
    };
    expect(exitedData.stopped).toBe("gone");
    expect(exitedData.state).toBe("gone");
    expect(exitedData.reason).toBe("generation_exited");
    expect(exitedData.confidence).toBe("high");
  } finally {
    await vellum.close();
  }
});

test("crew wait [fake-tui]: masked edge refuses wait and read as ScopeError", async () => {
  test.setTimeout(180_000);
  const maskedDoc = crewDoc(
    [seatA, seatB, sink],
    [
      // Mail flows, but observe and wait are masked off the edge.
      crewMessagesEdge("e-ab", A, B, [seatA, seatB, sink], [
        "msg.list", "msg.send", "msg.prompt",
      ]),
      crewWorksEdge("w-sink-a", SINK, A, [seatA, seatB, sink]),
    ],
  );
  const vellum = await launchVellum({
    seedCanvases: { [CANVAS]: maskedDoc },
    afterSeed: installCrewSeatHarness,
  });
  try {
    const { a } = await boot(vellum);

    const wait = await a.op("seat.wait", { target: B, until: "idle", timeoutMs: 5_000 });
    expect(wait.ok).toBe(false);
    if (!wait.ok) expect(wait.error.type).toBe("ScopeError");

    const read = await a.op("seat.read", { target: B, lines: 10 });
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.error.type).toBe("ScopeError");
  } finally {
    await vellum.close();
  }
});

test("crew wait [fake-tui]: removing the edge ends authority mid-scenario", async () => {
  test.setTimeout(240_000);
  const vellum = await launch();
  try {
    const { page, a } = await boot(vellum);

    // Authority while the edge exists.
    const before = await a.op("seat.wait", { target: B, until: "idle", timeoutMs: 15_000 });
    expect(before.ok).toBe(true);

    await crewMutateCanvas(page, CANVAS, (doc) => ({
      ...doc,
      edges: doc.edges.filter((edge) => edge.id !== "e-ab"),
    }));

    // Same call now fails closed — authority is re-derived per op.
    const after = await a.op("seat.wait", { target: B, until: "idle", timeoutMs: 5_000 });
    expect(after.ok).toBe(false);
    if (!after.ok) expect(after.error.type).toBe("ScopeError");

    const read = await a.op("seat.read", { target: B, lines: 10 });
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.error.type).toBe("ScopeError");
  } finally {
    await vellum.close();
  }
});

test("crew wait [fake-tui]: tasks.wait observes a peer task reaching completed", async () => {
  test.setTimeout(300_000);
  const vellum = await launch();
  try {
    const { a, b } = await boot(vellum);

    // B waits on the task A is about to close; A claims and completes it.
    const waitPromise = b.op("tasks.wait", {
      target: SINK, taskId: "task-1", until: "completed", timeoutMs: 120_000,
    }, { awaitMs: 140_000, timeoutMs: 140_000 });

    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const claim = await a.op("tasks.claim", { target: SINK, task: "task-1" });
    expect(claim.ok, JSON.stringify(claim)).toBe(true);
    const done = await a.op("tasks.update", {
      target: SINK, task: "task-1", state: "completed",
      completionEvidence: { artifacts: [] },
    });
    expect(done.ok, JSON.stringify(done)).toBe(true);

    const waited = await waitPromise;
    const data = opData(waited) as { taskId: string; state: string; epoch: number };
    expect(data.taskId).toBe("task-1");
    expect(data.state).toBe("completed");
    expect(typeof data.epoch).toBe("number");
  } finally {
    await vellum.close();
  }
});
