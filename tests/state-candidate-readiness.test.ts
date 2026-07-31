import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect, Either } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  inspectStateUpdateCandidate,
  STATE_UPDATE_PREFLIGHT_PROTOCOL,
} from "../src/main/vellum/state/candidate-readiness";
import {
  CURRENT_STATE_SCHEMA_VERSION,
} from "../src/main/vellum/state/migrations";
import {
  STATE_SCHEMA_SQL,
  STATE_SCHEMA_V1_SQL,
} from "../src/main/vellum/state/schema";
import { verifyAndStampStateSchema } from "../src/main/vellum/state/schema-identity";
import {
  withStateUpdateCandidate,
} from "../src/main/vellum/state/update-candidate";

const candidateSource = vi.hoisted(() => ({ path: "" }));
vi.mock("../src/main/vellum/state/engine", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../src/main/vellum/state/engine")
  >()),
  stateDatabasePath: () => candidateSource.path,
}));

const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) {
    await rm(roots.pop()!, { recursive: true, force: true });
  }
});

const makeDatabasePath = async (): Promise<string> => {
  const root = await mkdtemp(
    join(tmpdir(), "vellum-state-candidate-readiness-"),
  );
  roots.push(root);
  const state = join(root, "state");
  await mkdir(state);
  return join(state, "vellum.db");
};

const seedVersionOne = (path: string): string => {
  const body = '{"nodes":[],"edges":[]}';
  const documentSha256 = createHash("sha256")
    .update(body, "utf8")
    .digest("hex");
  const intentSha256 = createHash("sha256")
    .update(String(Buffer.byteLength("factory", "utf8")))
    .update("\0")
    .update("factory", "utf8")
    .update("\0")
    .update(documentSha256, "ascii")
    .update("\0")
    .digest("hex");
  const database = new DatabaseSync(path);
  try {
    database.exec(STATE_SCHEMA_V1_SQL);
    database.prepare(
      `
        INSERT INTO canvas_generations(
          generation,
          created_at,
          cause,
          intent_sha256,
          document_count
        ) VALUES ('1', '2026-07-28T00:00:00.000Z', 'test', ?, 1)
      `,
    ).run(intentSha256);
    database.prepare(
      `
        INSERT INTO canvas_generation_documents(
          generation,
          name,
          body,
          sha256,
          modified_at
        ) VALUES ('1', 'factory', ?, ?, '2026-07-28T00:00:00.000Z')
      `,
    ).run(body, documentSha256);
    database.prepare(
      "INSERT INTO canvas_head(singleton, generation) VALUES (1, '1')",
    ).run();
    verifyAndStampStateSchema(database, STATE_SCHEMA_V1_SQL);
    database.exec("PRAGMA user_version = 1");
  } finally {
    database.close();
  }
  return intentSha256;
};

describe("state candidate readiness", () => {
  it("migrates and semantically reads an installed v1 clone without touching the source", async () => {
    const path = await makeDatabasePath();
    const intentSha256 = seedVersionOne(path);
    candidateSource.path = path;

    const receipt = await Effect.runPromise(
      withStateUpdateCandidate(
        inspectStateUpdateCandidate,
      ),
    );

    expect(receipt).toMatchObject({
      protocol: STATE_UPDATE_PREFLIGHT_PROTOCOL,
      source: "installed",
      sourceSchemaVersion: 1,
      targetSchemaVersion: CURRENT_STATE_SCHEMA_VERSION,
      role: "unenrolled",
      canvasCount: 1,
      actorSeatCount: 0,
      workSnapshotCount: 0,
      pendingCommandCount: 0,
      armedRegionCount: 0,
      schedulerCursorCount: 0,
      ready: true,
    });
    expect(receipt.backupFile).toMatch(
      /^vellum-backup-[0-9a-f-]{36}\.db$/,
    );
    expect(receipt.activeIntent).toEqual({
      generation: "1",
      contentSha256: intentSha256,
    });

    const installed = new DatabaseSync(path, { readOnly: true });
    try {
      expect(installed.prepare("PRAGMA user_version").get()).toEqual({
        user_version: 1,
      });
      expect(
        installed.prepare(
          `
            SELECT name
            FROM sqlite_schema
            WHERE type = 'table' AND name = 'license_activation'
          `,
        ).get(),
      ).toBeUndefined();
    } finally {
      installed.close();
    }
  });

  it("proves a fresh current-schema candidate without retaining a fake backup", async () => {
    const path = await makeDatabasePath();
    candidateSource.path = path;
    const receipt = await Effect.runPromise(
      withStateUpdateCandidate(
        inspectStateUpdateCandidate,
      ),
    );

    expect(receipt).toMatchObject({
      protocol: STATE_UPDATE_PREFLIGHT_PROTOCOL,
      source: "fresh",
      sourceSchemaVersion: 0,
      targetSchemaVersion: CURRENT_STATE_SCHEMA_VERSION,
      role: "unenrolled",
      canvasCount: 0,
      ready: true,
    });
    expect(receipt).not.toHaveProperty("backupFile");
    expect(receipt).not.toHaveProperty("activeIntent");
    expect(existsSync(path)).toBe(false);
  });

  it("rejects a corrupt historical Work record that is absent from current material state", async () => {
    const path = await makeDatabasePath();
    await copyFile(
      join(
        process.cwd(),
        "tests/fixtures/state-v1/command-center-v1.db",
      ),
      path,
    );
    const database = new DatabaseSync(path);
    try {
      const immutableUpdate = database.prepare(
        `
          SELECT sql
          FROM sqlite_schema
          WHERE type = 'trigger'
            AND name = 'work_facts_immutable_update'
        `,
      ).get() as { readonly sql: string };
      database.exec("DROP TRIGGER work_facts_immutable_update");
      database.prepare(
        `
          UPDATE work_facts
          SET result_json = '{}'
          WHERE event_home = 'command-center-v1'
            AND entity_home = 'command-center-v1'
            AND seq = '1'
        `,
      ).run();
      database.exec(immutableUpdate.sql);
    } finally {
      database.close();
    }
    candidateSource.path = path;

    const result = await Effect.runPromise(
      Effect.either(
        withStateUpdateCandidate(
          inspectStateUpdateCandidate,
        ),
      ),
    );
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isRight(result)) {
      throw new Error("corrupt historical Work record passed preflight");
    }
    expect(result.left).toMatchObject({
      operation: "readiness",
    });
  });

  it("rejects corrupt proposal-only history during candidate preflight", async () => {
    const path = await makeDatabasePath();
    const database = new DatabaseSync(path);
    try {
      database.exec(STATE_SCHEMA_SQL);
      database.prepare(
        `
          INSERT INTO station_known_installations(
            installation_id,
            registered_at
          ) VALUES ('proposal-home', '2026-07-28T00:00:00.000Z')
        `,
      ).run();
      database.prepare(
        `
          INSERT INTO work_event_sequences(
            event_home,
            entity_home,
            last_seq
          ) VALUES ('proposal-home', 'proposal-home', '1')
        `,
      ).run();
      database.prepare(
        `
          INSERT INTO work_proposal_events(
            event_home,
            entity_home,
            seq,
            record_type,
            canvas_name,
            node_id,
            proposal_id,
            operation,
            content_sha256,
            record_json,
            origin_at,
            received_at
          ) VALUES (
            'proposal-home',
            'proposal-home',
            '1',
            'fact',
            'factory',
            'tasks',
            'malformed-proposal',
            'proposal.create',
            ?,
            '{}',
            '2026-07-28T00:00:00.000Z',
            '2026-07-28T00:00:00.000Z'
          )
        `,
      ).run("a".repeat(64));
      verifyAndStampStateSchema(database, STATE_SCHEMA_SQL);
      database.exec(
        `PRAGMA user_version = ${CURRENT_STATE_SCHEMA_VERSION}`,
      );
    } finally {
      database.close();
    }
    candidateSource.path = path;

    const result = await Effect.runPromise(
      Effect.either(
        withStateUpdateCandidate(
          inspectStateUpdateCandidate,
        ),
      ),
    );
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isRight(result)) {
      throw new Error(
        "corrupt proposal-only Work history passed preflight",
      );
    }
    expect(result.left).toMatchObject({
      operation: "readiness",
    });
  });
});
