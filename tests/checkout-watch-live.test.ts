import { Effect } from "effect";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { ActorSeatId } from "../src/shared/actor-seat";
import type { CanvasNode } from "../src/shared/canvas";
import type { Task, TasksContract } from "../src/shared/work-model";
import type { ActorRef } from "../src/shared/work-reference";
import { runCli } from "../src/main/junto/adapters/exec";
import type { GitProbe } from "../src/main/junto/work/checkout-watch";
import {
  CrewRepositoryError,
  type CheckoutObservationInput,
  type CrewRepositoryShape,
} from "../src/main/junto/work/crew-repository";
import {
  CHECKOUT_WATCH_DEFAULT_POLL_MS,
  CHECKOUT_WATCH_MAX_RETAINED,
  GIT_PROBE_TIMEOUT_MS,
  checkoutKeyFromPath,
  claimContextFrom,
  gitProbeOverRunCli,
  makeCheckoutWatchLive,
  makeCheckoutWatchSupervisor,
  type CheckoutWatchClaim,
  type CheckoutWatchContext,
  type CheckoutReceiptMailInput,
} from "../src/main/junto/work/checkout-watch-live";

// Focused seam tests for the production checkout watch: proven claim context,
// canonical checkout identity, the read-only git probe, and the live
// lifecycle/coalescing rules the pure watcher deliberately does not own.

const SEAT_A = `seat_${"a".repeat(64)}` as ActorSeatId;
const SEAT_B = `seat_${"b".repeat(64)}` as ActorSeatId;
const CANVAS = "board";
const CHECKOUT = "/co-a";

const runEffect = <A>(effect: Effect.Effect<A, never, never>): Promise<A> =>
  Effect.runPromise(effect);

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

const agentNode = (id: string, host?: string): CanvasNode => ({
  id,
  type: "text",
  text: id,
  x: 0,
  y: 0,
  width: 100,
  height: 80,
  ether: {
    entity: { kind: "agent", name: `local:${id}` },
    terminal: { bindingId: `bind-${id}`, harness: "claude" },
    ...(host !== undefined ? { host } : {}),
  },
});

const task = (
  id: string,
  state: Task["state"],
  claimedBy?: ActorSeatId,
): Task => ({
  id,
  state,
  history: [],
  ...(claimedBy !== undefined ? { claimedBy } : {}),
});

const actorRef = (seatId: ActorSeatId, nodeId: string): ActorRef => ({
  seatId,
  canvasName: CANVAS,
  nodeId,
});

const OPERATOR_BOARD: TasksContract = { incoming: { admission: "operator" } };

const facts = (input: {
  tasks: ReadonlyArray<Task>;
  nodes: ReadonlyArray<CanvasNode>;
  actorRefs: ReadonlyArray<ActorRef>;
  contract?: TasksContract;
  board?: string;
  checkoutFor?: (nodeId: string) => string | undefined;
  processFor?: (
    nodeId: string,
  ) => { readonly generation: string; readonly harness: string } | undefined;
}) => ({
  canvasName: CANVAS,
  boards: [
    {
      nodeId: input.board ?? "sink",
      tasks: input.tasks,
      contract: input.contract,
    },
  ],
  actorRefs: input.actorRefs,
  nodes: input.nodes,
  checkoutKeyFor: input.checkoutFor ?? ((nodeId: string) => `/co-${nodeId}`),
  observedProcessFor: input.processFor ?? (() => ({ generation: "gen-1", harness: "claude" })),
});

type ProbeHarness = {
  readonly probe: GitProbe;
  readonly heads: Map<string, string>;
  readonly ranges: Map<string, ReadonlyArray<string>>;
  readonly calls: string[];
  readonly throws: Set<string>;
  readonly held: Array<{ readonly worktree: string; readonly release: () => void }>;
  holdNextHead: () => void;
};

const makeProbe = (): ProbeHarness => {
  const heads = new Map<string, string>();
  const ranges = new Map<string, ReadonlyArray<string>>();
  const calls: string[] = [];
  const throws = new Set<string>();
  const held: Array<{ worktree: string; release: () => void }> = [];
  let holdNext = false;
  return {
    heads,
    ranges,
    calls,
    throws,
    held,
    holdNextHead: () => {
      holdNext = true;
    },
    probe: {
      async head(worktree) {
        calls.push(`head:${worktree}`);
        if (holdNext) {
          holdNext = false;
          await new Promise<void>((resolve) => {
            held.push({ worktree, release: resolve });
          });
        }
        if (throws.has(`head:${worktree}`)) throw new Error("head failed");
        const head = heads.get(worktree);
        return head === undefined ? undefined : { branch: "main", head };
      },
      async newCommits(worktree, from, to) {
        calls.push(`range:${worktree}:${from}..${to}`);
        if (throws.has(`range:${worktree}`)) throw new Error("rev-list failed");
        return ranges.get(`${worktree}\u0000${from}..${to}`) ?? [];
      },
    },
  };
};

type RepositoryHarness = {
  readonly repository: Pick<CrewRepositoryShape, "recordCheckoutObservation">;
  readonly calls: CheckoutObservationInput[];
  readonly preExisting: Set<string>;
  setFailing: (failing: boolean) => void;
};

const makeRepository = (): RepositoryHarness => {
  const calls: CheckoutObservationInput[] = [];
  const seen = new Set<string>();
  const preExisting = new Set<string>();
  let failing = false;
  return {
    calls,
    preExisting,
    setFailing: (next) => {
      failing = next;
    },
    repository: {
      recordCheckoutObservation: (input) =>
        Effect.suspend(() => {
          if (failing) {
            return Effect.fail(
              CrewRepositoryError.make({
                operation: "test.recordCheckoutObservation",
                message: "boom",
                cause: new Error("boom"),
              }),
            );
          }
          calls.push(input);
          const key = `${input.checkoutKey}\u0000${input.sha}`;
          if (seen.has(key) || preExisting.has(key)) return Effect.succeed(false);
          seen.add(key);
          return Effect.succeed(true);
        }),
    },
  };
};

type LiveHarness = {
  readonly live: ReturnType<typeof makeCheckoutWatchLive>;
  readonly probe: ProbeHarness;
  readonly repository: RepositoryHarness;
  readonly delivered: CheckoutReceiptMailInput[];
  readonly errors: unknown[];
  setClaims: (next: ReadonlyArray<CheckoutWatchClaim>) => void;
  setDeliveryFailing: (failing: boolean) => void;
  setAppendedPerGroup: (next: number) => void;
  readonly contextReads: () => number;
};

const claim = (
  seatId: ActorSeatId,
  taskId: string,
  nodeId: string,
  checkoutKey: string = CHECKOUT,
  provenance: { readonly generation?: string; readonly harness?: string } = {},
): CheckoutWatchContext["claims"][number] => ({
  seatId,
  taskId,
  taskNodeId: "sink",
  nodeId,
  checkoutKey,
  via: "claim-context",
  generation: provenance.generation ?? "gen-1",
  harness: provenance.harness ?? "claude",
});

const makeLive = (
  initial: ReadonlyArray<CheckoutWatchContext["claims"][number]>,
  options: { readonly pollMs?: number } = {},
): LiveHarness => {
  const probe = makeProbe();
  const repository = makeRepository();
  const delivered: CheckoutReceiptMailInput[] = [];
  const errors: unknown[] = [];
  let claims = initial;
  let contextReads = 0;
  let deliveryFailing = false;
  let appendedPerGroup = 1;
  const live = makeCheckoutWatchLive({
    canvasName: CANVAS,
    probe: probe.probe,
    repository: repository.repository,
    claims: () =>
      Effect.sync(() => {
        contextReads += 1;
        return claims;
      }),
    deliverReceipts: (input) =>
      Effect.suspend(() => {
        if (deliveryFailing) {
          return Effect.fail({ reason: "test", message: "delivery failed" });
        }
        delivered.push(input);
        return Effect.succeed(appendedPerGroup);
      }),
    run: runEffect,
    now: () => 1_700_000_000_000,
    pollMs: options.pollMs ?? CHECKOUT_WATCH_DEFAULT_POLL_MS,
    onError: (error) => {
      errors.push(error);
    },
  });
  return {
    live,
    probe,
    repository,
    delivered,
    errors,
    setClaims: (next) => {
      claims = next;
    },
    setDeliveryFailing: (failing) => {
      deliveryFailing = failing;
    },
    setAppendedPerGroup: (next) => {
      appendedPerGroup = next;
    },
    contextReads: () => contextReads,
  };
};

const waitFor = async (
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> => {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

// ---------------------------------------------------------------------------
// Proven claim context.
// ---------------------------------------------------------------------------

describe("claimContextFrom — proven context only", () => {
  it("binds a live claimed task to its process-bound local seat checkout", () => {
    const context = claimContextFrom(
      facts({
        tasks: [task("t1", "working", SEAT_A)],
        nodes: [agentNode("n1")],
        actorRefs: [actorRef(SEAT_A, "n1")],
        checkoutFor: () => CHECKOUT,
      }),
    );
    expect(context.canvasName).toBe(CANVAS);
    expect(context.claims).toEqual([
      {
        seatId: SEAT_A,
        taskId: "t1",
        taskNodeId: "sink",
        nodeId: "n1",
        checkoutKey: CHECKOUT,
        via: "claim-context",
        generation: "gen-1",
        harness: "claude",
      },
    ]);
  });

  it("a terminal task notifies nobody — no claim", () => {
    for (const state of ["completed", "canceled", "failed", "rejected", "archived"] as const) {
      const context = claimContextFrom(
        facts({
          tasks: [task("t1", state, SEAT_A)],
          nodes: [agentNode("n1")],
          actorRefs: [actorRef(SEAT_A, "n1")],
        }),
      );
      expect(context.claims).toEqual([]);
    }
  });

  it("an operator board has no seat claimant", () => {
    const context = claimContextFrom(
      facts({
        tasks: [task("t1", "working", SEAT_A)],
        nodes: [agentNode("n1")],
        actorRefs: [actorRef(SEAT_A, "n1")],
        contract: OPERATOR_BOARD,
      }),
    );
    expect(context.claims).toEqual([]);
  });

  it("a seat with no process binding on this canvas is never guessed", () => {
    const context = claimContextFrom(
      facts({
        tasks: [task("t1", "working", SEAT_A)],
        nodes: [agentNode("n1")],
        actorRefs: [],
      }),
    );
    expect(context.claims).toEqual([]);
  });

  it("a seat on another host is out of this iteration — no claim", () => {
    const context = claimContextFrom(
      facts({
        tasks: [task("t1", "working", SEAT_A)],
        nodes: [agentNode("n1", "remote-1")],
        actorRefs: [actorRef(SEAT_A, "n1")],
      }),
    );
    expect(context.claims).toEqual([]);
  });

  it("an unproven checkout yields no claim rather than a default path", () => {
    const context = claimContextFrom(
      facts({
        tasks: [task("t1", "working", SEAT_A)],
        nodes: [agentNode("n1")],
        actorRefs: [actorRef(SEAT_A, "n1")],
        checkoutFor: () => undefined,
      }),
    );
    expect(context.claims).toEqual([]);
  });

  it("a non-actor node has no delivery surface", () => {
    const sink: CanvasNode = {
      id: "n1",
      type: "text",
      text: "sink",
      x: 0,
      y: 0,
      width: 100,
      height: 80,
      ether: { entity: { kind: "task" }, tasks: { items: [] } },
    };
    const context = claimContextFrom(
      facts({
        tasks: [task("t1", "working", SEAT_A)],
        nodes: [sink],
        actorRefs: [actorRef(SEAT_A, "n1")],
      }),
    );
    expect(context.claims).toEqual([]);
  });

  it("an actorRef on another canvas is ignored", () => {
    const context = claimContextFrom(
      facts({
        tasks: [task("t1", "working", SEAT_A)],
        nodes: [agentNode("n1")],
        actorRefs: [{ seatId: SEAT_A, canvasName: "elsewhere", nodeId: "n1" }],
      }),
    );
    expect(context.claims).toEqual([]);
  });

  it("one seat's later board row wins for the same checkout", () => {
    const context = claimContextFrom(
      facts({
        tasks: [task("t1", "working", SEAT_A), task("t2", "working", SEAT_A)],
        nodes: [agentNode("n1")],
        actorRefs: [actorRef(SEAT_A, "n1")],
      }),
    );
    expect(context.claims).toHaveLength(1);
    expect(context.claims[0]?.taskId).toBe("t2");
  });

  it("two seats on two checkouts bind both, one actorRef per seat", () => {
    const context = claimContextFrom(
      facts({
        tasks: [task("t1", "working", SEAT_A), task("t2", "working", SEAT_B)],
        nodes: [agentNode("n1"), agentNode("n2")],
        actorRefs: [actorRef(SEAT_A, "n1"), actorRef(SEAT_B, "n2")],
      }),
    );
    expect(context.claims.map((entry) => entry.checkoutKey).sort()).toEqual([
      "/co-n1",
      "/co-n2",
    ]);
    expect(context.claims.map((entry) => entry.seatId).sort()).toEqual(
      [SEAT_A, SEAT_B].sort(),
    );
  });

  it("a seat with no observed process generation yields no claim", () => {
    const noProcess = claimContextFrom(
      facts({
        tasks: [task("t1", "working", SEAT_A)],
        nodes: [agentNode("n1")],
        actorRefs: [actorRef(SEAT_A, "n1")],
        processFor: () => undefined,
      }),
    );
    expect(noProcess.claims).toEqual([]);
    const blankGeneration = claimContextFrom(
      facts({
        tasks: [task("t1", "working", SEAT_A)],
        nodes: [agentNode("n1")],
        actorRefs: [actorRef(SEAT_A, "n1")],
        processFor: () => ({ generation: "", harness: "claude" }),
      }),
    );
    expect(blankGeneration.claims).toEqual([]);
  });

  it("a duplicated actorRef for one seat resolves deterministically to the first", () => {
    const context = claimContextFrom(
      facts({
        tasks: [task("t1", "working", SEAT_A)],
        nodes: [agentNode("n1"), agentNode("n2")],
        actorRefs: [actorRef(SEAT_A, "n1"), actorRef(SEAT_A, "n2")],
      }),
    );
    expect(context.claims).toHaveLength(1);
    expect(context.claims[0]?.nodeId).toBe("n1");
  });
});

// ---------------------------------------------------------------------------
// Canonical checkout identity.
// ---------------------------------------------------------------------------

describe("checkoutKeyFromPath — canonical worktree identity", () => {
  const tempDirs: string[] = [];
  const tempDir = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "vellum-checkout-key-"));
    tempDirs.push(dir);
    return dir;
  };
  afterAll(async () => {
    for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
  });

  it("resolves a real directory to its canonical path", async () => {
    const dir = await tempDir();
    const key = await checkoutKeyFromPath(`${dir}/`);
    expect(key).toBeTruthy();
    expect(key?.endsWith(dir.split("/").pop()!)).toBe(true);
  });

  it("refuses empty, relative, missing, file and null-byte paths", async () => {
    const dir = await tempDir();
    const file = join(dir, "file.txt");
    await writeFile(file, "x");
    expect(await checkoutKeyFromPath(undefined)).toBeUndefined();
    expect(await checkoutKeyFromPath("   ")).toBeUndefined();
    expect(await checkoutKeyFromPath("relative/path")).toBeUndefined();
    expect(await checkoutKeyFromPath(join(dir, "missing"))).toBeUndefined();
    expect(await checkoutKeyFromPath(file)).toBeUndefined();
    expect(await checkoutKeyFromPath(`${dir}\u0000`)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Read-only git probe.
// ---------------------------------------------------------------------------

type CliCall = { readonly command: string; readonly args: ReadonlyArray<string>; readonly timeoutMs?: number };

const fakeCli = (result: (args: ReadonlyArray<string>) => { ok: boolean; stdout: string; error?: string }) => {
  const calls: CliCall[] = [];
  const run = (async (
    command: string,
    args: ReadonlyArray<string>,
    timeoutMs?: number,
  ) => {
    calls.push({ command, args, timeoutMs });
    return result(args);
  }) as unknown as typeof runCli;
  return { calls, run };
};

describe("gitProbeOverRunCli — read-only and bounded", () => {
  it("reads branch + head and normalizes the sha", async () => {
    const sha = "A".repeat(40);
    const { calls, run } = fakeCli((args) =>
      args.includes("--abbrev-ref")
        ? { ok: true, stdout: "main\n" }
        : { ok: true, stdout: `${sha}\n` },
    );
    const probe = gitProbeOverRunCli({ run });
    const head = await probe.head("/co");
    expect(calls.map((call) => call.args.slice(2))).toEqual([
      ["rev-parse", "--abbrev-ref", "HEAD"],
      ["rev-parse", "HEAD"],
    ]);
    expect(calls.map((call) => call.args.slice(0, 2))).toEqual([
      ["-C", "/co"],
      ["-C", "/co"],
    ]);
    expect(head).toEqual({ branch: "main", head: sha.toLowerCase() });
  });

  it("refuses to invent a head from a non-sha revision", async () => {
    const { run } = fakeCli(() => ({ ok: true, stdout: "ABC123\n" }));
    expect(await gitProbeOverRunCli({ run }).head("/co")).toBeUndefined();
  });

  it("bounds every probe with the adapter timeout", async () => {
    const { calls, run } = fakeCli((args) =>
      args.includes("--abbrev-ref")
        ? { ok: true, stdout: "main" }
        : { ok: true, stdout: "a".repeat(40) },
    );
    await gitProbeOverRunCli({ run }).head("/co");
    expect(calls.every((call) => call.timeoutMs === GIT_PROBE_TIMEOUT_MS)).toBe(true);
    expect(calls.every((call) => call.args[0] === "-C")).toBe(true);
  });

  it("returns undefined when git refuses the worktree", async () => {
    const { run } = fakeCli(() => ({ ok: false, stdout: "", error: "not a git repository" }));
    expect(await gitProbeOverRunCli({ run }).head("/co")).toBeUndefined();
  });

  it("filters non-sha rev-list output and throws on failure", async () => {
    const sha = "b".repeat(40);
    const { run } = fakeCli(() => ({
      ok: true,
      stdout: `\n${sha.toUpperCase()}\nnot-a-sha\n`,
    }));
    expect(await gitProbeOverRunCli({ run }).newCommits("/co", "from", "to")).toEqual([sha]);

    const failing = fakeCli(() => ({ ok: false, stdout: "", error: "rev-list failed" }));
    await expect(
      gitProbeOverRunCli({ run: failing.run }).newCommits("/co", "from", "to"),
    ).rejects.toThrow(/rev-list failed/u);
  });

  it("reads a real local repository through the real adapter", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vellum-checkout-probe-"));
    try {
      const init = await runCli("git", ["init", "-q", "-b", "main", dir], 15_000);
      expect(init.ok).toBe(true);
      const commitAll = async (name: string, message: string) => {
        await writeFile(join(dir, name), `${message}\n`);
        const staged = await runCli("git", ["-C", dir, "add", "-A"], 15_000);
        expect(staged.ok).toBe(true);
        const commit = await runCli(
          "git",
          [
            "-C",
            dir,
            "-c",
            "user.email=probe@local",
            "-c",
            "user.name=probe",
            "commit",
            "-q",
            "-m",
            message,
          ],
          15_000,
        );
        expect(commit.ok).toBe(true);
      };

      const probe = gitProbeOverRunCli();
      await commitAll("README.md", "first");
      const first = await probe.head(dir);
      expect(first?.branch).toBe("main");
      expect(first?.head).toMatch(/^[0-9a-f]{40}$/u);

      await commitAll("second.md", "second");
      const second = await probe.head(dir);
      expect(second?.head).toMatch(/^[0-9a-f]{40}$/u);
      expect(second?.head).not.toBe(first?.head);

      expect(await probe.newCommits(dir, first!.head, second!.head)).toEqual([second!.head]);
      expect(await probe.newCommits(dir, second!.head, second!.head)).toEqual([]);
      // A directory that is not a worktree yields no snapshot.
      expect(await probe.head(tmpdir())).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Live watch.
// ---------------------------------------------------------------------------

describe("makeCheckoutWatchLive — baseline, attribution, coalescing", () => {
  it("first scan records the baseline and stays silent", async () => {
    const harness = makeLive([claim(SEAT_A, "t1", "n1")]);
    harness.probe.heads.set(CHECKOUT, "h1");
    const receipt = await runEffect(harness.live.scanOnce());
    expect(receipt).toMatchObject({
      observed: 0,
      attributed: 0,
      coalesced: 0,
      receiptsDelivered: 0,
      retained: 0,
      failed: 0,
      joined: false,
      checkouts: 1,
    });
    expect(harness.repository.calls).toEqual([]);
    expect(harness.delivered).toEqual([]);
    expect(harness.probe.calls).toEqual([`head:${CHECKOUT}`]);
    expect(harness.live.trackedCheckouts()).toEqual([CHECKOUT]);
    expect(harness.live.bindings().map((binding) => binding.taskId)).toEqual(["t1"]);
  });

  it("delivers one receipt for an attributed commit and records it once", async () => {
    const harness = makeLive([claim(SEAT_A, "t1", "n1")]);
    harness.probe.heads.set(CHECKOUT, "h1");
    await runEffect(harness.live.scanOnce());
    harness.probe.heads.set(CHECKOUT, "h2");
    harness.probe.ranges.set(`${CHECKOUT}\u0000h1..h2`, ["s2"]);
    const receipt = await runEffect(harness.live.scanOnce());
    expect(receipt).toMatchObject({
      observed: 1,
      attributed: 1,
      coalesced: 0,
      receiptsDelivered: 1,
      retained: 0,
      failed: 0,
    });
    expect(harness.delivered).toEqual([
      {
        canvasName: CANVAS,
        taskNodeId: "sink",
        checkoutKey: CHECKOUT,
        taskId: "t1",
        authorSeatId: SEAT_A,
        senderNodeId: "n1",
        senderGeneration: "gen-1",
        senderHarness: "claude",
        shas: ["s2"],
      },
    ]);
    expect(harness.repository.calls).toEqual([
      {
        checkoutKey: CHECKOUT,
        sha: "s2",
        seatId: SEAT_A,
        taskId: "t1",
        attributedVia: "claim-context",
        observedAt: new Date(1_700_000_000_000).toISOString(),
      },
    ]);
    expect(harness.errors).toEqual([]);
  });

  it("two seats on one checkout is unattributed: recorded, never mailed", async () => {
    const harness = makeLive([
      claim(SEAT_A, "t1", "n1"),
      claim(SEAT_B, "t2", "n2"),
    ]);
    harness.probe.heads.set(CHECKOUT, "h1");
    await runEffect(harness.live.scanOnce());
    harness.probe.heads.set(CHECKOUT, "h2");
    harness.probe.ranges.set(`${CHECKOUT}\u0000h1..h2`, ["s2"]);
    const receipt = await runEffect(harness.live.scanOnce());
    expect(receipt).toMatchObject({ observed: 1, attributed: 0, receiptsDelivered: 0 });
    expect(harness.delivered).toEqual([]);
    expect(harness.repository.calls).toEqual([
      {
        checkoutKey: CHECKOUT,
        sha: "s2",
        observedAt: new Date(1_700_000_000_000).toISOString(),
      },
    ]);
  });

  it("a released claim untracks, and re-attach re-baselines silently", async () => {
    const harness = makeLive([claim(SEAT_A, "t1", "n1")]);
    harness.probe.heads.set(CHECKOUT, "h1");
    await runEffect(harness.live.scanOnce());

    harness.probe.heads.set(CHECKOUT, "h2");
    harness.probe.ranges.set(`${CHECKOUT}\u0000h1..h2`, ["s2"]);
    harness.setClaims([]);
    const released = await runEffect(harness.live.scanOnce());
    expect(released).toMatchObject({ checkouts: 0, observed: 0 });
    expect(harness.live.trackedCheckouts()).toEqual([]);
    expect(harness.live.bindings()).toEqual([]);
    expect(harness.probe.calls).toEqual([`head:${CHECKOUT}`]);

    harness.setClaims([claim(SEAT_A, "t1", "n1")]);
    const reattached = await runEffect(harness.live.scanOnce());
    expect(reattached).toMatchObject({ checkouts: 1, observed: 0 });
    expect(harness.probe.calls).toEqual([`head:${CHECKOUT}`, `head:${CHECKOUT}`]);

    harness.probe.heads.set(CHECKOUT, "h3");
    harness.probe.ranges.set(`${CHECKOUT}\u0000h2..h3`, ["s3"]);
    const next = await runEffect(harness.live.scanOnce());
    expect(next).toMatchObject({ observed: 1, attributed: 1, receiptsDelivered: 1 });
    expect(harness.delivered.map((mail) => mail.shas)).toEqual([["s3"]]);
  });

  it("a durable duplicate still delivers once and coalesces the record", async () => {
    const harness = makeLive([claim(SEAT_A, "t1", "n1")]);
    harness.repository.preExisting.add(`${CHECKOUT}\u0000s2`);
    harness.probe.heads.set(CHECKOUT, "h1");
    await runEffect(harness.live.scanOnce());
    harness.probe.heads.set(CHECKOUT, "h2");
    harness.probe.ranges.set(`${CHECKOUT}\u0000h1..h2`, ["s2"]);
    const receipt = await runEffect(harness.live.scanOnce());
    expect(receipt).toMatchObject({ observed: 1, attributed: 1, coalesced: 1, receiptsDelivered: 1 });
    expect(harness.delivered.map((mail) => mail.shas)).toEqual([["s2"]]);
  });

  it("a failed delivery is retained and retried before the next scan", async () => {
    const harness = makeLive([claim(SEAT_A, "t1", "n1")]);
    harness.probe.heads.set(CHECKOUT, "h1");
    await runEffect(harness.live.scanOnce());
    harness.probe.heads.set(CHECKOUT, "h2");
    harness.probe.ranges.set(`${CHECKOUT}\u0000h1..h2`, ["s2"]);
    harness.setDeliveryFailing(true);
    const failed = await runEffect(harness.live.scanOnce());
    expect(failed).toMatchObject({
      observed: 1,
      attributed: 1,
      receiptsDelivered: 0,
      retained: 1,
      failed: 1,
    });
    expect(harness.repository.calls).toEqual([]);
    expect(harness.errors).toHaveLength(1);

    harness.setDeliveryFailing(false);
    const retried = await runEffect(harness.live.scanOnce());
    expect(retried).toMatchObject({
      observed: 0,
      attributed: 1,
      receiptsDelivered: 1,
      retained: 0,
      failed: 0,
    });
    expect(harness.delivered.map((mail) => mail.shas)).toEqual([["s2"]]);
    expect(harness.repository.calls).toHaveLength(1);
  });

  it("a failed record is retained; the retry re-delivers to an idempotent writer", async () => {
    const harness = makeLive([claim(SEAT_A, "t1", "n1")]);
    harness.probe.heads.set(CHECKOUT, "h1");
    await runEffect(harness.live.scanOnce());
    harness.probe.heads.set(CHECKOUT, "h2");
    harness.probe.ranges.set(`${CHECKOUT}\u0000h1..h2`, ["s2"]);
    harness.repository.setFailing(true);
    const failed = await runEffect(harness.live.scanOnce());
    expect(failed).toMatchObject({ receiptsDelivered: 1, retained: 1, failed: 1 });
    expect(harness.repository.calls).toEqual([]);

    harness.repository.setFailing(false);
    const retried = await runEffect(harness.live.scanOnce());
    expect(retried).toMatchObject({ receiptsDelivered: 1, retained: 0, failed: 0 });
    // Delivery is idempotent by contract, so re-delivery is safe; the record
    // happens exactly once.
    expect(harness.delivered.map((mail) => mail.shas)).toEqual([["s2"], ["s2"]]);
    expect(harness.repository.calls).toHaveLength(1);
  });

  it("a scan failure keeps the watermark so the range is re-emitted", async () => {
    const harness = makeLive([claim(SEAT_A, "t1", "n1")]);
    harness.probe.heads.set(CHECKOUT, "h1");
    await runEffect(harness.live.scanOnce());
    harness.probe.heads.set(CHECKOUT, "h2");
    harness.probe.ranges.set(`${CHECKOUT}\u0000h1..h2`, ["s2"]);
    harness.probe.throws.add(`range:${CHECKOUT}`);
    const failed = await runEffect(harness.live.scanOnce());
    expect(failed).toMatchObject({ observed: 0, receiptsDelivered: 0, failed: 1 });
    expect(harness.errors).toHaveLength(1);

    harness.probe.throws.delete(`range:${CHECKOUT}`);
    const recovered = await runEffect(harness.live.scanOnce());
    expect(recovered).toMatchObject({ observed: 1, attributed: 1, receiptsDelivered: 1 });
    expect(harness.probe.calls).toEqual([
      `head:${CHECKOUT}`,
      `head:${CHECKOUT}`,
      `range:${CHECKOUT}:h1..h2`,
      `head:${CHECKOUT}`,
      `range:${CHECKOUT}:h1..h2`,
    ]);
  });

  it("a concurrent scan joins the in-flight pass instead of re-probing", async () => {
    const harness = makeLive([claim(SEAT_A, "t1", "n1")]);
    harness.probe.heads.set(CHECKOUT, "h1");
    harness.probe.holdNextHead();
    const first = runEffect(harness.live.scanOnce());
    await waitFor(() => harness.probe.held.length === 1);
    const second = runEffect(harness.live.scanOnce());
    harness.probe.held[0]!.release();
    const [a, b] = await Promise.all([first, second]);
    expect(a.joined).toBe(false);
    expect(b.joined).toBe(true);
    expect(b.checkouts).toBe(a.checkouts);
    expect(b.observed).toBe(a.observed);
    expect(harness.probe.calls).toEqual([`head:${CHECKOUT}`]);
    expect(harness.contextReads()).toBe(1);
  });

  it("start takes one baseline pass, stop clears the poll, start is idempotent", async () => {
    const harness = makeLive([claim(SEAT_A, "t1", "n1")], { pollMs: 250 });
    harness.probe.heads.set(CHECKOUT, "h1");
    harness.live.start();
    harness.live.start();
    await waitFor(() => harness.probe.calls.length >= 1);
    harness.live.stop();
    const afterStop = harness.probe.calls.length;
    harness.probe.heads.set(CHECKOUT, "h2");
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(harness.probe.calls.length).toBe(afterStop);

    harness.live.start();
    await waitFor(() => harness.probe.calls.length > afterStop);
    harness.live.stop();
    harness.live.stop();
    expect(harness.probe.calls.filter((call) => call === `head:${CHECKOUT}`).length).toBeGreaterThan(1);
  });

  it("stop is authoritative for a scan already in flight", async () => {
    const harness = makeLive([claim(SEAT_A, "t1", "n1")]);
    harness.probe.heads.set(CHECKOUT, "h1");
    await runEffect(harness.live.scanOnce());
    harness.probe.heads.set(CHECKOUT, "h2");
    harness.probe.ranges.set(`${CHECKOUT}\u0000h1..h2`, ["s2"]);

    harness.probe.holdNextHead();
    const inFlight = runEffect(harness.live.scanOnce());
    await waitFor(() => harness.probe.held.length === 1);
    harness.live.stop();
    harness.probe.held[0]!.release();
    const receipt = await inFlight;
    expect(receipt.receiptsDelivered).toBe(0);
    expect(harness.delivered).toEqual([]);
    expect(harness.repository.calls).toEqual([]);
    // The observation is retained, not lost: a later start drains it.
    expect(receipt.retained).toBe(1);
    harness.live.start();
    await waitFor(() => harness.delivered.length === 1);
    harness.live.stop();
    expect(harness.delivered.map((mail) => mail.shas)).toEqual([["s2"]]);
    expect(harness.repository.calls).toHaveLength(1);
  });

  it("retains the observed generation verbatim when the claim moves on", async () => {
    const harness = makeLive([claim(SEAT_A, "t1", "n1")]);
    harness.probe.heads.set(CHECKOUT, "h1");
    await runEffect(harness.live.scanOnce());
    harness.probe.heads.set(CHECKOUT, "h2");
    harness.probe.ranges.set(`${CHECKOUT}\u0000h1..h2`, ["s2"]);
    harness.setDeliveryFailing(true);
    const failed = await runEffect(harness.live.scanOnce());
    expect(failed).toMatchObject({ retained: 1, receiptsDelivered: 0 });

    // A replacement process takes the seat before the retry. The receipt is
    // still owed — same stable author, same claim, same checkout — but it must
    // carry the generation that was observed when the commit landed.
    harness.setClaims([
      claim(SEAT_A, "t1", "n1", CHECKOUT, { generation: "gen-2" }),
    ]);
    harness.setDeliveryFailing(false);
    const retried = await runEffect(harness.live.scanOnce());
    expect(retried).toMatchObject({ receiptsDelivered: 1, receiptsAppended: 1, retained: 0 });
    expect(harness.delivered.map((mail) => mail.senderGeneration)).toEqual(["gen-1"]);
    expect(harness.repository.calls).toHaveLength(1);
  });

  it("never mixes two generations of one seat in one delivery group", async () => {
    const harness = makeLive([claim(SEAT_A, "t1", "n1")]);
    harness.probe.heads.set(CHECKOUT, "h1");
    await runEffect(harness.live.scanOnce());
    harness.probe.heads.set(CHECKOUT, "h2");
    harness.probe.ranges.set(`${CHECKOUT}\u0000h1..h2`, ["s2"]);
    harness.setDeliveryFailing(true);
    await runEffect(harness.live.scanOnce());

    harness.setClaims([
      claim(SEAT_A, "t1", "n1", CHECKOUT, { generation: "gen-2" }),
    ]);
    harness.setDeliveryFailing(false);
    harness.probe.heads.set(CHECKOUT, "h3");
    harness.probe.ranges.set(`${CHECKOUT}\u0000h2..h3`, ["s3"]);
    const pass = await runEffect(harness.live.scanOnce());
    expect(pass).toMatchObject({ observed: 1, attributed: 2, receiptsDelivered: 2 });
    expect(
      harness.delivered.map((mail) => [mail.senderGeneration, [...mail.shas]]),
    ).toEqual([
      ["gen-1", ["s2"]],
      ["gen-2", ["s3"]],
    ]);
  });

  it("records but never mails a retained commit whose task the seat has left", async () => {
    const harness = makeLive([claim(SEAT_A, "t1", "n1")]);
    harness.probe.heads.set(CHECKOUT, "h1");
    await runEffect(harness.live.scanOnce());
    harness.probe.heads.set(CHECKOUT, "h2");
    harness.probe.ranges.set(`${CHECKOUT}\u0000h1..h2`, ["s2"]);
    harness.setDeliveryFailing(true);
    await runEffect(harness.live.scanOnce());
    // The seat has moved on to another task on the same checkout before the
    // retained receipt could be written.
    harness.setClaims([claim(SEAT_A, "t9", "n1")]);
    harness.setDeliveryFailing(false);
    const receipt = await runEffect(harness.live.scanOnce());
    expect(receipt).toMatchObject({
      observed: 0,
      attributed: 1,
      unreceipted: 1,
      receiptsDelivered: 0,
      retained: 0,
    });
    expect(harness.delivered).toEqual([]);
    expect(harness.repository.calls).toEqual([
      {
        checkoutKey: CHECKOUT,
        sha: "s2",
        seatId: SEAT_A,
        taskId: "t1",
        attributedVia: "claim-context",
        observedAt: new Date(1_700_000_000_000).toISOString(),
      },
    ]);
  });

  it("bounds the retry backlog instead of growing without limit", async () => {
    const harness = makeLive([claim(SEAT_A, "t1", "n1")]);
    harness.probe.heads.set(CHECKOUT, "h1");
    await runEffect(harness.live.scanOnce());
    const shas = Array.from({ length: CHECKOUT_WATCH_MAX_RETAINED + 3 }, (_, index) =>
      index.toString(16).padStart(40, "0"),
    );
    harness.probe.heads.set(CHECKOUT, "h2");
    harness.probe.ranges.set(`${CHECKOUT}\u0000h1..h2`, shas);
    harness.setDeliveryFailing(true);
    const receipt = await runEffect(harness.live.scanOnce());
    expect(receipt.observed).toBe(shas.length);
    expect(receipt.retained).toBe(CHECKOUT_WATCH_MAX_RETAINED);
    expect(receipt.dropped).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Multi-canvas supervisor.
// ---------------------------------------------------------------------------

describe("makeCheckoutWatchSupervisor — one watcher per live canvas", () => {
  const makeSupervisor = (input: {
    canvases: () => ReadonlyArray<string>;
    claims: (canvasName: string) => ReadonlyArray<CheckoutWatchClaim>;
  }) => {
    const probe = makeProbe();
    const repository = makeRepository();
    const delivered: CheckoutReceiptMailInput[] = [];
    const errors: unknown[] = [];
    let deliveryFailing = false;
    let appendedPerGroup = 1;
    const supervisor = makeCheckoutWatchSupervisor({
      probe: probe.probe,
      repository: repository.repository,
      canvases: () => Effect.sync(() => input.canvases()),
      claims: (canvasName) => Effect.sync(() => input.claims(canvasName)),
      deliverReceipts: (mail) =>
        Effect.suspend(() => {
          if (deliveryFailing) {
            return Effect.fail({ reason: "test", message: "delivery failed" });
          }
          delivered.push(mail);
          return Effect.succeed(appendedPerGroup);
        }),
      run: runEffect,
      now: () => 1_700_000_000_000,
      onError: (error) => {
        errors.push(error);
      },
    });
    return {
      supervisor,
      probe,
      repository,
      delivered,
      errors,
      setDeliveryFailing: (next: boolean) => {
        deliveryFailing = next;
      },
      setAppendedPerGroup: (next: number) => {
        appendedPerGroup = next;
      },
    };
  };

  it("reconciles one watcher per canvas and keeps receipts canvas-scoped", async () => {
    let canvases = ["board-a", "board-b"];
    const harness = makeSupervisor({
      canvases: () => canvases,
      claims: (canvasName) => [claim(SEAT_A, `t-${canvasName}`, "n1", `/co-${canvasName}`)],
    });
    harness.probe.heads.set("/co-board-a", "h1");
    harness.probe.heads.set("/co-board-b", "h1");
    const baseline = await runEffect(harness.supervisor.scanOnce());
    expect(baseline.map((entry) => entry.canvasName)).toEqual(["board-a", "board-b"]);
    expect(harness.supervisor.canvases()).toEqual(["board-a", "board-b"]);

    harness.probe.heads.set("/co-board-a", "h2");
    harness.probe.heads.set("/co-board-b", "h2");
    harness.probe.ranges.set("/co-board-a\u0000h1..h2", ["a2"]);
    harness.probe.ranges.set("/co-board-b\u0000h1..h2", ["b2"]);
    const pass = await runEffect(harness.supervisor.scanOnce());
    expect(pass.map((entry) => entry.receipt.receiptsDelivered)).toEqual([1, 1]);
    expect(harness.delivered).toEqual([
      {
        canvasName: "board-a",
        taskNodeId: "sink",
        checkoutKey: "/co-board-a",
        taskId: "t-board-a",
        authorSeatId: SEAT_A,
        senderNodeId: "n1",
        senderGeneration: "gen-1",
        senderHarness: "claude",
        shas: ["a2"],
      },
      {
        canvasName: "board-b",
        taskNodeId: "sink",
        checkoutKey: "/co-board-b",
        taskId: "t-board-b",
        authorSeatId: SEAT_A,
        senderNodeId: "n1",
        senderGeneration: "gen-1",
        senderHarness: "claude",
        shas: ["b2"],
      },
    ]);

    // Closing a canvas stops its watcher; the other keeps polling.
    canvases = ["board-b"];
    harness.probe.heads.set("/co-board-a", "h3");
    harness.probe.heads.set("/co-board-b", "h3");
    harness.probe.ranges.set("/co-board-b\u0000h2..h3", ["b3"]);
    const closed = await runEffect(harness.supervisor.scanOnce());
    expect(closed.map((entry) => entry.canvasName)).toEqual(["board-b"]);
    expect(harness.supervisor.canvases()).toEqual(["board-b"]);
    expect(harness.delivered.map((mail) => mail.shas)).toEqual([["a2"], ["b2"], ["b3"]]);
    expect(harness.probe.calls).not.toContain("range:/co-board-a:h2..h3");
  });

  it("a closed canvas's backlog cannot be delivered under another canvas", async () => {
    let canvases = ["board-a", "board-b"];
    const harness = makeSupervisor({
      canvases: () => canvases,
      claims: (canvasName) => [claim(SEAT_A, `t-${canvasName}`, "n1", `/co-${canvasName}`)],
    });
    harness.probe.heads.set("/co-board-a", "h1");
    harness.probe.heads.set("/co-board-b", "h1");
    await runEffect(harness.supervisor.scanOnce());
    harness.probe.heads.set("/co-board-a", "h2");
    harness.probe.ranges.set("/co-board-a\u0000h1..h2", ["a2"]);
    harness.setDeliveryFailing(true);
    const failed = await runEffect(harness.supervisor.scanOnce());
    expect(failed[0]?.receipt.retained).toBe(1);
    expect(harness.errors.length).toBeGreaterThan(0);

    // board-a closes while its receipt is still pending; board-b keeps working.
    canvases = ["board-b"];
    harness.setDeliveryFailing(false);
    harness.probe.heads.set("/co-board-b", "h2");
    harness.probe.ranges.set("/co-board-b\u0000h1..h2", ["b2"]);
    const afterClose = await runEffect(harness.supervisor.scanOnce());
    expect(afterClose.map((entry) => entry.canvasName)).toEqual(["board-b"]);
    expect(harness.delivered).toEqual([
      {
        canvasName: "board-b",
        taskNodeId: "sink",
        checkoutKey: "/co-board-b",
        taskId: "t-board-b",
        authorSeatId: SEAT_A,
        senderNodeId: "n1",
        senderGeneration: "gen-1",
        senderHarness: "claude",
        shas: ["b2"],
      },
    ]);
  });

  it("supervisor stop prevents post-stop writes and start resumes", async () => {
    const harness = makeSupervisor({
      canvases: () => ["board-a"],
      claims: () => [claim(SEAT_A, "t1", "n1", "/co-board-a")],
    });
    harness.probe.heads.set("/co-board-a", "h1");
    await runEffect(harness.supervisor.scanOnce());
    harness.probe.heads.set("/co-board-a", "h2");
    harness.probe.ranges.set("/co-board-a\u0000h1..h2", ["a2"]);
    harness.supervisor.stop();
    const stopped = await runEffect(harness.supervisor.scanOnce());
    expect(stopped[0]?.receipt.receiptsDelivered).toBe(0);
    expect(harness.delivered).toEqual([]);

    harness.supervisor.start();
    await waitFor(() => harness.delivered.length === 1);
    harness.supervisor.stop();
    expect(harness.delivered.map((mail) => mail.shas)).toEqual([["a2"]]);
  });
});
