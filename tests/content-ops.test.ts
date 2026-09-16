import { createHash } from "node:crypto";
import {
  chmodSync,
  readFileSync,
  readdirSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, ManagedRuntime } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertRestoredContentCoherent,
  verifyContentSnapshotCoherence,
} from "../src/main/vellum-command/content/backup";
import {
  admitContentWrite,
  DEFAULT_CONTENT_DISK_RESERVE_BYTES,
} from "../src/main/vellum-command/content/disk-admission";
import {
  upsertContentTransfer,
} from "../src/main/vellum-command/content/manifest";
import {
  contentObjectPath,
  contentPartialPath,
  contentStoreRoot,
} from "../src/main/vellum-command/content/paths";
import { createContentService } from "../src/main/vellum-command/content/service";
import {
  ContentStoreError,
  ensureContentLayout,
} from "../src/main/vellum-command/content/store";
import {
  contentTransferPartialId,
  receiveContentTransfer,
} from "../src/main/vellum-command/content/transfer-local";
import {
  makeStateEngineLive,
  StateEngine,
} from "../src/main/vellum-command/state/engine";

const roots: string[] = [];
const runtimes: Array<ManagedRuntime.ManagedRuntime<StateEngine, unknown>> =
  [];

afterEach(async () => {
  while (runtimes.length > 0) {
    await runtimes.pop()!.dispose();
  }
  while (roots.length > 0) {
    await rm(roots.pop()!, { recursive: true, force: true });
  }
});

const tempRoot = async (prefix: string): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
};

const sha256Hex = (bytes: Buffer | string): string =>
  createHash("sha256").update(bytes).digest("hex");

const openEngine = async (dbPath: string) => {
  const runtime = ManagedRuntime.make(makeStateEngineLive(dbPath));
  runtimes.push(runtime);
  const state = await runtime.runPromise(StateEngine);
  return { runtime, state };
};

describe("content disk admission", () => {
  it("admits when free space covers need + reserve", () => {
    const admission = admitContentWrite({
      root: tmpdir(),
      needBytes: 1024,
      reserveBytes: 4096,
      freeBytes: 10_000,
    });
    expect(admission.ok).toBe(true);
    if (admission.ok) {
      expect(admission.remainingAfter).toBe(10_000 - 1024 - 4096);
    }
  });

  it("rejects with retryable disk-low when reserve would be breached", () => {
    const admission = admitContentWrite({
      root: tmpdir(),
      needBytes: 100,
      reserveBytes: DEFAULT_CONTENT_DISK_RESERVE_BYTES,
      freeBytes: DEFAULT_CONTENT_DISK_RESERVE_BYTES,
    });
    expect(admission.ok).toBe(false);
    if (!admission.ok) {
      expect(admission.retryable).toBe(true);
      expect(admission.shortfallBytes).toBe(100);
    }
  });

  it("put fails closed with disk-low before streaming", async () => {
    const home = await tempRoot("vellum-command-content-disk-");
    const dbPath = join(home, "junto.db");
    const { state } = await openEngine(dbPath);
    const root = contentStoreRoot(home);
    const service = createContentService(state, root);

    const result = await Effect.runPromise(
      service
        .put({
          source: Buffer.from("hello-disk"),
          mediaType: "text/plain",
          expected: {
            sha256: sha256Hex("hello-disk") as never,
            byteLength: Buffer.byteLength("hello-disk") as never,
          },
          diskFreeBytes: 0,
          diskReserveBytes: 1024,
        })
        .pipe(Effect.result),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure).toBeInstanceOf(ContentStoreError);
      expect((result.failure as ContentStoreError).code).toBe("disk-low");
    }
  });

  it("transfer receive refuses when remaining bytes exceed free space", async () => {
    const home = await tempRoot("vellum-command-content-xfer-disk-");
    const root = contentStoreRoot(home);
    ensureContentLayout(root);
    const payload = Buffer.from("transfer-payload-bytes");
    const ref = {
      sha256: sha256Hex(payload) as never,
      byteLength: payload.length as never,
      mediaType: "application/octet-stream" as never,
    };
    await expect(
      receiveContentTransfer({
        root,
        ref,
        source: payload,
        diskFreeBytes: 10,
        diskReserveBytes: 100,
      }),
    ).rejects.toMatchObject({ code: "disk-low" });
  });
});

describe("content integrity + GC + snapshot", () => {
  it("integrity verifies referenced objects and reports missing/corrupt", async () => {
    const home = await tempRoot("vellum-command-content-integrity-");
    const dbPath = join(home, "junto.db");
    const { state } = await openEngine(dbPath);
    const root = contentStoreRoot(home);
    const service = createContentService(state, root);

    const payload = Buffer.from("integrity-ok");
    const put = await Effect.runPromise(
      service.put({
        source: payload,
        mediaType: "text/plain",
        owner: {
          kind: "task",
          canvasName: "factory",
          nodeId: "task-1",
          recordId: "t1",
        },
      }),
    );

    const ok = await Effect.runPromise(service.integrityCheck());
    expect(ok.referencedCoherent).toBe(true);
    expect(ok.verifiedCount).toBe(1);

    // Corrupt the published file in place (objects are 0o444 after publish).
    chmodSync(put.path, 0o600);
    writeFileSync(put.path, Buffer.from("tampered-bytes"));
    const bad = await Effect.runPromise(service.integrityCheck());
    expect(bad.referencedCoherent).toBe(false);
    expect(
      bad.findings.some(
        (f) => f.kind === "referenced-corrupt" && f.sha256 === put.ref.sha256,
      ),
    ).toBe(true);
  });

  it("GC never deletes referenced or active-transfer digests", async () => {
    const home = await tempRoot("vellum-command-content-gc-");
    const dbPath = join(home, "junto.db");
    const { state } = await openEngine(dbPath);
    const root = contentStoreRoot(home);
    const service = createContentService(state, root);

    const kept = await Effect.runPromise(
      service.put({
        source: Buffer.from("keep-me"),
        mediaType: "text/plain",
        owner: {
          kind: "artifact",
          canvasName: "factory",
          nodeId: "art-1",
          recordId: "a1",
        },
      }),
    );

    // Unreferenced object past grace (object only, no ref).
    const orphan = await Effect.runPromise(
      service.put({
        source: Buffer.from("orphan-me"),
        mediaType: "text/plain",
      }),
    );

    // Active transfer protects another digest without a ref.
    const protectedPayload = Buffer.from("transfer-protect");
    const protectedDigest = sha256Hex(protectedPayload);
    await Effect.runPromise(
      state.transaction("seed-transfer", (writer) => {
        upsertContentTransfer(writer, {
          sha256: protectedDigest,
          byteLength: protectedPayload.length,
          state: "receiving",
          direction: "inbound",
          createdAt: "2000-01-01T00:00:00.000Z",
          updatedAt: "2000-01-01T00:00:00.000Z",
        });
      }),
    );
    // Publish the transfer-protected object without a content_refs row.
    await Effect.runPromise(
      service.put({
        source: protectedPayload,
        mediaType: "application/octet-stream",
        expected: {
          sha256: protectedDigest as never,
          byteLength: protectedPayload.length as never,
        },
      }),
    );

    // Age the unreferenced orphan object so grace expires.
    await Effect.runPromise(
      state.transaction("age-orphan", (writer) => {
        writer.run(
          `UPDATE content_objects SET created_at = ?, verified_at = ? WHERE sha256 = ?`,
          [
            "2000-01-01T00:00:00.000Z",
            "2000-01-01T00:00:00.000Z",
            orphan.ref.sha256,
          ],
        );
      }),
    );

    // Stale partial (not transfer-protected).
    ensureContentLayout(root);
    const stalePartial = contentPartialPath(root, "stale_ingest_id");
    writeFileSync(stalePartial, "partial-bytes");
    const ancient = new Date("2000-01-01T00:00:00.000Z");
    utimesSync(stalePartial, ancient, ancient);

    // Active transfer partial must survive.
    const activePartial = contentPartialPath(
      root,
      contentTransferPartialId(protectedDigest),
    );
    writeFileSync(activePartial, "still-receiving");
    utimesSync(activePartial, ancient, ancient);

    const report = await Effect.runPromise(
      service.collectGarbage({
        dryRun: false,
        orphanGraceMs: 0,
        partialGraceMs: 0,
        now: new Date("2020-01-01T00:00:00.000Z"),
      }),
    );

    expect(report.dryRun).toBe(false);
    expect(
      report.actions.some(
        (a) =>
          a.kind === "unreferenced-object" &&
          a.sha256 === orphan.ref.sha256 &&
          a.deletedManifest,
      ),
    ).toBe(true);
    expect(
      report.actions.some(
        (a) => a.kind === "stale-partial" && a.path === stalePartial && a.deleted,
      ),
    ).toBe(true);

    // Referenced object still on disk + in integrity.
    expect(readFileSync(kept.path).toString()).toBe("keep-me");
    const integrity = await Effect.runPromise(service.integrityCheck());
    expect(integrity.referencedCoherent).toBe(true);
    expect(
      integrity.findings.some(
        (f) =>
          f.kind === "referenced-missing" && f.sha256 === kept.ref.sha256,
      ),
    ).toBe(false);

    // Transfer-protected object remains.
    expect(
      readdirSync(join(root, "sha256", protectedDigest.slice(0, 2))).includes(
        protectedDigest,
      ),
    ).toBe(true);
    // Active partial retained.
    expect(readFileSync(activePartial).toString()).toBe("still-receiving");
    // Stale partial gone.
    expect(() => readFileSync(stalePartial)).toThrow();
  });

  it("snapshot + restored DB prove no dangling referenced objects", async () => {
    const home = await tempRoot("vellum-command-content-snap-");
    const dbPath = join(home, "junto.db");
    const { state } = await openEngine(dbPath);
    const root = contentStoreRoot(home);
    const service = createContentService(state, root);

    const a = await Effect.runPromise(
      service.put({
        source: Buffer.from("snap-a"),
        mediaType: "text/plain",
        displayName: "a.txt",
        owner: {
          kind: "task",
          canvasName: "factory",
          nodeId: "task-snap",
          recordId: "ts1",
        },
      }),
    );
    const b = await Effect.runPromise(
      service.put({
        source: Buffer.from("snap-b-larger-payload"),
        mediaType: "application/octet-stream",
        owner: {
          kind: "message",
          canvasName: "factory",
          nodeId: "agent-1",
          recordId: "m1",
        },
      }),
    );

    const stateBackup = await Effect.runPromise(state.backup());
    const snapshot = await Effect.runPromise(
      service.snapshot({ stateBackup }),
    );

    expect(snapshot.objectCount).toBe(2);
    expect(snapshot.stateBackup?.path).toBe(stateBackup.path);
    expect(verifyContentSnapshotCoherence(snapshot.path, { fullHash: true }).ok).toBe(
      true,
    );

    // Simulate restore: open the VACUUM backup DB + content snapshot.
    const restoredRuntime = ManagedRuntime.make(
      makeStateEngineLive(stateBackup.path),
    );
    runtimes.push(restoredRuntime);
    const restored = await restoredRuntime.runPromise(StateEngine);
    await Effect.runPromise(
      restored.read("assert-coherent", (reader) => {
        assertRestoredContentCoherent(reader, snapshot.path);
        return null;
      }),
    );

    // Both digests present under snapshot tree.
    for (const digest of [a.ref.sha256, b.ref.sha256]) {
      const path = join(
        snapshot.path,
        "sha256",
        digest.slice(0, 2),
        digest,
      );
      expect(readFileSync(path).length).toBeGreaterThan(0);
    }
  });

  it("snapshot refuses when a referenced object is missing", async () => {
    const home = await tempRoot("vellum-command-content-snap-miss-");
    const dbPath = join(home, "junto.db");
    const { state } = await openEngine(dbPath);
    const root = contentStoreRoot(home);
    const service = createContentService(state, root);

    const put = await Effect.runPromise(
      service.put({
        source: Buffer.from("will-delete"),
        mediaType: "text/plain",
        owner: {
          kind: "task",
          canvasName: "factory",
          nodeId: "task-x",
          recordId: "tx",
        },
      }),
    );
    // Remove object file only — dangling relative to live store.
    const { unlinkSync } = await import("node:fs");
    unlinkSync(put.path);

    const result = await Effect.runPromise(
      service.snapshot().pipe(Effect.result),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect((result.failure as ContentStoreError).code).toBe("corrupt");
    }
  });

  it("dry-run GC reports candidates without deleting", async () => {
    const home = await tempRoot("vellum-command-content-gc-dry-");
    const dbPath = join(home, "junto.db");
    const { state } = await openEngine(dbPath);
    const root = contentStoreRoot(home);
    const service = createContentService(state, root);

    const orphan = await Effect.runPromise(
      service.put({
        source: Buffer.from("dry-orphan"),
        mediaType: "text/plain",
      }),
    );
    await Effect.runPromise(
      state.transaction("age", (writer) => {
        writer.run(
          `UPDATE content_objects SET created_at = ? WHERE sha256 = ?`,
          ["2000-01-01T00:00:00.000Z", orphan.ref.sha256],
        );
      }),
    );

    const report = await Effect.runPromise(
      service.collectGarbage({
        orphanGraceMs: 0,
        now: new Date("2020-01-01T00:00:00.000Z"),
      }),
    );
    expect(report.dryRun).toBe(true);
    expect(
      report.actions.some(
        (a) =>
          a.kind === "unreferenced-object" &&
          a.sha256 === orphan.ref.sha256 &&
          !a.deletedManifest,
      ),
    ).toBe(true);
    // File still present.
    expect(readFileSync(contentObjectPath(root, orphan.ref.sha256)).toString()).toBe(
      "dry-orphan",
    );
  });
});
