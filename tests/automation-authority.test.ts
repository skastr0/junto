/**
 * Behind the authority (0.11/06 F2), through the real stores: an automation
 * command is judged on its canvas's authority and lands when its entry
 * applies. With the authority off it is ruled here, in one transaction, as
 * before. The automation runs on a machine other than the authority, and a
 * placement moves the canvas count once, never twice: the judgment's move is
 * rolled back with it, and the fold at commit makes the one move. The fold
 * that lands it is tests/ruling-fold-equals-ruler.test.ts.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterEach, describe, expect, it, vi } from "vitest";

const flags = vi.hoisted(() => ({ authority: true }));
vi.mock("@shared/features", async (original) => ({
  ...(await original<typeof import("../src/shared/features")>()),
  get AUTHORITY_ENABLED() { return flags.authority; },
}));

import { makeAutomationRepositoryLive } from "../src/main/junto/automation/repository";
import { submitAutomationCommand } from "../src/main/junto/automation/ruler";
import { CanvasAuthoritiesLive } from "../src/main/junto/fleet/host";
import { makeInstallOpsLive } from "../src/main/junto/install-ops/engine";
import { MachineRepository, MachineRepositoryLive } from "../src/main/junto/machines/repository";
import { ModelRecords } from "../src/main/junto/model/records";
import { ModelService } from "../src/main/junto/model/service";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { WorkRepositoryLive } from "../src/main/junto/work/repository";
import { RulingRecorderLive } from "../src/main/junto/work/ruling-recorder";
import { AutomationId, type AutomationDefinition, type AutomationOp } from "../src/shared/automation";
import type { AutomationEnv } from "../src/shared/automation-domain";
import { asNodeId } from "../src/shared/model";
import type { HostId } from "../src/shared/remote-hosts";
import { mintOpId, type ResourceCommand, type RulingContext } from "../src/shared/resource-command";
import { nameThisMachine } from "./support/name-this-machine";
import { ModelStoresLive, seedCanvas } from "./support/seed-canvas";
import { clearMachines, seedThisMachine } from "./support/seed-this-machine";
import { automations, seat } from "./support/model-nodes";

const NAME = "factory";
const NODE = asNodeId("autos");
const LEAD = asNodeId("lead");
const ID = "01M62AV0000000000000000001" as AutomationId;
/** A machine other than the authority, which rules on this one. */
const ELSEWHERE = "vps" as HostId;
const everywhere: RulingContext = { inReach: () => true };
const env: AutomationEnv = { targetsOf: () => new Set([LEAD]), isOverseer: () => false };

const definition = (text: string): AutomationDefinition => ({
  name: "Nightly",
  trigger: { kind: "schedule", cron: "0 2 * * *", timezone: "UTC" },
  then: [{ kind: "mail", to: { kind: "seat", nodeId: LEAD }, text }],
  limits: { minIntervalMs: 60_000, maxPerHour: 12 },
});

const makeRuntime = (dir: string) => {
  // The recorder sees the machine and the canvas, as core-product wires it.
  const recorder = Layer.provide(RulingRecorderLive, Layer.mergeAll(WorkRepositoryLive, MachineRepositoryLive, ModelRecords.layer));
  const repositories = Layer.provideMerge(
    Layer.mergeAll(
      WorkRepositoryLive,
      MachineRepositoryLive,
      makeAutomationRepositoryLive(),
      // The automation ruler judges on the host's authorities.
      Layer.provideMerge(Layer.provide(CanvasAuthoritiesLive, MachineRepositoryLive), recorder),
    ),
    Layer.mergeAll(makeStateEngineLive(join(dir, "junto.db")), makeInstallOpsLive(join(dir, "install-ops.db"))),
  );
  return ManagedRuntime.make(Layer.provideMerge(ModelStoresLive, repositories));
};

let dir: string | undefined;
let runtime: ReturnType<typeof makeRuntime> | undefined;
afterEach(async () => {
  clearMachines();
  await runtime?.dispose();
  runtime = undefined;
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

const boot = async (authority: boolean) => {
  flags.authority = authority;
  dir = await mkdtemp(join(tmpdir(), "junto-automation-authority-"));
  runtime = makeRuntime(dir);
  await runtime.runPromise(nameThisMachine);
  seedThisMachine();
  await runtime.runPromise(seedCanvas(NAME, [seat("lead"), automations("autos", { x: 400 })]));
  return runtime;
};

const commandOf = (op: AutomationOp): ResourceCommand<AutomationOp> => ({
  opId: mintOpId(),
  canvasName: NAME,
  actor: { kind: "operator" },
  target: { kind: "automation", nodeId: NODE, ...(op.kind === "create" ? {} : { itemId: ID }) },
  basis: null,
  after: [],
  op,
});

const submit = (command: ResourceCommand<AutomationOp>) =>
  Effect.gen(function* () {
    const writer = yield* (yield* MachineRepository).installationId;
    return yield* submitAutomationCommand(writer, command, everywhere, env);
  });

/** Read on a connection of its own, as another reader of the disk does. */
const onDisk = <A>(read: (database: DatabaseSync) => A): A => {
  const database = new DatabaseSync(join(dir!, "junto.db"), { readOnly: true });
  try {
    return read(database);
  } finally {
    database.close();
  }
};
const count = (sql: string, ...values: Array<string>) => (onDisk((db) => db.prepare(sql).get(...values)) as { n: number }).n;
const seqOnDisk = () => (onDisk((db) => db.prepare("SELECT seq FROM canvases WHERE canvas_name = ?").get(NAME)) as { seq: number }).seq;
const head = () =>
  onDisk((db) => db.prepare("SELECT version, automation_json FROM automations WHERE canvas_name = ? AND automation_id = ?").get(NAME, ID)) as
    | { version: number; automation_json: string }
    | undefined;
const machineOnDisk = () => (JSON.parse(head()!.automation_json) as { machine?: string }).machine;

describe.each([false, true])("with the authority %s", (authority) => {
  it("an automation that runs elsewhere is on disk once submit returns, and each placement moves the count once", async () => {
    const rt = await boot(authority);
    const held = () => rt.runPromise(Effect.map(Effect.flatMap(ModelService, (model) => model.canvas(NAME)), (canvas) => Number(canvas.seq)));
    const start = seqOnDisk();
    const create = commandOf({ kind: "create", automationId: ID, enabled: false, machine: ELSEWHERE, definition: definition("Done?") });
    expect(await rt.runPromise(submit(create))).toMatchObject({ kind: "applied", automation: { automationId: ID, machine: ELSEWHERE } });
    expect(machineOnDisk()).toBe(ELSEWHERE);
    // Judged rulings are logged on the canvas's authority; direct ones are not.
    expect(count("SELECT COUNT(*) AS n FROM canvas_log WHERE canvas_name = ? AND kind = 'ruling'", NAME) > 0).toBe(authority);
    // A placement moves the count once: the judgment's move rolled back, the fold's kept.
    expect(seqOnDisk()).toBe(start + 1);
    expect(await held()).toBe(start + 1);

    // A resend answers from its stored ruling, and moves nothing.
    expect(await rt.runPromise(submit(create))).toMatchObject({ kind: "applied", facts: [] });
    expect(seqOnDisk()).toBe(start + 1);

    // An edit places nothing, so the count stands.
    expect(await rt.runPromise(submit(commandOf({ kind: "edit", baseVersion: 1 as never, definition: definition("Shipped?") })))).toMatchObject({
      kind: "applied",
    });
    expect(head()!.version).toBe(2);
    expect(seqOnDisk()).toBe(start + 1);

    // A move to the authority's own machine is a placement: once more, once.
    const here = (await rt.runPromise(Effect.flatMap(MachineRepository, (machines) => machines.machineName))) as HostId;
    expect(await rt.runPromise(submit(commandOf({ kind: "set-machine", machine: here })))).toMatchObject({ kind: "applied" });
    expect(machineOnDisk()).toBe(here);
    expect(seqOnDisk()).toBe(start + 2);
    expect(await held()).toBe(start + 2);
  });

  it("a stale base is refused and writes nothing, and behind the authority submit refuses a caller's transaction", async () => {
    const rt = await boot(authority);
    await rt.runPromise(submit(commandOf({ kind: "create", automationId: ID, enabled: false, machine: ELSEWHERE, definition: definition("Done?") })));
    const seq = seqOnDisk();
    expect(await rt.runPromise(submit(commandOf({ kind: "edit", baseVersion: 7 as never, definition: definition("late") })))).toMatchObject({ kind: "refused" });
    expect(head()!.version).toBe(1);
    expect(seqOnDisk()).toBe(seq);
    const inside = await rt.runPromise(
      Effect.exit(Effect.flatMap(SqlClient.SqlClient, (sql) => sql.withTransaction(submit(commandOf({ kind: "set-enabled", enabled: true }))))),
    );
    expect(inside._tag).toBe(authority ? "Failure" : "Success");
  });
});
