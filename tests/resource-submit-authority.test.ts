/**
 * Behind the authority (0.11/06 F5), a seat's write that waits says why in
 * one line: the queued answer carries `authorityQueueReason`, read from the
 * same view the banner shows. While an authority is reachable, or with the
 * authority off, it carries none. A read that fails leaves the reason out,
 * never the write.
 */
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterEach, describe, expect, it, vi } from "vitest";

const flags = vi.hoisted(() => ({ authority: true }));
vi.mock("@shared/features", async (original) => ({
  ...(await original<typeof import("../src/shared/features")>()),
  get AUTHORITY_ENABLED() { return flags.authority; },
}));

import { CanvasAuthorities } from "../src/main/junto/fleet/authorities";
import { FleetDriverError } from "../src/main/junto/fleet/driver";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { writeResult } from "../src/main/junto/work/artifact-control";
import { WorkRepositoryLive } from "../src/main/junto/work/repository";
import { ResourceSubmit, makeResourceSubmitLayer } from "../src/main/junto/work/resource-submit";
import { writeResultOf } from "../src/main/junto/work/task-control";
import { ActorSeatId } from "../src/shared/actor-seat";
import type { AuthorityMachineFacts, AuthorityRead } from "../src/shared/authority";
import type { QueuedCommand } from "../src/shared/command-row";
import { InstallationId } from "../src/shared/installation-id";
import { seatStatusTime } from "../src/shared/seat-status-text";
import { OpId, type ItemId } from "../src/shared/work-ids";
import { seedCanvasRows } from "./support/seed-canvas";
import { seat, taskBoard } from "./support/model-nodes";

const id = Schema.decodeUnknownSync(InstallationId);
const SELF = id("mini");
const EDITOR = id("macbook");
const at = "2026-10-29T12:00:00.000Z";
const ASLEEP = Date.parse("2026-10-29T01:12:00.000Z");
const seatId = Schema.decodeUnknownSync(ActorSeatId)(`seat_${"2".repeat(64)}`);
let next = 0;
const op = () => Schema.decodeUnknownSync(OpId)(`01M65AQ${String(next++).padStart(19, "0")}`);

const command = (opId: OpId): QueuedCommand =>
  ({
    opId,
    canvasName: "factory",
    actor: { kind: "seat", seatId, nodeId: "s1" },
    target: { kind: "task", nodeId: "board-1" },
    basis: null,
    after: [],
    op: { kind: "start" },
  }) as unknown as QueuedCommand;

const read = (authorityReachable: boolean): AuthorityRead => ({
  canvas: "factory",
  self: SELF,
  role: "follower",
  term: 2,
  leader: authorityReachable ? EDITOR : null,
  commit: 4,
  lastIndex: 4,
  members: { list: [EDITOR, SELF] },
  fresh: false,
  canCommit: false,
  lastCommitAt: ASLEEP,
  waitingForOperator: { total: 0, commands: 0, structure: 0 },
  authorityReachable,
});
const machines: ReadonlyArray<AuthorityMachineFacts> = [
  { installationId: SELF, name: "mini", label: "Mac mini", reach: "here", since: null },
  { installationId: EDITOR, name: "macbook", label: "MacBook", reach: "asleep", since: ASLEEP },
];

/** The host's read, as the driver would answer it: reachable, unreachable, or failing. */
const authoritiesOf = (state: { reachable: boolean; failing: boolean }) =>
  Layer.succeed(CanvasAuthorities, CanvasAuthorities.of({
    status: () => (state.failing ? Effect.fail(new FleetDriverError({ message: "the authority could not be read", cause: undefined })) : Effect.succeed([read(state.reachable)])),
    machines: () => Effect.succeed({ self: machines[0]!, machines }),
    judge: () => Effect.die("not judged here"),
    setList: () => Effect.die("not set here"),
    alone: () => Effect.die("not forked here"),
  }));

let root: string | undefined;
let runtime: ManagedRuntime.ManagedRuntime<ResourceSubmit | SqlClient.SqlClient, unknown> | undefined;
afterEach(async () => {
  await runtime?.dispose();
  runtime = undefined;
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

const boot = async (authority: boolean, state: { reachable: boolean; failing: boolean }) => {
  flags.authority = authority;
  root = join(tmpdir(), `junto-resource-submit-authority-${randomUUID()}`);
  runtime = ManagedRuntime.make(
    Layer.provideMerge(
      Layer.provideMerge(makeResourceSubmitLayer(() => false), Layer.mergeAll(WorkRepositoryLive, authoritiesOf(state))),
      makeStateEngineLive(join(root, "junto.db")),
    ),
  );
  await runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`INSERT INTO known_installations(installation_id, registered_at) VALUES (${SELF}, ${at})`;
          yield* sql`INSERT INTO installation(singleton, installation_id, created_at) VALUES (1, ${SELF}, ${at})`;
          yield* seedCanvasRows({ seq: 1, canvases: new Map([["factory", { nodes: [seat("s1", { y: 0 }), taskBoard("board-1", { y: 200 })] }]]) });
          yield* sql`UPDATE canvases SET editor_installation_id = ${EDITOR} WHERE canvas_name = 'factory'`;
        }),
      );
    }),
  );
  return runtime;
};

const queue = (rt: NonNullable<typeof runtime>) => rt.runPromise(Effect.flatMap(ResourceSubmit, (submit) => submit.queue(command(op()), EDITOR)));

describe("a queued write behind the authority", () => {
  it("says why in one line while no machine can rule it", async () => {
    const rt = await boot(true, { reachable: false, failing: false });
    const outcome = await queue(rt);
    const asleep = seatStatusTime(ASLEEP, Date.now());
    expect(outcome).toEqual({ kind: "queued", reason: `no authority: MacBook asleep since ${asleep}, this machine` });
  });

  it("says nothing while an authority is reachable, with the authority off, or when the read fails", async () => {
    expect(await queue(await boot(true, { reachable: true, failing: false }))).toEqual({ kind: "queued" });
    await runtime!.dispose();
    runtime = undefined;
    expect(await queue(await boot(false, { reachable: false, failing: false }))).toEqual({ kind: "queued" });
    await runtime!.dispose();
    runtime = undefined;
    expect(await queue(await boot(true, { reachable: false, failing: true }))).toEqual({ kind: "queued" });
  });

  it("rides the task's and the artifact's queued answer as its message, and is absent without one", async () => {
    const opId = op();
    const item = "01M65AQ0000000000000000099" as ItemId;
    const reason = "no authority: MacBook unreachable";
    expect(await Effect.runPromise(writeResultOf({ kind: "queued", opId, reason }, { opId, target: { kind: "task", nodeId: "board-1", itemId: item } } as never)))
      .toEqual({ disposition: "queued", opId, taskId: item, message: reason });
    expect(await Effect.runPromise(writeResult({ kind: "queued", opId, reason }, { target: { kind: "artifact", nodeId: "arts", itemId: item } } as never)))
      .toEqual({ disposition: "queued", opId, artifactId: item, message: reason });
    expect(await Effect.runPromise(writeResultOf({ kind: "queued", opId }, { opId, target: { kind: "task", nodeId: "board-1", itemId: item } } as never)))
      .toEqual({ disposition: "queued", opId, taskId: item });
  });
});
