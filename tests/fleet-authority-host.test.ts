/**
 * F5's host read (0.11/06, sections 2 and 5): `status` answers one canvas or
 * every canvas this machine holds, the list edit is a joint entry that leaves
 * the old list ruling until it commits, and `alone` is the operator's fork on
 * a pair that cannot commit. The read is the driver's own state plus the
 * apply time and the kept-change counts, named through this machine's
 * machine list.
 */
import "../src/shared/model";
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

import { makeInstallOpsLive } from "../src/main/junto/install-ops/engine";
import { MachineRepository, makeMachineRepositoryLive } from "../src/main/junto/machines/repository";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { RulingRecorder } from "../src/main/junto/work/ruling-recorder";
import { CanvasAuthorities } from "../src/main/junto/fleet/authorities";
import { ALONE_TERM_STRIDE } from "../src/main/junto/fleet/consensus";
import { CanvasAuthoritiesLive } from "../src/main/junto/fleet/host";
import { authorityListOf, authorityViewOf } from "../src/shared/authority";
import type { InstallationId } from "../src/shared/installation-id";
import { FleetDriverError } from "../src/main/junto/fleet/driver";
import { seedCanvasRows } from "./support/seed-canvas";

const SELF = "mini" as InstallationId;
const BOOK = "install-book" as InstallationId;
let root: string | undefined;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

const opened = async () => {
  root = await mkdtemp(join(tmpdir(), "junto-authority-host-"));
  const store = Layer.provideMerge(
    makeMachineRepositoryLive({ defaultName: () => "mini", makeInstallationId: () => SELF }),
    Layer.mergeAll(makeStateEngineLive(join(root, "junto.db")), makeInstallOpsLive(join(root, "install-ops.db"))),
  );
  const runtime = ManagedRuntime.make(
    Layer.provideMerge(
      CanvasAuthoritiesLive,
      Layer.mergeAll(
        store,
        Layer.succeed(RulingRecorder, RulingRecorder.of({ record: () => Effect.die("no ruling is judged here") })),
      ),
    ),
  );
  await runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const machines = yield* MachineRepository;
      yield* machines.pinPeer({ machineName: "book", installationId: BOOK });
      yield* seedCanvasRows({
        seq: 1,
        canvases: new Map([["factory", { nodes: [] }], ["pair", { nodes: [] }]]),
      });
      // The pair canvas: the operator's two machines, neither reachable, so this one cannot commit.
      yield* sql`DELETE FROM canvas_authorities WHERE canvas_name = 'pair'`;
      yield* sql`INSERT INTO canvas_authorities (canvas_name, position, installation_id) VALUES ('pair', 0, ${SELF}), ('pair', 1, ${BOOK})`;
      yield* sql`UPDATE canvas_consensus SET current_term = 1, commit_index = 0, applied_index = 0 WHERE canvas_name = 'pair'`;
    }),
  );
  return runtime;
};

describe("the authority host read", () => {
  it("answers one canvas as the driver state, with its apply time and kept changes", async () => {
    const runtime = await opened();
    try {
      const [read] = await runtime.runPromise(Effect.flatMap(CanvasAuthorities, (host) => host.status("factory")));
      expect(read).toMatchObject({
        canvas: "factory",
        self: SELF,
        term: expect.any(Number),
        role: "leader",
        canCommit: true,
        authorityReachable: true,
        lastCommitAt: expect.any(Number),
        waitingForOperator: { total: 0, commands: 0, structure: 0 },
      });
      expect(read?.members.list).toEqual([SELF]);
    } finally {
      await runtime.dispose();
    }
  });

  it("answers every canvas this machine holds when no canvas is named", async () => {
    const runtime = await opened();
    try {
      const reads = await runtime.runPromise(Effect.flatMap(CanvasAuthorities, (host) => host.status()));
      expect(reads.map((read) => read.canvas)).toEqual(["factory", "pair"]);
    } finally {
      await runtime.dispose();
    }
  });

  it("names this machine and its pinned peers, this one here and the peer not linked", async () => {
    const runtime = await opened();
    try {
      const { self, machines } = await runtime.runPromise(Effect.flatMap(CanvasAuthorities, (host) => host.machines()));
      expect(self).toMatchObject({ installationId: SELF, name: "mini", label: "mini", reach: "here" });
      expect(machines.map((machine) => [machine.name, machine.reach])).toEqual([["mini", "here"], ["book", "not-linked"]]);
    } finally {
      await runtime.dispose();
    }
  });

  it("refuses a name this machine does not know", async () => {
    const runtime = await opened();
    try {
      const failure = await runtime.runPromise(
        Effect.result(Effect.flatMap(CanvasAuthorities, (host) => host.setList("factory", ["nope"]))),
      );
      expect(failure._tag).toBe("Failure");
      if (failure._tag === "Failure") expect((failure.failure as FleetDriverError).message).toBe("there is no machine named nope");
    } finally {
      await runtime.dispose();
    }
  });

  it("leaves the old list ruling while the joint entry is not committed", async () => {
    const runtime = await opened();
    try {
      const read = await runtime.runPromise(Effect.flatMap(CanvasAuthorities, (host) => host.setList("factory", ["mini", "book"])));
      expect(read.pendingList).toEqual({ list: [SELF, BOOK], old: [SELF] });
      expect(read.members.list).toEqual([SELF]);
      expect(read.canCommit).toBe(false);
      const { self, machines } = await runtime.runPromise(Effect.flatMap(CanvasAuthorities, (host) => host.machines()));
      const data = authorityListOf({
        view: authorityViewOf(read, machines),
        named: machines.filter((machine) => machine.installationId === SELF || machine.installationId === BOOK),
      });
      expect(data.named.map((machine) => machine.name)).toEqual(["mini", "book"]);
      expect(data.committed.map((machine) => machine.name)).toEqual(["mini"]);
      expect(data.pending).toBe(true);
      expect(self.name).toBe("mini");
    } finally {
      await runtime.dispose();
    }
  });

  it("breaks a pair that cannot commit and leaves this machine the sole voter", async () => {
    const runtime = await opened();
    try {
      const read = await runtime.runPromise(Effect.flatMap(CanvasAuthorities, (host) => host.alone("pair")));
      expect(read.term).toBe(1 + ALONE_TERM_STRIDE);
      expect(read.members).toEqual({ list: [SELF, BOOK], sole: SELF });
      expect(read.canCommit).toBe(true);
      expect(read.role).toBe("leader");
    } finally {
      await runtime.dispose();
    }
  });

  it("refuses alone on a canvas whose committed list is not a pair", async () => {
    const runtime = await opened();
    try {
      const failure = await runtime.runPromise(Effect.result(Effect.flatMap(CanvasAuthorities, (host) => host.alone("factory"))));
      expect(failure._tag).toBe("Failure");
      if (failure._tag === "Failure") expect((failure.failure as FleetDriverError).message).toBe("factory refused: not-pair");
    } finally {
      await runtime.dispose();
    }
  });
});
