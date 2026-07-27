import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Context, Layer, ManagedRuntime, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  decodeStationBrowserPinnedTrustFrame,
  pinnedTrustForOriginKey,
  revokePinnedTrust,
  StationBrowserTrustRepository,
  StationBrowserTrustRepositoryLive,
} from "../src/main/vellum/browser/station-trust";
import {
  makeStateEngineLive,
  type StateEngineError,
} from "../src/main/vellum/state/engine";
import {
  canonicalStationBrowserJson,
  type StationBrowserPinnedTrustRecord,
} from "../src/shared/station-browser";
import { RemoteConfiguration } from "../src/shared/station-api";

type TrustRuntime = ManagedRuntime.ManagedRuntime<
  StationBrowserTrustRepository,
  StateEngineError
>;

const roots: string[] = [];
const runtimes: TrustRuntime[] = [];

const makeRuntime = async (
  prefix = "vellum-browser-trust-",
): Promise<Readonly<{ path: string; runtime: TrustRuntime }>> => {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  const path = join(root, "state", "vellum.db");
  const runtime = ManagedRuntime.make(
    StationBrowserTrustRepositoryLive.pipe(
      Layer.provide(makeStateEngineLive(path)),
    ),
  );
  runtimes.push(runtime);
  return { path, runtime };
};

const reopenRuntime = async (path: string): Promise<TrustRuntime> => {
  const runtime = ManagedRuntime.make(
    StationBrowserTrustRepositoryLive.pipe(
      Layer.provide(makeStateEngineLive(path)),
    ),
  );
  runtimes.push(runtime);
  return runtime;
};

const disposeRuntime = async (runtime: TrustRuntime): Promise<void> => {
  const index = runtimes.indexOf(runtime);
  if (index >= 0) runtimes.splice(index, 1);
  await runtime.dispose();
};

const repository = (runtime: TrustRuntime): Promise<ContextService> =>
  runtime.runPromise(StationBrowserTrustRepository);

type ContextService = Context.Tag.Service<typeof StationBrowserTrustRepository>;

afterEach(async () => {
  while (runtimes.length > 0) {
    await runtimes.pop()!.dispose();
  }
  while (roots.length > 0) {
    await rm(roots.pop()!, { recursive: true, force: true });
  }
});

describe("station browser origin-key custody", () => {
  it("persists one Ed25519 identity as private SQLite binary state", async () => {
    const { path, runtime } = await makeRuntime();
    const trust = await repository(runtime);
    const first = await runtime.runPromise(
      trust.loadOrCreateOriginKey("command-a", 1_700_000_000_000),
    );
    const again = await runtime.runPromise(
      trust.loadOrCreateOriginKey("command-a", 1_800_000_000_000),
    );

    expect(again.keyId).toBe(first.keyId);
    expect(again.generation).toBe(1);
    expect(again.privateKey.asymmetricKeyType).toBe("ed25519");
    expect(again.publicKey.asymmetricKeyType).toBe("ed25519");

    await disposeRuntime(runtime);
    const reopened = await reopenRuntime(path);
    const reopenedTrust = await repository(reopened);
    const persisted = await reopened.runPromise(
      reopenedTrust.loadOrCreateOriginKey("command-a", 2),
    );
    expect(persisted.keyId).toBe(first.keyId);

    await disposeRuntime(reopened);
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      const row = database
        .prepare(
          `SELECT
           count(*) AS count,
           typeof(private_key_pkcs8) AS private_type,
           typeof(public_key_spki) AS public_type
         FROM browser_origin_keys`,
        )
        .get() as {
        count: number;
        private_type: string;
        public_type: string;
      };
      expect(row).toEqual({
        count: 1,
        private_type: "blob",
        public_type: "blob",
      });
    } finally {
      database.close();
    }
  });

  it("appends contiguous generations and rejects stale or foreign custody", async () => {
    const { path, runtime } = await makeRuntime();
    const trust = await repository(runtime);
    const first = await runtime.runPromise(
      trust.loadOrCreateOriginKey("command-a", 1),
    );
    const second = await runtime.runPromise(trust.rotateOriginKey(first, 2));

    expect(second.generation).toBe(2);
    expect(second.keyId).not.toBe(first.keyId);
    await expect(
      runtime.runPromise(trust.rotateOriginKey(first, 3)),
    ).rejects.toThrow("changed before rotation");

    const other = await makeRuntime("vellum-browser-trust-other-");
    const otherTrust = await repository(other.runtime);
    await expect(
      other.runtime.runPromise(otherTrust.rotateOriginKey(second, 4)),
    ).rejects.toThrow("current repository custody");
    await expect(
      runtime.runPromise(trust.loadOrCreateOriginKey("another-command", 5)),
    ).rejects.toThrow("pinned to another station");

    await disposeRuntime(runtime);
    const database = new DatabaseSync(path);
    try {
      expect(
        database
          .prepare(
            "SELECT generation FROM browser_origin_keys ORDER BY generation",
          )
          .all(),
      ).toEqual([{ generation: 1 }, { generation: 2 }]);
      expect(() =>
        database
          .prepare(
            "UPDATE browser_origin_keys SET created_at = 99 WHERE generation = 1",
          )
          .run(),
      ).toThrow("immutable");
      expect(() =>
        database
          .prepare("DELETE FROM browser_origin_keys WHERE generation = 1")
          .run(),
      ).toThrow("immutable");
    } finally {
      database.close();
    }
  });

  it("fails closed when stored key material is not the declared Ed25519 pair", async () => {
    const { path, runtime } = await makeRuntime();
    await repository(runtime);
    await disposeRuntime(runtime);
    const nonEd25519 = generateKeyPairSync("ec", {
      namedCurve: "P-256",
    });
    const privateKey = nonEd25519.privateKey.export({
      format: "der",
      type: "pkcs8",
    }) as Buffer;
    const publicKey = nonEd25519.publicKey.export({
      format: "der",
      type: "spki",
    }) as Buffer;
    const database = new DatabaseSync(path);
    try {
      database
        .prepare(
          `INSERT INTO browser_origin_keys(
           generation,
           key_id,
           origin_station_id,
           created_at,
           private_key_pkcs8,
           public_key_spki
         ) VALUES (1, 'rsa-key', 'command-a', 1, ?, ?)`,
        )
        .run(privateKey, publicKey);
    } finally {
      database.close();
    }

    const reopened = await reopenRuntime(path);
    const trust = await repository(reopened);
    await expect(
      reopened.runPromise(trust.loadOrCreateOriginKey("command-a", 2)),
    ).rejects.toThrow(/Ed25519|inconsistent|malformed/);
  });
});

describe("station browser pinned trust ledger", () => {
  it("installs, rotates, and irreversibly revokes immutable generations", async () => {
    const origin = await makeRuntime("vellum-browser-origin-");
    const remote = await makeRuntime("vellum-browser-remote-");
    const originTrust = await repository(origin.runtime);
    const remoteTrust = await repository(remote.runtime);

    const first = await origin.runtime.runPromise(
      originTrust.loadOrCreateOriginKey("command-a", 1),
    );
    const firstRecord = pinnedTrustForOriginKey(first, null, 1);
    const installed = await remote.runtime.runPromise(
      remoteTrust.installPinnedRecord(firstRecord),
    );
    const idempotent = await remote.runtime.runPromise(
      remoteTrust.installPinnedRecord(firstRecord),
    );
    expect(idempotent).toEqual(installed);
    expect(
      await remote.runtime.runPromise(remoteTrust.loadPinnedTrust),
    ).toMatchObject({
      keyId: first.keyId,
      originStationId: "command-a",
    });

    await expect(
      remote.runtime.runPromise(
        remoteTrust.installPinnedRecord({
          ...firstRecord,
          updatedAt: 2,
        }),
      ),
    ).rejects.toThrow("already occupied");

    const second = await origin.runtime.runPromise(
      originTrust.rotateOriginKey(first, 2),
    );
    const secondRecord = pinnedTrustForOriginKey(second, first.keyId, 2);
    await remote.runtime.runPromise(
      remoteTrust.installPinnedRecord(secondRecord),
    );
    expect(
      (await remote.runtime.runPromise(remoteTrust.loadPinnedTrust))?.keyId,
    ).toBe(second.keyId);

    const third = await origin.runtime.runPromise(
      originTrust.rotateOriginKey(second, 3),
    );
    await expect(
      remote.runtime.runPromise(
        remoteTrust.installPinnedRecord(
          pinnedTrustForOriginKey(third, first.keyId, 3),
        ),
      ),
    ).rejects.toThrow("discontinuous");

    const revoked = revokePinnedTrust(secondRecord, 4);
    await remote.runtime.runPromise(remoteTrust.installPinnedRecord(revoked));
    expect(
      await remote.runtime.runPromise(remoteTrust.loadPinnedTrust),
    ).toBeUndefined();
    const fourth = await origin.runtime.runPromise(
      originTrust.rotateOriginKey(third, 5),
    );
    await expect(
      remote.runtime.runPromise(
        remoteTrust.installPinnedRecord(
          pinnedTrustForOriginKey(fourth, second.keyId, 5),
        ),
      ),
    ).rejects.toThrow("irreversible");

    await disposeRuntime(remote.runtime);
    const database = new DatabaseSync(remote.path);
    try {
      expect(
        database
          .prepare(
            `SELECT generation, status
             FROM browser_pinned_origin_trust
            ORDER BY generation`,
          )
          .all(),
      ).toEqual([
        { generation: 1, status: "active" },
        { generation: 2, status: "active" },
        { generation: 3, status: "revoked" },
      ]);
      expect(() =>
        database
          .prepare(
            `DELETE FROM browser_pinned_origin_trust
            WHERE generation = 1`,
          )
          .run(),
      ).toThrow("immutable");
    } finally {
      database.close();
    }
  });

  it("reloads public trust after restart without exposing private material", async () => {
    const origin = await makeRuntime("vellum-browser-origin-");
    const remote = await makeRuntime("vellum-browser-remote-");
    const originTrust = await repository(origin.runtime);
    const remoteTrust = await repository(remote.runtime);
    const key = await origin.runtime.runPromise(
      originTrust.loadOrCreateOriginKey("command-a", 1),
    );
    await remote.runtime.runPromise(
      remoteTrust.installPinnedRecord(pinnedTrustForOriginKey(key, null, 1)),
    );

    await disposeRuntime(remote.runtime);
    const reopened = await reopenRuntime(remote.path);
    const reopenedTrust = await repository(reopened);
    const pinned = await reopened.runPromise(reopenedTrust.loadPinnedTrust);
    expect(pinned).toMatchObject({
      keyId: key.keyId,
      originStationId: "command-a",
    });
    expect(pinned?.publicKey.asymmetricKeyType).toBe("ed25519");

    await disposeRuntime(reopened);
    const database = new DatabaseSync(remote.path, { readOnly: true });
    try {
      const columns = database
        .prepare("PRAGMA table_info(browser_pinned_origin_trust)")
        .all() as Array<{ name: string }>;
      expect(columns.map(({ name }) => name)).not.toContain(
        "private_key_pkcs8",
      );
    } finally {
      database.close();
    }
  });

  it("decodes only bounded canonical trust frames", async () => {
    const origin = await makeRuntime("vellum-browser-origin-");
    const trust = await repository(origin.runtime);
    const key = await origin.runtime.runPromise(
      trust.loadOrCreateOriginKey("command-a", 1),
    );
    const record = pinnedTrustForOriginKey(key, null, 1);
    const frame = canonicalStationBrowserJson(record);

    expect(decodeStationBrowserPinnedTrustFrame(frame)).toEqual(record);
    expect(() =>
      decodeStationBrowserPinnedTrustFrame(`${frame}\n{"extra":true}`),
    ).toThrow();
    expect(() =>
      decodeStationBrowserPinnedTrustFrame(
        JSON.stringify({ ...record, extra: true }),
      ),
    ).toThrow("not canonical");
  });

  it("is the typed public field of Remote configure only", async () => {
    const origin = await makeRuntime("vellum-browser-origin-");
    const trust = await repository(origin.runtime);
    const key = await origin.runtime.runPromise(
      trust.loadOrCreateOriginKey("command-a", 1),
    );
    const browserTrust = pinnedTrustForOriginKey(key, null, 1);
    const decoded = Schema.decodeUnknownSync(RemoteConfiguration)({
      role: "remote",
      hostId: "remote-a",
      agentHostId: "remote-a",
      commandCenterInstallationId: "command-a",
      commandCenterRef: "command-a",
      supervisedPreferred: true,
      browserTrust,
    });

    expect(decoded.browserTrust).toEqual(browserTrust);
    expect(
      "privateKeyPkcs8" in
        (decoded.browserTrust as StationBrowserPinnedTrustRecord),
    ).toBe(false);
  });
});
