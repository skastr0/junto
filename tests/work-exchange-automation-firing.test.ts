/**
 * A firing's revisions across machines, end to end between two real machines
 * (0.11/05 S3): the automation's machine crosses each revision of the firing
 * it minted, the receiver admits a rev only from the machine placement says
 * ran the automation at the claim's canvas count, and folds the highest rev
 * into its own automation_firings. A late settle from the machine the firing
 * was claimed under survives a move; a rev stating a count where the writer
 * did not run the automation is refused and closes the link.
 */
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterEach, expect, it } from "vitest";
import { AutomationRunnerLive } from "../src/main/junto/automation/live";
import { AutomationRepository, makeAutomationRepositoryLive } from "../src/main/junto/automation/repository";
import { submitAutomationCommand } from "../src/main/junto/automation/ruler";
import { makeContentServiceLive } from "../src/main/junto/content/service";
import { makeInstallOpsLive } from "../src/main/junto/install-ops/engine";
import { MachineRepository, makeMachineRepositoryLive } from "../src/main/junto/machines/repository";
import { PausePlaneLive } from "../src/main/junto/pause-plane";
import { FactoryPauseRepositoryLive } from "../src/main/junto/pause/repository";
import { ReferencesRepositoryLive } from "../src/main/junto/references/repository";
import { SeatGuidanceRepositoryLive } from "../src/main/junto/seat-guidance/repository";
import { AgentSignalRepositoryLive } from "../src/main/junto/signals/repository";
import { makeSettingsLive } from "../src/main/junto/settings/service";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { CrewRepositoryLive } from "../src/main/junto/work/crew-repository";
import { makeRowsChannel, type RowsChannelContext } from "../src/main/junto/work/exchange/channel";
import { makeLiveRowExchange } from "../src/main/junto/work/exchange/live";
import type { RowExchange } from "../src/main/junto/work/exchange/session";
import { WorkRepositoryLive } from "../src/main/junto/work/repository";
import { makeResourceSubmitLayer } from "../src/main/junto/work/resource-submit";
import { RulingRecorderLive } from "../src/main/junto/work/ruling-recorder";
import { TaskRepositoryLive } from "../src/main/junto/work/task-repository";
import { ArtifactRepositoryLive } from "../src/main/junto/work/artifact-repository";
import { ResourceRulerLive } from "../src/main/junto/work/resource-ruler";
import { WorkLive } from "../src/main/junto/work/service";
import { AutomationId, type AutomationDefinition, type AutomationOp, type Firing, FiringId } from "../src/shared/automation";
import type { AutomationEnv } from "../src/shared/automation-domain";
import { InstallationId } from "../src/shared/installation-id";
import { AutomationNodeId } from "../src/shared/mail-author";
import { asNodeId } from "../src/shared/physics/schema";
import type { ResourceCommand } from "../src/shared/resource-command";
import { OpId } from "../src/shared/work-ids";
import { automations, seat } from "./support/model-nodes";
import { ModelStoresLive, seedCanvas } from "./support/seed-canvas";

const id = Schema.decodeUnknownSync(InstallationId);
const MACBOOK = id("macbook-installation");
const MINI = id("mini-installation");
const NIGHTLY = Schema.decodeUnknownSync(AutomationId)("01M62AAAAAAAAAAAAAAAAAAAAA");
const ROUTINES = Schema.decodeUnknownSync(AutomationNodeId)("routines");
const firingId = Schema.decodeUnknownSync(FiringId);

const makeRuntime = (root: string, name: string, installation: InstallationId) => {
  const stores = Layer.provideMerge(
    Layer.mergeAll(WorkLive, makeAutomationRepositoryLive(), RulingRecorderLive),
    Layer.provideMerge(
      ModelStoresLive,
      Layer.provideMerge(
        Layer.mergeAll(
          WorkRepositoryLive,
          CrewRepositoryLive,
          makeSettingsLive(),
          makeContentServiceLive({ root: join(root, "content"), skipInlineMediaMigration: true }),
          SeatGuidanceRepositoryLive,
          AgentSignalRepositoryLive,
          ReferencesRepositoryLive,
          Layer.provideMerge(PausePlaneLive, FactoryPauseRepositoryLive),
          makeMachineRepositoryLive({ defaultName: () => name, makeInstallationId: () => installation }),
        ),
        Layer.mergeAll(makeStateEngineLive(join(root, "junto.db")), makeInstallOpsLive(join(root, "install-ops.db"))),
      ),
    ),
  );
  const rulers = Layer.provideMerge(Layer.mergeAll(TaskRepositoryLive, ArtifactRepositoryLive, makeResourceSubmitLayer(() => true)), stores);
  return ManagedRuntime.make(Layer.provideMerge(Layer.mergeAll(AutomationRunnerLive, ResourceRulerLive), rulers));
};

type Machine = {
  readonly name: string;
  readonly self: InstallationId;
  readonly root: string;
  readonly runtime: ReturnType<typeof makeRuntime>;
  readonly exchange: RowExchange;
  readonly channel: ReturnType<typeof makeRowsChannel>;
};

const queue: Array<{ readonly from: Machine; readonly to: Machine; readonly payload: unknown }> = [];
const booted: Machine[] = [];

afterEach(async () => {
  for (const machine of booted.splice(0)) {
    for (const link of machine.exchange.status()) machine.exchange.closed(link.peer);
    await machine.runtime.dispose();
    await rm(machine.root, { recursive: true, force: true });
  }
  queue.length = 0;
});

const boot = async (name: string, self: InstallationId, pin: readonly [string, InstallationId]): Promise<Machine> => {
  const root = join(tmpdir(), `junto-automation-firing-${name}-${randomUUID()}`);
  const runtime = makeRuntime(root, name, self);
  const exchange = await runtime.runPromise(
    Effect.gen(function* () {
      const machines = yield* MachineRepository;
      yield* machines.configureName(name);
      yield* machines.pinPeer({ machineName: pin[0], installationId: pin[1] });
      return yield* makeLiveRowExchange({ mailArrived: () => {} });
    }),
  );
  const machine: Machine = { name, self, root, runtime, exchange, channel: makeRowsChannel(exchange) };
  booted.push(machine);
  return machine;
};

const contextOf = (from: Machine, to: Machine): RowsChannelContext => ({
  peer: { installationId: to.self },
  sessionId: `${from.name}-${to.name}`,
  sendEvent: (_channel, payload) =>
    Effect.sync(() => {
      queue.push({ from, to, payload: JSON.parse(JSON.stringify(payload)) });
    }),
});

const quiet = async (): Promise<void> => {
  for (const machine of booted) await machine.runtime.runPromise(machine.exchange.quiet);
};

/** Deliver frames until none is left; a refused frame is kept as the error it was refused with. */
const settle = async (): Promise<unknown> => {
  let refusal: unknown;
  for (await quiet(); queue.length > 0; await quiet()) {
    const next = queue.shift()!;
    if (!next.to.exchange.linked(next.from.self)) continue;
    const frame = next.to.channel.decodeEvent(next.payload);
    await next.to.runtime
      .runPromise(next.to.channel.handleEvent(contextOf(next.to, next.from), frame))
      .catch((error: unknown) => {
        refusal = error;
      });
  }
  return refusal;
};

const link = async (left: Machine, right: Machine): Promise<unknown> => {
  await left.runtime.runPromise(left.channel.opened(contextOf(left, right)));
  await right.runtime.runPromise(right.channel.opened(contextOf(right, left)));
  return settle();
};

const countOn = async (on: Machine): Promise<number> =>
  on.runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql.unsafe<{ seq: number }>("SELECT seq FROM canvases WHERE canvas_name = 'factory'");
      return rows[0]!.seq;
    }),
  );

const definition: AutomationDefinition = {
  name: "Nightly",
  trigger: { kind: "schedule", cron: "0 2 * * *", timezone: "UTC" },
  then: [{ kind: "mail", to: { kind: "seat", nodeId: asNodeId("lead") }, text: "Done?" }],
  limits: { minIntervalMs: 60_000, maxPerHour: 12 },
};
const env: AutomationEnv = { targetsOf: () => new Set([asNodeId("lead")]), isOverseer: () => false };

/** The operator's automation command, ruled on the macbook with the real model. */
const rule = (macbook: Machine, op: AutomationOp, opId: string) =>
  macbook.runtime.runPromise(
    submitAutomationCommand(
      MACBOOK,
      {
        opId: OpId.make(opId),
        canvasName: "factory",
        actor: { kind: "operator" },
        target: { kind: "automation", nodeId: ROUTINES, ...(op.kind === "create" ? {} : { itemId: NIGHTLY }) },
        basis: null,
        after: [],
        op,
      } as unknown as ResourceCommand<AutomationOp>,
      { inReach: () => true },
      env,
    ),
  );

const firing = (ulid: string, claimSeq: number, outcome: Firing["outcome"], at = 1_000, slot = 60_000): Firing => ({
  firingId: firingId(ulid),
  automationId: NIGHTLY,
  at,
  cause: { kind: "schedule", slot, missed: 0 },
  outcome,
  machine: "mini",
  claimSeq,
});

const claimOn = (on: Machine, f: Firing) =>
  on.runtime.runPromise(Effect.flatMap(AutomationRepository, (repository) => repository.claimFiring("factory", f)));
const settleOn = (on: Machine, f: Firing, outcome: Firing["outcome"]) =>
  on.runtime.runPromise(Effect.flatMap(AutomationRepository, (repository) => repository.settleFiring("factory", f, outcome)));
const push = (on: Machine) => on.runtime.runPromise(on.exchange.committed("factory"));
const firingsOn = async (on: Machine) =>
  on.runtime.runPromise(
    Effect.flatMap(AutomationRepository, (repository) => repository.firings("factory", { automationId: NIGHTLY })),
  );

it("the automation's machine crosses each revision; a late settle from the machine it was claimed under survives a move", { timeout: 30_000 }, async () => {
  const macbook = await boot("macbook", MACBOOK, ["mini", MINI]);
  const mini = await boot("mini", MINI, ["macbook", MACBOOK]);
  const lead = seat("lead", { x: 0, y: 0, width: 200, height: 100, host: "macbook" as never, agentKey: "macbook:claude", bindingId: "binding-lead" as never });
  const peer = seat("peer", { x: 0, y: 300, width: 200, height: 100, host: "mini" as never, agentKey: "mini:claude", bindingId: "binding-peer" as never });
  await macbook.runtime.runPromise(seedCanvas("factory", [lead, peer, automations("routines", { x: 400, y: 0 })]));

  // Placed on the mini; the copy at that count is sent to it.
  expect((await rule(macbook, { kind: "create", automationId: NIGHTLY, enabled: true, machine: "mini" as never, definition }, "01M62AEEEEEEEEEEEEEEEEEEE1")).kind).toBe("applied");
  const placed = await countOn(macbook);
  expect(await link(macbook, mini)).toBeUndefined();

  // A skipped firing crosses at its claim: rev 0, first state worth showing.
  const skipped = firing("01M62BBBBBBBBBBBBBBBBBBBBB", placed, { kind: "skipped", reason: "condition_unmet" });
  expect(await claimOn(mini, skipped)).toEqual({ _tag: "Claimed" });
  await push(mini);
  expect(await settle()).toBeUndefined();
  expect(await firingsOn(macbook)).toEqual([skipped]);

  // A live claim does not cross; the settle is its first rev on the wire.
  const claimed = firing("01M62CCCCCCCCCCCCCCCCCCCCC", placed, { kind: "claimed" }, 2_000, 120_000);
  expect(await claimOn(mini, claimed)).toEqual({ _tag: "Claimed" });
  await settleOn(mini, claimed, { kind: "fired", actions: [{ index: 0, ruling: "applied" }] });
  await push(mini);
  expect(await settle()).toBeUndefined();
  const settled = { ...claimed, outcome: { kind: "fired", actions: [{ index: 0, ruling: "applied" }] } };
  expect(await firingsOn(macbook)).toEqual([settled, skipped]);

  // The automation moves to the macbook: the count moves, placement history
  // still says the mini ran it at the claim's count.
  expect((await rule(macbook, { kind: "set-machine", machine: "macbook" as never }, "01M62AEEEEEEEEEEEEEEEEEEE2")).kind).toBe("applied");
  const moved = await countOn(macbook);
  await push(macbook);
  expect(await settle()).toBeUndefined();
  expect(await countOn(mini)).toBe(moved);

  // A firing the mini claimed before the move settles late on the mini: its
  // rev still states the claim's count, so the macbook admits and folds it.
  const inflight = firing("01M62DDDDDDDDDDDDDDDDDDDDD", placed, { kind: "claimed" }, 3_000, 180_000);
  expect(await claimOn(mini, inflight)).toEqual({ _tag: "Claimed" });
  await settleOn(mini, inflight, { kind: "fired", actions: [{ index: 0, ruling: "applied" }] });
  await push(mini);
  expect(await settle()).toBeUndefined();
  const folded = await firingsOn(macbook);
  expect(folded).toHaveLength(3);
  expect(folded[0]).toMatchObject({ firingId: inflight.firingId, outcome: { kind: "fired" }, machine: "mini", claimSeq: placed });
});

it("a rev stating a count where the writer did not run the automation is refused and closes the link", { timeout: 30_000 }, async () => {
  const macbook = await boot("macbook", MACBOOK, ["mini", MINI]);
  const mini = await boot("mini", MINI, ["macbook", MACBOOK]);
  const lead = seat("lead", { x: 0, y: 0, width: 200, height: 100, host: "macbook" as never, agentKey: "macbook:claude", bindingId: "binding-lead" as never });
  const peer = seat("peer", { x: 0, y: 300, width: 200, height: 100, host: "mini" as never, agentKey: "mini:claude", bindingId: "binding-peer" as never });
  await macbook.runtime.runPromise(seedCanvas("factory", [lead, peer, automations("routines", { x: 400, y: 0 })]));

  expect((await rule(macbook, { kind: "create", automationId: NIGHTLY, enabled: true, machine: "mini" as never, definition }, "01M62AFFFFFFFFFFFFFFFFFFF1")).kind).toBe("applied");
  expect(await link(macbook, mini)).toBeUndefined();

  // Moved to the macbook: a rev from the mini may still state a pre-move count.
  expect((await rule(macbook, { kind: "set-machine", machine: "macbook" as never }, "01M62AFFFFFFFFFFFFFFFFFFF2")).kind).toBe("applied");
  const moved = await countOn(macbook);
  await push(macbook);
  expect(await settle()).toBeUndefined();
  expect(await countOn(mini)).toBe(moved);

  // Stating the count of the move — where placement puts the automation on
  // the macbook — the mini's row is refused as a row from the wrong machine
  // and never reaches the firing log.
  const wrong = firing("01M62BBBBBBBBBBBBBBBBBBBBB", moved, { kind: "skipped", reason: "condition_unmet" });
  expect(await claimOn(mini, wrong)).toEqual({ _tag: "Claimed" });
  await push(mini);
  expect(String(await settle())).toContain("a row was not written where its author lives");
  expect(await firingsOn(macbook)).toEqual([]);
});
