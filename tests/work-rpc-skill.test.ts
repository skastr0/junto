/**
 * The artifact, automation, references and content.stage ops as one contract
 * on both sides of the work socket: the CLI calls them through `callWorkRpc`
 * with the contract's types, and the core answers them from the contract's
 * handlers, over the real socket. Each answer the CLI decodes is the answer
 * the core wrote, and the core refuses what the contract does not name, in
 * the words each op refused it in before.
 */
import { mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ArtifactArchive,
  ArtifactColour,
  ArtifactComment,
  ArtifactCreate,
  ArtifactEdit,
  ArtifactHistory,
  ArtifactLabelOp,
  ArtifactList,
  ArtifactRestore,
  ArtifactShow,
  AutomationHistory,
  AutomationList,
  AutomationShow,
  ContentStage,
  ReferencesList,
  ReferencesRead,
  SkillRpcs,
} from "../src/contract/work/skill";
import { WorkSocketLive, callWorkRpc } from "../src/cli/core/socket";
import { ArtifactListArgs } from "../src/shared/artifact-control";
import { ARTIFACTS_ENABLED } from "../src/shared/features";
import { mintItemId, mintOpId } from "../src/shared/resource-command";
import { WORK_TOKEN_ENV, encodeWorkFrame } from "../src/shared/work-control";
import { publishSeatCredential } from "./helpers/seat-credential";
import { ModelStoresLive, seedCanvas } from "./support/seed-canvas";
import { artifacts, automations, region, seat as seatNode, wire } from "./support/model-nodes";
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
import { ArtifactRepositoryLive } from "../src/core/work/artifact-repository";
import { makeAutomationRepositoryLive } from "../src/core/automation/repository";
import { ReferencesRepository, ReferencesRepositoryLive } from "../src/core/references/repository";
import { APP_REFERENCE_PLACE } from "../src/shared/references";
import { makeTestLog } from "./support/test-log";

const testLog = makeTestLog();

const CANVAS = "contract";
const ME = "agent";
const PEER = "peer";
const SHELF = "shelf";
const AUTOMATIONS = "automations";

const makeRuntime = (root: string) => {
  const repositoriesLive = Layer.provideMerge(
    Layer.mergeAll(
      WorkRepositoryLive,
      CrewRepositoryLive,
      MachineRepositoryLive,
      SettingsLive,
      ReferencesRepositoryLive,
      makeAutomationRepositoryLive(),
      makeContentServiceLive({ root: join(root, "content"), skipInlineMediaMigration: true }),
    ),
    Layer.mergeAll(
      makeStateEngineLive(join(root, "state", "junto.db")),
      makeInstallOpsLive(join(root, "state", "install-ops.db")),
    ),
  );
  const rulersLive = Layer.provide(Layer.mergeAll(TaskRepositoryLive, ArtifactRepositoryLive), RulingRecorderLive);
  const canvasesLive = Layer.provideMerge(Layer.mergeAll(ModelStoresLive, rulersLive), repositoriesLive);
  return ManagedRuntime.make(Layer.mergeAll(Layer.provideMerge(WorkLive, canvasesLive), PausePlaneAllPlaying, testLog.log.loggerLayer));
};

let root: string;
let runtime: ReturnType<typeof makeRuntime>;
let server: WorkControlServer;
let mine = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "junto-work-rpc-skill-"));
  const workHome = join(root, "work");
  mkdirSync(workHome, { recursive: true });
  process.env.JUNTO_WORK_HOME = workHome;
  runtime = makeRuntime(root);
  await runtime.runPromise(nameThisMachine);
  await runtime.runPromise(
    seedCanvas(
      CANVAS,
      [
        region("region", { x: -40, y: -40, width: 1400, height: 300 }, { label: "Canvas" }),
        seatNode(ME, { x: 0 }),
        seatNode(PEER, { x: 200 }),
        artifacts(SHELF, { x: 400 }),
        automations(AUTOMATIONS, { x: 700 }),
      ],
      [wire("edge", ME, PEER, "messages"), wire("back", PEER, ME, "messages")],
    ),
  );
  await runtime.runPromise(
    Effect.flatMap(ReferencesRepository, (store) =>
      store.write(APP_REFERENCE_PLACE, { name: "style", description: "how we write", body: "Plain words." }, "operator")),
  );
  server = await startWorkControlServer({
    version: "test",
    workHome,
    home: root,
    run: (effect) => runtime.runPromise(effect),
    authoringGate: createMainAuthoringGate(),
  });
  mine = publishSeatCredential(server.credentials, { agentKey: `local:${ME}` });
});

afterEach(async () => {
  await server.close();
  await runtime.dispose();
  await rm(root, { recursive: true, force: true });
  delete process.env.JUNTO_WORK_HOME;
  delete process.env[WORK_TOKEN_ENV];
});

/** A v1 frame as a seat writes it by hand, and the frame the core answers. */
const raw = (op: string, args: unknown): Promise<any> =>
  new Promise((resolve, reject) => {
    const socket = createConnection({ path: server.socketPath });
    let buffer = "";
    socket.on("connect", () => socket.write(encodeWorkFrame({ token: mine, op, args })));
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      socket.destroy();
      resolve(JSON.parse(buffer.slice(0, newline)));
    });
    socket.on("error", reject);
  });

/** The CLI's typed call, as this seat. */
const cli = <A>(call: Effect.Effect<A, unknown, never>): Promise<A> => {
  process.env[WORK_TOKEN_ENV] = mine;
  return Effect.runPromise(call);
};

describe("the skill contract across the work socket", () => {
  it("serves every op of the group through RPC", () => {
    expect([...SkillRpcs.requests.keys()].sort()).toEqual([
      "artifact.archive", "artifact.colour", "artifact.comment", "artifact.create", "artifact.edit", "artifact.history",
      "artifact.label", "artifact.list", "artifact.restore", "artifact.show",
      "automation.history", "automation.list", "automation.show",
      "content.stage",
      "references.list", "references.read",
    ]);
  });

  it.runIf(ARTIFACTS_ENABLED)("answers each artifact verb as the contract types it, decoded by the CLI", async () => {
    const call = <A>(effect: Effect.Effect<A, unknown, any>) => cli(effect.pipe(Effect.provide(WorkSocketLive)) as Effect.Effect<A, unknown, never>);
    const artifactId = mintItemId();
    const created = await call(callWorkRpc(ArtifactCreate, {
      opId: mintOpId(), artifactId, type: "document", title: "Plan", body: { markdown: "# plan" }, labels: ["draft"],
    }));
    expect(created).toMatchObject({ disposition: "applied", artifactId, version: 1 });

    const edited = await call(callWorkRpc(ArtifactEdit, { opId: mintOpId(), artifact: artifactId, baseVersion: 1 as never, body: { markdown: "# plan, final" } }));
    expect(edited).toMatchObject({ disposition: "applied", version: 2 });
    const labelled = await call(callWorkRpc(ArtifactLabelOp, { opId: mintOpId(), artifact: artifactId, add: ["shipped"] }));
    expect(labelled.disposition).toBe("applied");
    const coloured = await call(callWorkRpc(ArtifactColour, { opId: mintOpId(), label: "shipped", colour: "teal" }));
    expect(coloured).toMatchObject({ disposition: "applied", label: "shipped", colour: "teal" });

    const listed = await call(callWorkRpc(ArtifactList, {}));
    // The CLI's decode keeps the answer as the core wrote it.
    expect(listed).toEqual((await raw("artifact.list", {})).data);
    expect(listed.artifacts.map((row) => [row.artifactId, row.labels, row.labelColours])).toEqual([[artifactId, ["draft", "shipped"], { shipped: "teal" }]]);

    const shown = await call(callWorkRpc(ArtifactShow, { artifact: artifactId }));
    expect(shown).toEqual((await raw("artifact.show", { artifact: artifactId })).data);
    expect(shown.text).toContain("final");

    const history = await call(callWorkRpc(ArtifactHistory, { artifact: artifactId }));
    expect(history.versions.map((entry) => entry.change)).toEqual(["replace", "create"]);

    const commented = await call(callWorkRpc(ArtifactComment, { opId: mintOpId(), artifact: artifactId, text: "looks right" }));
    expect(commented.disposition).toBe("applied");

    expect((await call(callWorkRpc(ArtifactArchive, { opId: mintOpId(), artifact: artifactId }))).disposition).toBe("applied");
    expect((await call(callWorkRpc(ArtifactRestore, { opId: mintOpId(), artifact: artifactId }))).disposition).toBe("applied");
  });

  it("answers the automation reads as the contract types them", async () => {
    const call = <A>(effect: Effect.Effect<A, unknown, any>) => cli(effect.pipe(Effect.provide(WorkSocketLive)) as Effect.Effect<A, unknown, never>);
    const listed = await call(callWorkRpc(AutomationList, {}));
    expect(listed).toEqual((await raw("automation.list", {})).data);
    expect(listed).toEqual({ automations: [] });
    // A missing automation is refused by name, as before.
    const shown = await raw("automation.show", { target: AUTOMATIONS, automation: "standup" });
    expect(shown.error).toMatchObject({ type: "UnknownTarget", message: "no automation standup on this node", details: { path: "automation" } });
    const history = await call(callWorkRpc(AutomationHistory, { target: AUTOMATIONS }));
    expect(history).toEqual({ firings: [] });
    void AutomationShow;
  });

  it("answers the references reads as the contract types them", async () => {
    const call = <A>(effect: Effect.Effect<A, unknown, any>) => cli(effect.pipe(Effect.provide(WorkSocketLive)) as Effect.Effect<A, unknown, never>);
    const listed = await call(callWorkRpc(ReferencesList, {}));
    expect(listed).toEqual((await raw("references.list", {})).data);
    expect(listed.references.map((entry) => [entry.name, entry.scope, entry.description])).toEqual([["style", "app", "how we write"]]);
    const read = await call(callWorkRpc(ReferencesRead, { name: "Style" }));
    expect(read).toMatchObject({ name: "style", body: "Plain words.", scope: "app" });
    const missing = await raw("references.read", { name: "tone" });
    expect(missing.error).toMatchObject({ type: "UnknownTarget", message: 'no reference named "tone" is in this seat\'s scope' });
  });

  it("stages a file in one piece and answers its ref", async () => {
    const call = <A>(effect: Effect.Effect<A, unknown, any>) => cli(effect.pipe(Effect.provide(WorkSocketLive)) as Effect.Effect<A, unknown, never>);
    const staged = await call(callWorkRpc(ContentStage, { bytesBase64: Buffer.from("hi").toString("base64"), done: { mediaType: "text/plain" } } as never));
    expect(staged).toMatchObject({ ref: { byteLength: 2, mediaType: "text/plain" } });
  });

  it("refuses an argument the contract does not name, in each op's own words", async () => {
    const refusedArtifact = await raw("artifact.list", { colour: "teal" });
    const words = Schema.decodeUnknownResult(ArtifactListArgs, { onExcessProperty: "error" })({ colour: "teal" });
    expect(refusedArtifact.error).toEqual({
      type: "InputError",
      message: words._tag === "Failure" ? words.failure.message : "",
      details: { path: "args", hint: "junto schema show shows this command's input", retryable: false },
    });
    const refusedAutomation = await raw("automation.list", { node: "x" });
    expect(refusedAutomation.error.details).toEqual({ path: "args", hint: "junto schema show shows this command's input", retryable: false });
    const refusedList = await raw("references.list", { name: "x" });
    expect(refusedList.error).toEqual({
      type: "InputError",
      message: "references list takes no arguments: a seat lists its own scope",
      details: { path: "args", retryable: false, hint: "junto schema show references.list" },
    });
    const refusedRead = await raw("references.read", {});
    expect(refusedRead.error.details).toEqual({ path: "args", retryable: false, hint: "junto schema show references.read" });
  });

  it("refuses content.stage's arguments in fixed words that repeat nothing sent", async () => {
    const secret = "SECRET-FILE-CONTENT";
    const refused = await raw("content.stage", { bytesBase64: secret, path: `/Users/someone/${secret}` });
    expect(refused.error).toEqual({
      type: "InputError",
      message: "content.stage takes {stageId?, bytesBase64?, done?: {mediaType, displayName?, expected?}} with a piece, a done, or both",
      details: { path: "args", retryable: false, hint: "junto schema show content.stage" },
    });
    expect(JSON.stringify(refused)).not.toContain(secret);
  });
});
