/**
 * An automation's move, end to end between two real machines (0.11/05 S2):
 * the automation ruler with the real model moves the canvas count, the copy
 * cut at that count says where the automation runs, the editing machine keeps
 * it in placement history, and a row the automation's machine wrote is
 * admitted or refused by which side of the move its stated count is on.
 */
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterEach, expect, it } from "vitest";
import { makeAutomationRepositoryLive } from "../src/main/junto/automation/repository";
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
import { WorkRepository, WorkRepositoryLive } from "../src/main/junto/work/repository";
import { RulingRecorderLive } from "../src/main/junto/work/ruling-recorder";
import { ModelService } from "../src/main/junto/model/service";
import { WorkLive } from "../src/main/junto/work/service";
import { AutomationId, type AutomationDefinition, type AutomationOp } from "../src/shared/automation";
import type { AutomationEnv } from "../src/shared/automation-domain";
import { InstallationId } from "../src/shared/installation-id";
import { AutomationNodeId, automationActorRef } from "../src/shared/mail-author";
import { Command } from "../src/shared/model";
import { asNodeId } from "../src/shared/physics/schema";
import type { ResourceCommand } from "../src/shared/resource-command";
import { OpId } from "../src/shared/work-ids";
import { automations, seat } from "./support/model-nodes";
import { ModelStoresLive, seedCanvas } from "./support/seed-canvas";

const id = Schema.decodeUnknownSync(InstallationId);
const MACBOOK = id("macbook-installation");
const MINI = id("mini-installation");
const at = "2026-10-28T12:00:00.000Z";
const NIGHTLY = Schema.decodeUnknownSync(AutomationId)("01M62AAAAAAAAAAAAAAAAAAAAA");
const command = Schema.decodeUnknownSync(Command);
const ROUTINES = Schema.decodeUnknownSync(AutomationNodeId)("routines");

const makeRuntime = (root: string, name: string, installation: InstallationId) =>
  ManagedRuntime.make(
    Layer.provideMerge(
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
    ),
  );

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
  const root = join(tmpdir(), `junto-automation-move-${name}-${randomUUID()}`);
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

/** Mail from the automation, written on the mini at the count it holds. */
const writeOnMini = (mini: Machine, messageId: string, count: number) =>
  mini.runtime.runPromise(
    Effect.flatMap(WorkRepository, (repository) =>
      repository.appendMessage({
        sink: { canvasName: "factory", nodeId: "lead" },
        basis: { kind: "canvas", canvasName: "factory", seq: count },
        message: { messageId, role: "agent", parts: [{ kind: "text", text: "from nightly" }] },
        sentBy: automationActorRef("factory", ROUTINES, NIGHTLY),
        destination: { kind: "mailbox" },
        originAt: at,
        receivedAt: at,
      }),
    ),
  );

/** Written on the mini and pushed to the macbook: the refusal, if the macbook refused it. */
const mailFromMini = async (mini: Machine, messageId: string, count: number): Promise<unknown> => {
  await writeOnMini(mini, messageId, count);
  await mini.runtime.runPromise(mini.exchange.committed("factory"));
  return settle();
};

const inbox = async (on: Machine): Promise<string[]> =>
  (await on.runtime.runPromise(Effect.flatMap(WorkRepository, (repository) => repository.mailbox("factory", "lead")))).map(
    (message) => message.messageId,
  );

it("moves the count with the real model, sends the move in the copy, and judges the automation's mail by the side of the move it states", async () => {
  const macbook = await boot("macbook", MACBOOK, ["mini", MINI]);
  const mini = await boot("mini", MINI, ["macbook", MACBOOK]);
  const lead = seat("lead", { x: 0, y: 0, width: 200, height: 100, host: "macbook" as never, agentKey: "macbook:claude", bindingId: "binding-lead" as never });
  await macbook.runtime.runPromise(seedCanvas("factory", [lead, automations("routines", { x: 400, y: 0 })]));
  // An automation alone gets the mini a copy; a seat placed there later keeps it getting copies after the move.
  const peer = seat("peer", { x: 0, y: 300, width: 200, height: 100, host: "mini" as never, agentKey: "mini:claude", bindingId: "binding-peer" as never });

  // Placed on the mini: the ruling moves the count.
  const seeded = await countOn(macbook);
  expect((await rule(macbook, { kind: "create", automationId: NIGHTLY, enabled: true, machine: "mini" as never, definition }, "01M62ABBBBBBBBBBBBBBBBBBB1")).kind).toBe("applied");
  const placed = await countOn(macbook);
  expect(placed).toBe(seeded + 1);

  // The mini, with only the automation and no seat, gets the copy at that count.
  expect(await link(macbook, mini)).toBeUndefined();
  expect(await countOn(mini)).toBe(placed);
  expect(await mailFromMini(mini, "nightly-on-mini", placed)).toBeUndefined();
  expect(await inbox(macbook)).toContain("nightly-on-mini");

  await macbook.runtime.runPromise(
    Effect.flatMap(ModelService, (model) => model.command(command({ _tag: "Add", canvas: "factory", nodes: [peer], wires: [] }), "operator")),
  );
  const seated = await countOn(macbook);
  await macbook.runtime.runPromise(macbook.exchange.committed("factory"));
  expect(await settle()).toBeUndefined();
  expect(await countOn(mini)).toBe(seated);

  // Written on the mini before it hears of the move, delivered after it.
  await writeOnMini(mini, "nightly-before-the-move", seated);

  // Moved to the macbook: the count moves again, and placement history closes the mini's row there.
  expect((await rule(macbook, { kind: "set-machine", machine: "macbook" as never }, "01M62ABBBBBBBBBBBBBBBBBBB2")).kind).toBe("applied");
  const moved = await countOn(macbook);
  expect(moved).toBe(seated + 1);
  await macbook.runtime.runPromise(macbook.exchange.committed("factory"));
  expect(await settle()).toBeUndefined();
  expect(await countOn(mini)).toBe(moved);
  const history = await macbook.runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* sql.unsafe("SELECT machine, from_seq, until_seq FROM automation_placements WHERE automation_id = ? ORDER BY from_seq", [NIGHTLY]);
    }),
  );
  expect(history).toEqual([
    { machine: MINI, from_seq: placed, until_seq: moved },
    { machine: MACBOOK, from_seq: moved, until_seq: null },
  ]);

  // Mail the mini wrote stating the count before the move is still its own.
  await mini.runtime.runPromise(mini.exchange.committed("factory"));
  expect(await settle()).toBeUndefined();
  expect(await inbox(macbook)).toContain("nightly-before-the-move");
  // Stating the count of the move, the mini wrote for an automation no longer there: refused.
  // The mini holds the copy at that count, so it is refused for where the automation was, not for the count.
  expect(String(await mailFromMini(mini, "nightly-after-the-move", moved))).toContain("a row was not written where its author lives");
  expect(await inbox(macbook)).not.toContain("nightly-after-the-move");
});

