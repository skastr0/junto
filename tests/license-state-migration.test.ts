import { createHash } from "node:crypto";
import { readdir, rm, mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ManagedRuntime } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  makeStateEngineLive,
  StateEngine,
} from "../src/main/vellum-command/state/engine";
import {
  CURRENT_STATE_SCHEMA_VERSION,
  STATE_SCHEMA_V2_IDENTITY,
} from "../src/main/vellum-command/state/migrations";
import {
  STATE_SCHEMA_V1_SQL,
  STATE_SCHEMA_V2_SQL,
} from "../src/main/vellum-command/state/schema";
import {
  verifyAndStampStateSchema,
} from "../src/main/vellum-command/state/schema-identity";

const roots: string[] = [];
const runtimes: Array<
  ManagedRuntime.ManagedRuntime<StateEngine, unknown>
> = [];

afterEach(async () => {
  while (runtimes.length > 0) {
    await runtimes.pop()!.dispose();
  }
  while (roots.length > 0) {
    await rm(roots.pop()!, { recursive: true, force: true });
  }
});

describe("license state schema migration", () => {
  it("backs up and expands a verified V1 database without changing its rows", async () => {
    const root = await mkdtemp(join(tmpdir(), "vellum-license-migration-"));
    roots.push(root);
    const stateDirectory = join(root, "state");
    const path = join(stateDirectory, "vellum-command.db");
    await mkdir(stateDirectory);
    const versionOne = new DatabaseSync(path);
    try {
      versionOne.exec(STATE_SCHEMA_V1_SQL);
      versionOne.prepare(
        `
          INSERT INTO canvas_generations(
            generation,
            created_at,
            cause,
            intent_sha256,
            document_count
          ) VALUES (?, ?, ?, ?, ?)
        `,
      ).run(
        "1",
        "2026-07-28T12:00:00.000Z",
        "migration-proof",
        "a".repeat(64),
        1,
      );
      versionOne.prepare(
        `
          INSERT INTO canvas_generation_documents(
            generation,
            name,
            body,
            sha256,
            modified_at
          ) VALUES (?, ?, ?, ?, ?)
        `,
      ).run(
        "1",
        "preserved",
        '{"nodes":[],"edges":[]}',
        createHash("sha256").update('{"nodes":[],"edges":[]}', "utf8").digest("hex"),
        "2026-07-28T12:00:00.000Z",
      );
      versionOne
        .prepare(
          "INSERT INTO canvas_head(singleton, generation) VALUES (1, '1')",
        )
        .run();
      verifyAndStampStateSchema(versionOne, STATE_SCHEMA_V1_SQL);
      versionOne.exec("PRAGMA user_version = 1");
    } finally {
      versionOne.close();
    }

    const runtime = ManagedRuntime.make(makeStateEngineLive(path));
    runtimes.push(runtime);
    const state = await runtime.runPromise(StateEngine);

    expect(state.info.schemaVersion).toBe(CURRENT_STATE_SCHEMA_VERSION);
    expect(
      await runtime.runPromise(
        state.read("test.license-migration", (reader) => ({
          document: reader.get(
            `
              SELECT canvas_name AS name
              FROM canvas_documents
            `,
          ),
          legacyLicenseTable: reader.get(
            `
              SELECT name
              FROM sqlite_schema
              WHERE type = 'table'
                AND name = 'license_activation'
            `,
          ),
          boundLicenseTable: reader.get(
            `
              SELECT name
              FROM sqlite_schema
              WHERE type = 'table'
                AND name = 'license_entitlement'
            `,
          ),
        })),
      ),
    ).toEqual({
      document: { name: "preserved" },
      legacyLicenseTable: { name: "license_activation" },
      boundLicenseTable: { name: "license_entitlement" },
    });

    const backups = await readdir(join(stateDirectory, "backups"));
    expect(backups).toHaveLength(1);
    const backup = new DatabaseSync(
      join(stateDirectory, "backups", backups[0]!),
      { readOnly: true },
    );
    try {
      expect(backup.prepare("PRAGMA user_version").get()).toEqual({
        user_version: 1,
      });
      expect(
        backup.prepare(
          `
            SELECT name
            FROM sqlite_schema
            WHERE type = 'table'
              AND name = 'license_activation'
          `,
        ).get(),
      ).toBeUndefined();
      expect(
        backup.prepare(
          `
            SELECT name, body
            FROM canvas_generation_documents
            WHERE generation = '1'
          `,
        ).get(),
      ).toEqual({
        name: "preserved",
        body: '{"nodes":[],"edges":[]}',
      });
    } finally {
      backup.close();
    }
  });

  it("preserves a V2 unbound activation but never adopts it as current entitlement", async () => {
    const root = await mkdtemp(join(tmpdir(), "vellum-license-v2-migration-"));
    roots.push(root);
    const stateDirectory = join(root, "state");
    const path = join(stateDirectory, "vellum-command.db");
    await mkdir(stateDirectory);
    const legacyBody = JSON.stringify({
      provider: "dodo",
      kind: "subscription",
      environment: "live",
      licenseKey: "legacy-unbound-secret",
      instanceId: "lki_legacy",
      activatedAt: "2026-07-27T12:00:00.000Z",
      lastValidationAttemptAt: "2026-07-27T12:00:00.000Z",
      lastValidatedAt: "2026-07-27T12:00:00.000Z",
      validationResult: "valid",
    });
    const versionTwo = new DatabaseSync(path);
    try {
      versionTwo.exec(STATE_SCHEMA_V2_SQL);
      versionTwo
        .prepare(
          `
            INSERT INTO license_activation(
              singleton,
              record_version,
              activated_license_json,
              updated_at
            ) VALUES (1, 1, ?, ?)
          `,
        )
        .run(legacyBody, "2026-07-28T12:00:00.000Z");
      verifyAndStampStateSchema(versionTwo, STATE_SCHEMA_V2_SQL);
      versionTwo.exec("PRAGMA user_version = 2");
    } finally {
      versionTwo.close();
    }

    const runtime = ManagedRuntime.make(makeStateEngineLive(path));
    runtimes.push(runtime);
    const state = await runtime.runPromise(StateEngine);

    expect(state.info.schemaVersion).toBe(CURRENT_STATE_SCHEMA_VERSION);
    expect(
      await runtime.runPromise(
        state.read("test.license-v2-migration", (reader) => ({
          legacy: reader.get(
            `
              SELECT record_version, activated_license_json
              FROM license_activation
              WHERE singleton = 1
            `,
          ),
          currentCount: reader.get(
            `
              SELECT count(*) AS count
              FROM license_entitlement
            `,
          ),
        })),
      ),
    ).toEqual({
      legacy: {
        record_version: 1,
        activated_license_json: legacyBody,
      },
      currentCount: { count: 0 },
    });

    const backups = await readdir(join(stateDirectory, "backups"));
    expect(backups).toHaveLength(1);
    const backup = new DatabaseSync(
      join(stateDirectory, "backups", backups[0]!),
      { readOnly: true },
    );
    try {
      expect(backup.prepare("PRAGMA user_version").get()).toEqual({
        user_version: 2,
      });
      expect(
        backup
          .prepare(
            `
              SELECT record_version, activated_license_json
              FROM license_activation
              WHERE singleton = 1
            `,
          )
          .get(),
      ).toEqual({
        record_version: 1,
        activated_license_json: legacyBody,
      });
      expect(
        backup
          .prepare(
            `
              SELECT name
              FROM sqlite_schema
              WHERE type = 'table'
                AND name = 'license_entitlement'
            `,
          )
          .get(),
      ).toBeUndefined();
    } finally {
      backup.close();
    }

    expect(STATE_SCHEMA_V2_IDENTITY).toMatchObject({
      actualSchemaSha256:
        "c7050c73efcea27e7ccb6e7c687f213cae8d2c32e8903d1ab7c7f1e8aeb953c3",
    });
  });
});
