/**
 * A canvas created after state step 61 begins with one authority, this
 * machine, in the shape step 61 seeds a canvas that existed (0.11/06 F6): the
 * consensus row at term 1 and the one-machine list. With AUTHORITY_ENABLED
 * off, creating a canvas writes neither.
 */
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

import { ModelRecords } from "../src/main/junto/model/records";
import { makeStateEngineLive } from "../src/main/junto/state/engine";

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

const created = async (authority: boolean) => {
  flags.authority = authority;
  dir = await mkdtemp(join(tmpdir(), "junto-canvas-authority-seed-"));
  const runtime = ManagedRuntime.make(Layer.provideMerge(ModelRecords.layer, makeStateEngineLive(join(dir, "junto.db"))));
  try {
    return await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const records = yield* ModelRecords;
        yield* sql`INSERT INTO known_installations(installation_id, registered_at) VALUES ('mini', '2026-10-29T00:00:00.000Z')`;
        yield* sql`INSERT INTO installation(singleton, installation_id, created_at) VALUES (1, 'mini', '2026-10-29T00:00:00.000Z')`;
        yield* sql.withTransaction(records.createCanvas("factory", "canvas-factory"));
        const consensus = yield* sql`SELECT canvas_name, current_term, voted_for, commit_index, applied_index, sole_installation_id
          FROM canvas_consensus`;
        const authorities = yield* sql`SELECT canvas_name, position, installation_id FROM canvas_authorities`;
        return { consensus: consensus.map((row) => ({ ...row })), authorities: authorities.map((row) => ({ ...row })) };
      }),
    );
  } finally {
    await runtime.dispose();
  }
};

describe("a canvas created after step 61", () => {
  it("with the authority on, begins with this machine as its one authority, at term 1", async () => {
    expect(await created(true)).toEqual({
      consensus: [{ canvas_name: "factory", current_term: 1, voted_for: null, commit_index: 0, applied_index: 0, sole_installation_id: null }],
      authorities: [{ canvas_name: "factory", position: 0, installation_id: "mini" }],
    });
  });

  it("with the authority off, as in ship, writes neither", async () => {
    expect(await created(false)).toEqual({ consensus: [], authorities: [] });
  });
});
