/**
 * A reply to an overseer's broadcast, over the real work socket as a seat
 * sends it. The broadcast is one way: a seat with no wire to the overseer is
 * told there is nothing to answer, in the type an unwired reply has always
 * had, and never told to wire an edge or raise a signal instead. A seat that
 * holds a wire to the overseer replies as it would to any mail.
 */
import { mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Result } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MsgReply } from "../src/contract/work/msg";
import { callWorkRpc } from "./support/work-rpc";
import { WORK_TOKEN_ENV } from "../src/shared/work-control";
import type { ActorRef } from "../src/shared/work-protocol";
import { publishSeatCredential } from "./helpers/seat-credential";
import { grantOverseer, ModelStoresLive, seedCanvas } from "./support/seed-canvas";
import { region, seat, wire } from "./support/model-nodes";
import { startWorkControlServer, type WorkControlServer } from "../src/core/work/control";
import { WorkLive } from "../src/core/work/service";
import { CrewRepositoryLive } from "../src/core/work/crew-repository";
import { makeContentServiceLive } from "../src/core/content/service";
import { WorkRepositoryLive } from "../src/core/work/repository";
import { makeStateEngineLive } from "../src/core/state/engine";
import { makeInstallOpsLive } from "../src/core/install-ops/engine";
import { MachineRepositoryLive } from "../src/core/machines/repository";
import { SettingsLive } from "../src/core/settings/service";
import { nameThisMachine } from "./support/name-this-machine";
import { PausePlaneAllPlaying } from "../src/core/pause-plane";
import { createMainAuthoringGate } from "../src/node/main-authoring-gate";
import { RulingRecorderLive } from "../src/core/work/ruling-recorder";
import { TaskRepositoryLive } from "../src/core/work/task-repository";
import { ModelActorRefs } from "../src/core/model/actor-refs";
import { overseerWorkAdmin } from "../src/core/work/authz";
import { executeOverseerWork } from "../src/core/overseer/work";
import { BROADCAST_REPLY_REFUSAL } from "../src/core/work-control/msg";
import { makeTestLog } from "./support/test-log";
import { THIS_MACHINE } from "./support/machines";
import { makeThisMachine } from "../src/shared/remote-hosts";
import { hostsSnapshot, setHostsSnapshot } from "../src/core/hosts/snapshot";

const testLog = makeTestLog();

const CANVAS = "broadcast-reply";

const makeRuntime = (root: string) => {
  const repositoriesLive = Layer.provideMerge(
    Layer.mergeAll(
      WorkRepositoryLive,
      CrewRepositoryLive,
      MachineRepositoryLive,
      SettingsLive,
      makeContentServiceLive({ root: join(root, "content"), skipInlineMediaMigration: true }),
    ),
    Layer.mergeAll(
      makeStateEngineLive(join(root, "state", "junto.db")),
      makeInstallOpsLive(join(root, "state", "install-ops.db")),
    ),
  );
  const tasksLive = Layer.provide(TaskRepositoryLive, RulingRecorderLive);
  const canvasesLive = Layer.provideMerge(Layer.mergeAll(ModelStoresLive, tasksLive), repositoriesLive);
  return ManagedRuntime.make(Layer.mergeAll(Layer.provideMerge(WorkLive, canvasesLive), PausePlaneAllPlaying, testLog.log.loggerLayer));
};

let root: string;
let runtime: ReturnType<typeof makeRuntime>;
let server: WorkControlServer;
let boss: ActorRef;
const tokens: Record<string, string> = {};
const heldHosts = hostsSnapshot();

const run = <A, E>(effect: Effect.Effect<A, E, never>) => runtime.runPromise(effect);

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "junto-broadcast-reply-"));
  const workHome = join(root, "work");
  mkdirSync(workHome, { recursive: true });
  process.env.JUNTO_WORK_HOME = workHome;
  runtime = makeRuntime(root);
  await runtime.runPromise(nameThisMachine);
  // The broadcast tells this machine's seats from others by the hosts the core loads at boot.
  setHostsSnapshot([makeThisMachine(THIS_MACHINE)]);
  // The overseer boss and two seats in one region: "lone" holds no wire to
  // boss, "wired" holds one.
  await runtime.runPromise(
    seedCanvas(
      CANVAS,
      [
        region("floor", { x: -40, y: -40, width: 1200, height: 400 }, { label: "Floor" }),
        seat("boss", { x: 0 }),
        seat("lone", { x: 300 }),
        seat("wired", { x: 600 }),
      ],
      [wire("to-boss", "wired", "boss", "messages")],
    ),
  );
  await runtime.runPromise(grantOverseer(CANVAS, "boss", true));
  const refs = await runtime.runPromise(Effect.flatMap(ModelActorRefs, (actors) => actors.read(CANVAS))) as ReadonlyArray<ActorRef>;
  boss = refs.find((ref) => ref.nodeId === "boss")!;
  server = await startWorkControlServer({
    version: "test",
    workHome,
    home: root,
    run: (effect) => runtime.runPromise(effect),
    authoringGate: createMainAuthoringGate(),
  });
  for (const id of ["lone", "wired"]) tokens[id] = publishSeatCredential(server.credentials, { agentKey: `local:${id}` });
});

afterEach(async () => {
  setHostsSnapshot(heldHosts);
  await server.close();
  await runtime.dispose();
  await rm(root, { recursive: true, force: true });
  delete process.env.JUNTO_WORK_HOME;
  delete process.env[WORK_TOKEN_ENV];
});

/** What boss's overseer write answered. */
const asBoss = (operation: "msg.broadcast" | "msg.send", args: Record<string, unknown>) =>
  run(executeOverseerWork({ canvasName: CANVAS, nodeId: "boss" }, { operation, args }, overseerWorkAdmin(boss)) as Effect.Effect<unknown, unknown, never>);

/** The broadcast row each seat received, by seat. */
const broadcastRows = async (): Promise<Record<string, string>> => {
  const sent = await asBoss("msg.broadcast", { region: ["Floor"], text: "stop and commit", expect: 2 }) as {
    readonly seats: ReadonlyArray<{ readonly nodeId: string; readonly messageId: string }>;
  };
  return Object.fromEntries(sent.seats.map((one) => [one.nodeId, one.messageId]));
};

/** A reply as the seat sends it, and what the core answered. */
const reply = (from: string, inReplyTo: string) => {
  process.env[WORK_TOKEN_ENV] = tokens[from]!;
  return Effect.runPromise(Effect.result(callWorkRpc(MsgReply, { target: "boss", text: "on it", inReplyTo })));
};

describe("a reply to an overseer's broadcast", () => {
  it("from a seat with no wire to the overseer: one way, nothing to answer, in an unwired reply's type", async () => {
    const rows = await broadcastRows();
    const refused = await reply("lone", rows.lone!);
    expect(Result.isFailure(refused)).toBe(true);
    if (!Result.isFailure(refused)) return;
    expect(refused.failure.message).toBe(BROADCAST_REPLY_REFUSAL);
    const nextStep = String((refused.failure.details as { readonly next_step?: unknown }).next_step);
    expect(nextStep).not.toMatch(/wire|edge|signal|escalate|feedback|blocked/i);

    // The same seat's reply to boss's ordinary mail is refused as before, in the same type.
    const single = await asBoss("msg.send", { target: "lone", text: "one note" }) as { readonly messageId: string };
    const unwired = await reply("lone", single.messageId);
    expect(Result.isFailure(unwired)).toBe(true);
    if (!Result.isFailure(unwired)) return;
    expect(unwired.failure.message).not.toBe(BROADCAST_REPLY_REFUSAL);
    expect(refused.failure.type).toBe(unwired.failure.type);
  });

  it("from a seat wired to the overseer: replies as to any mail", async () => {
    const rows = await broadcastRows();
    const answered = await reply("wired", rows.wired!);
    expect(Result.isSuccess(answered)).toBe(true);
    if (!Result.isSuccess(answered)) return;
    expect(answered.success.recipient.nodeId).toBe("boss");
  });
});
