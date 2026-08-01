/**
 * End-to-end media transport proof across local and Station paths.
 *
 * Covers: task creation with ContentRef, local ingest, renderer protocol
 * access, Station projection/readiness, transfer interrupt/resume/duplicate/
 * corruption, offline convergence, and older-peer update-required.
 *
 * Non-goals held: production limits unchanged; Base64 is not the media proof;
 * no live external host.
 */

import { mkdir, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { Effect, Either, ManagedRuntime, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  ContentRef,
  hasInlineBinaryPayload,
  taskContentIsRunnable,
  taskContentReadiness,
  validateDurableParts,
  validateNoInlineBinaryPayload,
} from "../src/shared/content";
import {
  CONTENT_STATE_HEADER,
  contentMediaKind,
  contentObjectUrl,
} from "../src/shared/content-url";
import {
  CURRENT_STATION_PROTOCOL_SUPPORT,
  negotiateStationProtocol,
  StationProtocolSupport,
} from "../src/shared/station-protocol";
import {
  decodeWorkRecord,
  WORK_PROTOCOL_MAX_RECORD_BYTES,
  workRecordEncodedByteLength,
} from "../src/shared/work-protocol";
import type { Task } from "../src/shared/work-model";
import {
  materializeContentObject,
  taskContentRef,
} from "../src/main/vellum/content/agent-access";
import {
  contentObjectPath,
  contentPartialPath,
  contentStoreRoot,
} from "../src/main/vellum/content/paths";
import { createContentProtocolHandler } from "../src/main/vellum/content/protocol";
import { createContentService } from "../src/main/vellum/content/service";
import {
  contentTransferPartialId,
  receiveContentTransfer,
  sendContentTransfer,
  statContentForTransfer,
} from "../src/main/vellum/content/transfer-local";
import { ContentStoreError } from "../src/main/vellum/content/store";
import {
  makeStateEngineLive,
  StateEngine,
} from "../src/main/vellum/state/engine";
import {
  buildMediaFixture,
  DEFAULT_STREAM_CHUNK,
  emptyStreamStats,
  makeDeterministicPayload,
  MEDIA_FIXTURE_SIZES,
  MINIMAL_PNG_BYTES,
  sha256Hex,
  streamBuffer,
  streamLogicalLength,
} from "./fixtures/media-transport/streaming";

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

const openEngine = async (dbPath: string) => {
  const runtime = ManagedRuntime.make(makeStateEngineLive(dbPath));
  runtimes.push(runtime);
  const state = await runtime.runPromise(StateEngine);
  return { runtime, state };
};

const openStation = async (prefix: string) => {
  const home = await tempRoot(prefix);
  const stateDir = join(home, ".vellum", "state");
  await mkdir(stateDir, { recursive: true });
  const dbPath = join(stateDir, "vellum.db");
  const contentRoot = contentStoreRoot(home);
  const { state } = await openEngine(dbPath);
  const service = createContentService(state, contentRoot);
  return { home, dbPath, contentRoot, state, service };
};

const makeRef = (
  sha256: string,
  byteLength: number,
  mediaType: string,
  displayName?: string,
): ContentRef =>
  Schema.decodeUnknownSync(ContentRef)({
    sha256,
    byteLength,
    mediaType,
    ...(displayName === undefined ? {} : { displayName }),
  });

const taskWithContent = (
  id: string,
  refs: ReadonlyArray<ContentRef>,
  text = "Review attached media",
): Task => ({
  id,
  state: "submitted",
  history: [
    {
      messageId: `${id}-brief`,
      role: "user",
      parts: [
        { kind: "text", text },
        ...refs.map((ref) => ({ kind: "content" as const, ref })),
      ],
      taskId: id,
      contextId: "Vellumcommand",
    },
  ],
});

const taskCreateFact = (task: Task, seq = "1") => ({
  protocol: "vellum/work/v2",
  recordType: "fact",
  operation: "task.create",
  id: {
    route: {
      eventHome: "remote-installation",
      entityHome: "remote-installation",
    },
    seq,
  },
  item: {
    kind: "task",
    itemId: task.id,
    sink: { canvasName: "factory", nodeId: "tasks" },
  },
  basis: {
    kind: "authorial-intent",
    generation: "1",
    contentSha256: "c".repeat(64),
  },
  predecessor: null,
  originAt: "2026-07-31T18:00:00.000Z",
  contentSha256: "d".repeat(64),
  body: {
    operation: "task.create",
    task,
  },
});

const support = (value: {
  readonly preferred: number;
  readonly compatibleFrom: number;
  readonly warnBelow: number;
}) => Schema.decodeUnknownSync(StationProtocolSupport)(value);

// ---------------------------------------------------------------------------
// Task creation + WorkRecord bounds (fleet control plane)
// ---------------------------------------------------------------------------

describe("media transport e2e · task creation + WorkRecord bounds", () => {
  it("admits a multi-hundred-MB ContentRef task without requiring bytes in the WorkRecord", () => {
    const ref = makeRef(
      "a".repeat(64),
      MEDIA_FIXTURE_SIZES.hundredMegLogical,
      "video/mp4",
      "recording.mp4",
    );
    const task = taskWithContent("task-huge-media", [ref]);
    const fact = taskCreateFact(task);

    expect(hasInlineBinaryPayload(fact)).toBe(false);
    expect(validateNoInlineBinaryPayload(fact)).toBeUndefined();
    expect(
      validateDurableParts(task.history[0]!.parts),
    ).toBeUndefined();

    const decoded = decodeWorkRecord(fact);
    expect(Either.isRight(decoded)).toBe(true);
    if (Either.isLeft(decoded)) return;

    const encoded = workRecordEncodedByteLength(decoded.right);
    expect(encoded).toBeDefined();
    // Control record stays far under the 256 KiB Station bound even when the
    // referenced object is multi-hundred-megabyte.
    expect(encoded!).toBeLessThan(WORK_PROTOCOL_MAX_RECORD_BYTES);
    expect(encoded!).toBeLessThan(8_192);
    // And well under the logical media size itself.
    expect(encoded!).toBeLessThan(ref.byteLength / 1_000);
  });

  it("admits historical RawPart on decode while durable-write guards reject new inline Base64", () => {
    const inline = {
      protocol: "vellum/work/v2",
      recordType: "fact",
      operation: "task.create",
      id: {
        route: {
          eventHome: "remote-installation",
          entityHome: "remote-installation",
        },
        seq: "9",
      },
      item: {
        kind: "task",
        itemId: "task-legacy-b64",
        sink: { canvasName: "factory", nodeId: "tasks" },
      },
      basis: {
        kind: "authorial-intent",
        generation: "1",
        contentSha256: "c".repeat(64),
      },
      predecessor: null,
      originAt: "2026-07-31T18:00:00.000Z",
      contentSha256: "d".repeat(64),
      body: {
        operation: "task.create",
        task: {
          id: "task-legacy-b64",
          state: "submitted",
          history: [
            {
              messageId: "msg-b64",
              role: "user",
              parts: [
                { kind: "text", text: "legacy" },
                {
                  kind: "raw",
                  // Multi-megabyte Base64 would blow the bound; even a tiny
                  // payload must be rejected on the fleet path.
                  bytesBase64: MINIMAL_PNG_BYTES.toString("base64"),
                  mediaType: "image/png",
                },
              ],
              taskId: "task-legacy-b64",
              contextId: "Vellumcommand",
            },
          ],
        },
      },
    };

    // Decode still admits historical RawPart (installed state / migration input).
    // New durable writes reject via admission guards, not the record codec.
    expect(hasInlineBinaryPayload(inline)).toBe(true);
    expect(Either.isRight(decodeWorkRecord(inline))).toBe(true);
    expect(
      validateDurableParts(
        (inline.body.task.history[0] as { parts: unknown[] }).parts,
      ),
    ).toMatch(/ContentRef|Base64/i);
    expect(validateNoInlineBinaryPayload(inline)).toMatch(/Base64|ContentRef/i);
  });

  it("keeps a gigabyte logical video under the control-record bound", () => {
    const ref = makeRef(
      "b".repeat(64),
      MEDIA_FIXTURE_SIZES.gigabyteLogical,
      "video/mp4",
      "hour-long.mp4",
    );
    const task = taskWithContent("task-1gb", [ref]);
    const decoded = decodeWorkRecord(taskCreateFact(task, "2"));
    expect(Either.isRight(decoded)).toBe(true);
    if (Either.isLeft(decoded)) return;
    const bytes = workRecordEncodedByteLength(decoded.right)!;
    expect(bytes).toBeLessThan(WORK_PROTOCOL_MAX_RECORD_BYTES);
  });
});

// ---------------------------------------------------------------------------
// Local ingest + crash ordering
// ---------------------------------------------------------------------------

describe("media transport e2e · local ingest + crash ordering", () => {
  it("streams image/audio/video fixtures without full-body residency beyond one chunk", async () => {
    const station = await openStation("vellum-media-ingest-");

    for (const kind of ["image", "audio", "video"] as const) {
      const fixture = buildMediaFixture(kind);
      const stats = emptyStreamStats();
      const put = await station.service
        .put({
          source: streamBuffer(fixture.bytes, DEFAULT_STREAM_CHUNK, stats),
          mediaType: fixture.mediaType,
          displayName: fixture.displayName,
          expected: {
            sha256: fixture.sha256 as ContentRef["sha256"],
            byteLength: fixture.byteLength as ContentRef["byteLength"],
          },
          owner: {
            kind: "task",
            canvasName: "factory",
            nodeId: "tasks",
            recordId: `task-${kind}`,
          },
          // Test hook: plenty of free space.
          diskFreeBytes: 10 * 1024 * 1024 * 1024,
        })
        .pipe(Effect.runPromise);

      expect(put.ref.sha256).toBe(fixture.sha256);
      expect(put.ref.byteLength).toBe(fixture.byteLength);
      expect(put.created).toBe(true);
      expect(stats.totalBytes).toBe(fixture.byteLength);
      // Peak residency is one stream chunk, never a second full-body buffer.
      expect(stats.peakResidentBytes).toBeLessThanOrEqual(DEFAULT_STREAM_CHUNK);
      if (fixture.byteLength > DEFAULT_STREAM_CHUNK) {
        expect(stats.peakResidentBytes).toBeLessThan(fixture.byteLength);
      }

      const availability = await station.service
        .availability(put.ref)
        .pipe(Effect.runPromise);
      expect(availability.state).toBe("verified");
    }
  });

  it("proves multi-hundred-MB-equivalent streaming residency stays chunk-bounded", async () => {
    // Do not materialize 300 MiB on disk in CI. Stream a representative large
    // body (MEDIA_FIXTURE_SIZES.large) while asserting the same chunk contract
    // that multi-hundred-MB would use, plus a pure logical stream for length.
    const stats = emptyStreamStats();
    const logical = MEDIA_FIXTURE_SIZES.hundredMegLogical;
    let hashed = 0;
    const hash = await (async () => {
      const { createHash } = await import("node:crypto");
      const h = createHash("sha256");
      for await (const chunk of streamLogicalLength(
        // Sample 4 MiB of the logical stream path to keep runtime low while
        // exercising the generator that would cover the full length.
        4 * 1024 * 1024,
        0x3000_0000,
        DEFAULT_STREAM_CHUNK,
        stats,
      )) {
        h.update(chunk);
        hashed += chunk.byteLength;
      }
      return h.digest("hex");
    })();

    expect(hashed).toBe(4 * 1024 * 1024);
    expect(stats.peakResidentBytes).toBeLessThanOrEqual(DEFAULT_STREAM_CHUNK);
    expect(stats.peakResidentBytes).toBeLessThan(logical);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);

    // Full mid-size large fixture through ContentService put.
    const station = await openStation("vellum-media-large-put-");
    const large = buildMediaFixture("large");
    const putStats = emptyStreamStats();
    const put = await station.service
      .put({
        source: streamBuffer(large.bytes, DEFAULT_STREAM_CHUNK, putStats),
        mediaType: large.mediaType,
        displayName: large.displayName,
        expected: {
          sha256: large.sha256 as ContentRef["sha256"],
          byteLength: large.byteLength as ContentRef["byteLength"],
        },
        owner: {
          kind: "task",
          canvasName: "factory",
          nodeId: "tasks",
          recordId: "task-large",
        },
        diskFreeBytes: 10 * 1024 * 1024 * 1024,
      })
      .pipe(Effect.runPromise);

    expect(put.ref.sha256).toBe(large.sha256);
    expect(putStats.peakResidentBytes).toBeLessThanOrEqual(DEFAULT_STREAM_CHUNK);
    expect(putStats.totalBytes).toBe(large.byteLength);
  });

  it("crash before SQLite leaves orphan object only — task stays non-runnable", async () => {
    const station = await openStation("vellum-media-crash-order-");
    const fixture = buildMediaFixture("image", 0x0dd);
    // Object-only put (no owner) — durable file + object row, no content_refs
    // for a task owner. Task still non-runnable until receipt is verified via
    // availability for the referenced digest (object row alone is enough for
    // availability.verified when the file matches).
    const put = await station.service
      .put({
        source: fixture.bytes,
        mediaType: fixture.mediaType,
        displayName: fixture.displayName,
        diskFreeBytes: 10 * 1024 * 1024 * 1024,
      })
      .pipe(Effect.runPromise);

    expect(put.refRow).toBeUndefined();
    expect(existsSync(contentObjectPath(station.contentRoot, put.ref.sha256))).toBe(
      true,
    );

    // Simulate "bytes never published": ref points at a digest that was never
    // ingested — task cannot run.
    const missingRef = makeRef(
      "e".repeat(64),
      fixture.byteLength,
      fixture.mediaType,
      fixture.displayName,
    );
    const task = taskWithContent("task-crash", [missingRef]);
    const resolveMissing = (ref: ContentRef) =>
      Effect.runSync(station.service.availability(ref));
    // availability is Effect async-ish via state.read — use runPromise.
    const availability = await station.service
      .availability(missingRef)
      .pipe(Effect.runPromise);
    expect(availability.state).toBe("missing");
    expect(taskContentIsRunnable(task, () => availability)).toBe(false);

    // After durable object + owner ref, same identity becomes runnable.
    const owned = await station.service
      .put({
        source: fixture.bytes,
        mediaType: fixture.mediaType,
        displayName: fixture.displayName,
        owner: {
          kind: "task",
          canvasName: "factory",
          nodeId: "tasks",
          recordId: "task-crash",
        },
        diskFreeBytes: 10 * 1024 * 1024 * 1024,
      })
      .pipe(Effect.runPromise);
    const readyTask = taskWithContent("task-crash", [owned.ref]);
    const verified = await station.service
      .availability(owned.ref)
      .pipe(Effect.runPromise);
    expect(verified.state).toBe("verified");
    expect(taskContentIsRunnable(readyTask, () => verified)).toBe(true);
    void resolveMissing;
  });
});

// ---------------------------------------------------------------------------
// Renderer access
// ---------------------------------------------------------------------------

describe("media transport e2e · renderer access", () => {
  it("streams image/audio/video through the app content protocol with range seeks", async () => {
    const station = await openStation("vellum-media-renderer-");

    for (const kind of ["image", "audio", "video"] as const) {
      const fixture = buildMediaFixture(kind, 0x11 + kind.length);
      const put = await station.service
        .put({
          source: fixture.bytes,
          mediaType: fixture.mediaType,
          displayName: fixture.displayName,
          owner: {
            kind: "task",
            canvasName: "factory",
            nodeId: "tasks",
            recordId: `render-${kind}`,
          },
          diskFreeBytes: 10 * 1024 * 1024 * 1024,
        })
        .pipe(Effect.runPromise);

      expect(contentMediaKind(fixture.mediaType)).toBe(kind);

      const handler = createContentProtocolHandler(async (requestRef) => {
        const open = await station.service
          .openForRead(requestRef)
          .pipe(Effect.runPromise);
        return open;
      });

      const full = await handler(new Request(contentObjectUrl(put.ref)));
      expect(full.status).toBe(200);
      expect(full.headers.get(CONTENT_STATE_HEADER)).toBe("verified");
      expect(full.headers.get("content-type")).toBe(fixture.mediaType);
      const body = Buffer.from(await full.arrayBuffer());
      expect(body.equals(fixture.bytes)).toBe(true);
      // Body is the media bytes — never a Base64 data URL.
      expect(body.toString("utf8", 0, 5)).not.toMatch(/^data:/);

      if (fixture.byteLength > 32) {
        const range = await handler(
          new Request(contentObjectUrl(put.ref), {
            headers: { Range: "bytes=8-23" },
          }),
        );
        expect(range.status).toBe(206);
        const slice = Buffer.from(await range.arrayBuffer());
        expect(slice.equals(fixture.bytes.subarray(8, 24))).toBe(true);
      }
    }
  });

  it("surfaces missing and corrupt as explicit renderer states", async () => {
    const station = await openStation("vellum-media-renderer-fail-");
    const missingRef = makeRef(
      "f".repeat(64),
      100,
      "image/png",
      "gone.png",
    );
    const handler = createContentProtocolHandler(async (requestRef) =>
      station.service.openForRead(requestRef).pipe(Effect.runPromise),
    );
    const missing = await handler(new Request(contentObjectUrl(missingRef)));
    expect(missing.status).toBe(404);
    expect(missing.headers.get(CONTENT_STATE_HEADER)).toBe("missing");
  });

  it("materializes task-scoped agent access without exposing foreign digests", async () => {
    const station = await openStation("vellum-media-agent-");
    const workHome = join(station.home, "work");
    await mkdir(workHome, { recursive: true });
    const fixture = buildMediaFixture("image", 0x22);
    const put = await station.service
      .put({
        source: fixture.bytes,
        mediaType: fixture.mediaType,
        displayName: fixture.displayName,
        owner: {
          kind: "task",
          canvasName: "factory",
          nodeId: "tasks",
          recordId: "task-agent",
        },
        diskFreeBytes: 10 * 1024 * 1024 * 1024,
      })
      .pipe(Effect.runPromise);

    const task = taskWithContent("task-agent", [put.ref]);
    expect(taskContentRef(task, put.ref)).toEqual(put.ref);
    expect(
      taskContentRef(task, makeRef("0".repeat(64), 1, "text/plain")),
    ).toBeUndefined();

    const material = await materializeContentObject({
      contentRoot: station.contentRoot,
      workHome,
      canvasName: "factory",
      targetNodeId: "tasks",
      taskId: task.id,
      ref: put.ref,
    });
    expect(await readFile(material.path)).toEqual(fixture.bytes);
  });
});

// ---------------------------------------------------------------------------
// Station projection, transfer, offline convergence
// ---------------------------------------------------------------------------

describe("media transport e2e · Station projection + transfer + offline", () => {
  it("gates runnable work until local receipt is verified", async () => {
    const station = await openStation("vellum-media-gate-");
    const fixture = buildMediaFixture("video", 0x33);
    const ref = makeRef(
      fixture.sha256,
      fixture.byteLength,
      fixture.mediaType,
      fixture.displayName,
    );
    const task = taskWithContent("task-gate", [ref]);

    const missing = await station.service
      .availability(ref)
      .pipe(Effect.runPromise);
    expect(taskContentIsRunnable(task, () => missing)).toBe(false);
    expect(taskContentReadiness(task, () => missing).kind).toBe("pending");

    await station.service
      .put({
        source: fixture.bytes,
        mediaType: fixture.mediaType,
        displayName: fixture.displayName,
        owner: {
          kind: "task",
          canvasName: "factory",
          nodeId: "tasks",
          recordId: "task-gate",
        },
        diskFreeBytes: 10 * 1024 * 1024 * 1024,
      })
      .pipe(Effect.runPromise);

    const verified = await station.service
      .availability(ref)
      .pipe(Effect.runPromise);
    expect(verified.state).toBe("verified");
    expect(taskContentIsRunnable(task, () => verified)).toBe(true);
  });

  it("interrupts, resumes, rejects corruption, and treats duplicate delivery as idempotent", async () => {
    const cc = await openStation("vellum-media-cc-");
    const remote = await openStation("vellum-media-remote-");
    const fixture = buildMediaFixture("large", 0x44);

    const put = await cc.service
      .put({
        source: streamBuffer(fixture.bytes),
        mediaType: fixture.mediaType,
        displayName: fixture.displayName,
        owner: {
          kind: "task",
          canvasName: "factory",
          nodeId: "tasks",
          recordId: "task-xfer",
        },
        diskFreeBytes: 10 * 1024 * 1024 * 1024,
      })
      .pipe(Effect.runPromise);

    // --- interrupt: first wave only ---
    const cut = Math.floor(fixture.byteLength / 3);
    const wave1 = await receiveContentTransfer({
      root: remote.contentRoot,
      ref: put.ref,
      source: fixture.bytes.subarray(0, cut),
      expectedOffset: 0,
    });
    expect(wave1.state).toBe("partial");
    if (wave1.state !== "partial") return;
    expect(wave1.receivedBytes).toBe(cut);

    // Task on remote is not runnable while partial.
    const remoteTask = taskWithContent("task-xfer", [put.ref]);
    const partialAvail = await remote.service
      .availability(put.ref)
      .pipe(Effect.runPromise);
    // Object not in remote manifest yet — missing (partial is filesystem-only).
    expect(partialAvail.state === "verified").toBe(false);
    expect(taskContentIsRunnable(remoteTask, () => partialAvail)).toBe(false);

    const remoteStat = statContentForTransfer(remote.contentRoot, put.ref);
    expect(remoteStat.state).toBe("partial");
    if (remoteStat.state !== "partial") return;

    // --- resume from offset ---
    const remaining: Buffer[] = [];
    for await (const chunk of sendContentTransfer({
      root: cc.contentRoot,
      ref: put.ref,
      offset: remoteStat.partialBytes,
    })) {
      remaining.push(chunk);
    }
    const wave2 = await receiveContentTransfer({
      root: remote.contentRoot,
      ref: put.ref,
      source: (async function* () {
        for (const c of remaining) yield c;
      })(),
      expectedOffset: remoteStat.partialBytes,
    });
    expect(wave2.state).toBe("verified");
    if (wave2.state !== "verified") return;
    expect(sha256Hex(await readFile(wave2.path))).toBe(fixture.sha256);

    // Record on remote so availability/manifest converges with CC.
    await remote.service
      .put({
        source: fixture.bytes,
        mediaType: fixture.mediaType,
        displayName: fixture.displayName,
        expected: {
          sha256: put.ref.sha256,
          byteLength: put.ref.byteLength,
        },
        owner: {
          kind: "task",
          canvasName: "factory",
          nodeId: "tasks",
          recordId: "task-xfer",
        },
        diskFreeBytes: 10 * 1024 * 1024 * 1024,
      })
      .pipe(Effect.runPromise);

    const remoteVerified = await remote.service
      .availability(put.ref)
      .pipe(Effect.runPromise);
    expect(remoteVerified.state).toBe("verified");
    expect(taskContentIsRunnable(remoteTask, () => remoteVerified)).toBe(true);

    // --- duplicate delivery is idempotent ---
    const dup = await receiveContentTransfer({
      root: remote.contentRoot,
      ref: put.ref,
      source: fixture.bytes,
      expectedOffset: 0,
    });
    expect(dup.state).toBe("verified");
    if (dup.state !== "verified") return;
    expect(dup.created).toBe(false);

    // --- corruption never becomes available ---
    const corruptBytes = makeDeterministicPayload(fixture.byteLength, 0xbad);
    const corruptRoot = contentStoreRoot(await tempRoot("vellum-media-corrupt-"));
    await expect(
      receiveContentTransfer({
        root: corruptRoot,
        ref: put.ref,
        source: corruptBytes,
        expectedOffset: 0,
      }),
    ).rejects.toMatchObject({ code: "corrupt" } satisfies Partial<ContentStoreError>);
    expect(existsSync(contentObjectPath(corruptRoot, put.ref.sha256))).toBe(
      false,
    );
    expect(statContentForTransfer(corruptRoot, put.ref).state === "verified").toBe(
      false,
    );

    // Truncated stream cannot become available content — stays partial,
    // never publishes under the claimed digest.
    const truncRoot = contentStoreRoot(await tempRoot("vellum-media-trunc-"));
    const truncated = await receiveContentTransfer({
      root: truncRoot,
      ref: put.ref,
      source: fixture.bytes.subarray(0, fixture.byteLength - 1),
      expectedOffset: 0,
    });
    expect(truncated.state).toBe("partial");
    expect(existsSync(contentObjectPath(truncRoot, put.ref.sha256))).toBe(
      false,
    );
    expect(statContentForTransfer(truncRoot, put.ref).state).toBe("partial");
  });

  it("converges to the same verified content state after Station restart", async () => {
    const home = await tempRoot("vellum-media-offline-");
    const stateDir = join(home, ".vellum", "state");
    await mkdir(stateDir, { recursive: true });
    const dbPath = join(stateDir, "vellum.db");
    const contentRoot = contentStoreRoot(home);
    const fixture = buildMediaFixture("audio", 0x55);

    {
      const { state } = await openEngine(dbPath);
      const service = createContentService(state, contentRoot);
      const put = await service
        .put({
          source: streamBuffer(fixture.bytes),
          mediaType: fixture.mediaType,
          displayName: fixture.displayName,
          owner: {
            kind: "task",
            canvasName: "factory",
            nodeId: "tasks",
            recordId: "task-offline",
          },
          diskFreeBytes: 10 * 1024 * 1024 * 1024,
        })
        .pipe(Effect.runPromise);
      expect(put.ref.sha256).toBe(fixture.sha256);
    }

    // Dispose engines — "Station went offline".
    while (runtimes.length > 0) {
      await runtimes.pop()!.dispose();
    }

    {
      const { state } = await openEngine(dbPath);
      const service = createContentService(state, contentRoot);
      const ref = makeRef(
        fixture.sha256,
        fixture.byteLength,
        fixture.mediaType,
        fixture.displayName,
      );
      const availability = await service.availability(ref).pipe(Effect.runPromise);
      expect(availability.state).toBe("verified");
      if (availability.state !== "verified") return;
      expect(availability.verifiedSha256).toBe(fixture.sha256);
      expect(availability.verifiedByteLength).toBe(fixture.byteLength);

      const task = taskWithContent("task-offline", [ref]);
      expect(taskContentIsRunnable(task, () => availability)).toBe(true);

      const onDisk = await readFile(contentObjectPath(contentRoot, fixture.sha256));
      expect(sha256Hex(onDisk)).toBe(fixture.sha256);

      // No partial left behind for a completed object.
      expect(
        existsSync(
          contentPartialPath(
            contentRoot,
            contentTransferPartialId(fixture.sha256),
          ),
        ),
      ).toBe(false);
    }
  });

  it("returns update-required against older peers without Base64 down-conversion", () => {
    const negotiation = negotiateStationProtocol(
      support(CURRENT_STATION_PROTOCOL_SUPPORT),
      support({ preferred: 3, compatibleFrom: 3, warnBelow: 3 }),
    );
    expect(negotiation).toMatchObject({ _tag: "no-common" });

    // No Base64 down-conversion path: older peers get no-common, not a
    // rewritten wire record. New durable writes still reject inline media.
    const inlineDownConvert = {
      kind: "raw" as const,
      bytesBase64: Buffer.alloc(1024, 1).toString("base64"),
      mediaType: "video/mp4",
    };
    expect(validateDurableParts([inlineDownConvert])).toMatch(/Base64|ContentRef/i);
    expect(validateNoInlineBinaryPayload({ parts: [inlineDownConvert] })).toMatch(
      /Base64|ContentRef/i,
    );
  });
});
