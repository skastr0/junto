/**
 * A seat's chain of queued edits meets the operator's write on the editing
 * machine (remote-verify, queued-writes case C). The seat queued edit1 on
 * version 2 and then edit2 on version 3, its own pending edit1, while the
 * operator wrote version 3. edit1 is refused stale, and edit2, which builds
 * on it, is refused depends_on_refused naming edit1 as its root: it never
 * applies over the operator's body just because the version numbers match.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Option, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterAll, beforeAll, expect, it } from "vitest";
import { ContentService, makeContentServiceLive } from "../src/main/junto/content/service";
import { makeInstallOpsLive } from "../src/main/junto/install-ops/engine";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { ArtifactRepository, ArtifactRepositoryLive } from "../src/main/junto/work/artifact-repository";
import { WorkRepository, WorkRepositoryLive } from "../src/main/junto/work/repository";
import { ResourceRulerError, artifactRuler, makeResourceRuler } from "../src/main/junto/work/resource-ruler";
import { RulingRecorder, RulingRecorderLive } from "../src/main/junto/work/ruling-recorder";
import { ActorSeatId } from "../src/shared/actor-seat";
import type { ArtifactOp, ArtifactVersion } from "../src/shared/artifact";
import type { QueuedCommand } from "../src/shared/command-row";
import { ARTIFACTS_ENABLED } from "../src/shared/features";
import { InstallationId } from "../src/shared/installation-id";
import { asNodeId } from "../src/shared/physics/schema";
import { mintItemId, mintOpId, type OpId, type ResourceActor, type ResourceCommand } from "../src/shared/resource-command";
import { seedCanvasRows } from "./support/seed-canvas";
import { artifacts, canvasOf, seat } from "./support/model-nodes";

const id = Schema.decodeUnknownSync(InstallationId);
const EDITOR = id("macbook");
const MINI = id("mini");
const at = "2026-10-21T12:00:00.000Z";
const seatId = Schema.decodeUnknownSync(ActorSeatId)(`seat_${"2".repeat(64)}`);
const nodes = [seat("peer", { y: 0 }), artifacts("arts", { y: 200 })];
const canvas = canvasOf(nodes);
const artifactId = mintItemId();
const operator: ResourceActor = { kind: "operator" };
const peer: ResourceActor = { kind: "seat", seatId, nodeId: asNodeId("peer") };

const command = (actor: ResourceActor, op: ArtifactOp, after: ReadonlyArray<OpId> = []): ResourceCommand<ArtifactOp> => ({
  opId: mintOpId(),
  canvasName: "factory",
  actor,
  target: { kind: "artifact", nodeId: asNodeId("arts"), itemId: artifactId },
  basis: null,
  after,
  op,
});

const edit = (actor: ResourceActor, base: number, markdown: string, after: ReadonlyArray<OpId> = []) =>
  command(actor, { op: "edit", edit: { kind: "replace", baseVersion: base as ArtifactVersion, body: { type: "document", markdown } } } as ArtifactOp, after);

let root: string;
let runtime: ManagedRuntime.ManagedRuntime<ArtifactRepository | WorkRepository | RulingRecorder | ContentService | SqlClient.SqlClient, unknown>;

const submitHere = (written: ResourceCommand<ArtifactOp>) =>
  runtime.runPromise(Effect.flatMap(ArtifactRepository, (repo) => repo.submit(EDITOR, written, { inReach: () => true })));

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "junto-queued-chain-"));
  const content = makeContentServiceLive({ root: join(root, "content"), skipInlineMediaMigration: true });
  const recorder = Layer.provideMerge(RulingRecorderLive, WorkRepositoryLive);
  runtime = ManagedRuntime.make(
    Layer.provideMerge(Layer.provideMerge(ArtifactRepositoryLive, recorder), content).pipe(
      Layer.provideMerge(Layer.mergeAll(makeStateEngineLive(join(root, "junto.db")), makeInstallOpsLive(join(root, "install-ops.db")))),
    ),
  );
  await runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          for (const machine of [EDITOR, MINI]) yield* sql`INSERT INTO known_installations(installation_id, registered_at) VALUES (${machine}, ${at})`;
          yield* sql`INSERT INTO installation(singleton, installation_id, created_at) VALUES (1, ${EDITOR}, ${at})`;
          yield* seedCanvasRows({ seq: 1, canvases: new Map([["factory", { nodes }]]) });
        }),
      );
    }),
  );
});

afterAll(async () => {
  await runtime.dispose();
  await rm(root, { recursive: true, force: true });
});

// An artifacts-off build refuses every artifact command not_available (da2d6a12b), so there is no chain to rule.
it.runIf(ARTIFACTS_ENABLED)("refuses a queued edit that builds on a refused one, and the operator's version stays the head", async () => {
  // Before the seat is cut off: version 1, then 2.
  expect((await submitHere(command(operator, { op: "create", title: "Plan", body: { type: "document", markdown: "v1" } } as ArtifactOp))).kind).toBe("applied");
  expect((await submitHere(edit(operator, 1, "v2"))).kind).toBe("applied");
  // Cut off, the seat queues edit1 on 2 and edit2 on its own pending edit1 (3), as ResourceSubmit chains them.
  const edit1 = edit(peer, 2, "seat edit1");
  const edit2 = edit(peer, 3, "seat edit2", [edit1.opId]);
  // Meanwhile the operator writes version 3 on the editing machine.
  expect(await submitHere(edit(operator, 2, "operator v3"))).toMatchObject({ kind: "applied", version: 3 });

  // The link comes up: the editing machine rules the seat's held commands in order.
  const ruler = await runtime.runPromise(
    Effect.gen(function* () {
      const work = yield* WorkRepository;
      const recorder = yield* RulingRecorder;
      return yield* makeResourceRuler({
        canvases: Effect.succeed(["factory"]),
        editedCanvas: () => Effect.succeed(canvas),
        unruled: () => Effect.succeed([edit1, edit2].map((held) => ({ writer: MINI, command: held as unknown as QueuedCommand }))),
        state: (name, writer, opId) => work.commandState(name, writer, opId).pipe(Effect.orDie),
        record: (input) => recorder.record(input).pipe(Effect.mapError((cause) => new ResourceRulerError({ message: cause.message, cause }))),
        domains: { artifact: artifactRuler(yield* ArtifactRepository) },
      });
    }),
  );
  await runtime.runPromise(ruler.sweep("factory"));

  const stateOf = (opId: OpId) => runtime.runPromise(Effect.flatMap(WorkRepository, (work) => work.commandState("factory", MINI, opId)));
  const first = await stateOf(edit1.opId);
  expect(first.kind === "refused" && first.ruling.root).toBe(edit1.opId);
  const second = await stateOf(edit2.opId);
  expect(second.kind === "refused" && { reason: second.ruling.reason, root: second.ruling.root }).toEqual({
    reason: "depends_on_refused",
    root: edit1.opId,
  });

  const head = await runtime.runPromise(Effect.flatMap(ArtifactRepository, (repo) => repo.head("factory", artifactId)));
  expect(Option.isSome(head) && head.value.artifact.version).toBe(3);
  expect(JSON.stringify(Option.getOrUndefined(head))).toContain("operator v3");
});
