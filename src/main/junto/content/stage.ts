import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  createReadStream,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  rmSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import {
  CONTENT_STAGE_IDLE_MS,
  CONTENT_STAGE_MAX_OPEN_PER_SEAT,
  CONTENT_STAGE_OWNER_PREFIX,
  CONTENT_STAGE_PIECE_BYTES,
  CONTENT_STAGE_UNCLAIMED_MS,
  type ContentStageArgs,
  type ContentStageResult,
} from "@shared/content-stage";
import type { ContentOwner, ContentRefRow } from "./manifest";
import type { ContentServiceShape } from "./service";
import { ContentStoreError } from "./store";

/**
 * Staging: a seat's file on its way into the content store.
 *
 * Pieces are appended to one private file per upload, under the content
 * root and beside the store's own tree. On `done` the file is streamed
 * through `ContentService.put`, which hashes it, admits it against free
 * disk, publishes the object and binds a `stage:` owner. The staging file
 * is then removed. Whoever the file was for (a signal, today) claims the
 * reference with `claimStagedContent`, which swaps the `stage:` owner for
 * its own.
 *
 * Nothing is left behind. An upload with no new piece for an hour is
 * dropped. Every open upload is dropped when the app starts: what is open
 * is known only to this process. A finished upload nobody claimed keeps
 * its `stage:` owner for an hour, then lets go, and the store's garbage
 * collection takes the bytes after its own grace.
 *
 * No error from here names a path on the operator's disk or repeats a byte
 * of content.
 */

/** The seat a staged file belongs to: the process-bound caller, never an argument. */
export type ContentStageSeat = {
  readonly canvasName: string;
  readonly nodeId: string;
};

export type ContentStageErrorCode =
  /** The caller sent something that cannot be staged. */
  | "invalid"
  /** No such upload for this seat. */
  | "not-found"
  /** The seat already holds the most uploads it may. */
  | "too-many"
  /** The bytes did not match what the caller said they were. */
  | "mismatch"
  /** Not enough free disk. Trying again later may work. */
  | "disk-low"
  /** The store could not take the file. */
  | "failed";

export class ContentStageError extends Error {
  readonly code: ContentStageErrorCode;

  constructor(code: ContentStageErrorCode, message: string) {
    super(message);
    this.name = "ContentStageError";
    this.code = code;
  }
}

/** The reference is not one this seat staged, or it was already claimed. */
export class NotStagedByCaller extends Error {
  readonly _tag = "NotStagedByCaller";

  constructor() {
    super("that file was not uploaded by this seat, or it was already used");
    this.name = "NotStagedByCaller";
  }
}

export const contentStagingDir = (root: string): string => join(root, "staging");

/** The owner a finished upload is held by until a record claims it. */
export const contentStageOwner = (
  seat: ContentStageSeat,
  stageId: string,
): ContentOwner => ({
  kind: "other",
  canvasName: seat.canvasName,
  nodeId: seat.nodeId,
  recordId: `${CONTENT_STAGE_OWNER_PREFIX}${stageId}`,
});

const stagedBy = (seat: ContentStageSeat) => (owner: ContentOwner): boolean =>
  owner.kind === "other" &&
  owner.canvasName === seat.canvasName &&
  owner.nodeId === seat.nodeId &&
  owner.recordId.startsWith(CONTENT_STAGE_OWNER_PREFIX);

/**
 * Bind `owner` to a reference the calling seat staged, and let the stage
 * owner go. The reference bound is the one main recorded at staging (its
 * media type and name), whatever the caller's copy says. Fails with
 * `NotStagedByCaller` when this seat staged no such bytes, or they were
 * already claimed.
 */
export const claimStagedContent = (
  content: Pick<ContentServiceShape, "moveRef">,
  input: {
    readonly canvasName: string;
    readonly nodeId: string;
    /** Which bytes. A `ContentRef` fits; its type and name are not trusted. */
    readonly ref: { readonly sha256: string; readonly byteLength: number };
    readonly owner: ContentOwner;
  },
) =>
  content
    .moveRef({
      ref: input.ref,
      from: stagedBy({ canvasName: input.canvasName, nodeId: input.nodeId }),
      to: input.owner,
    })
    .pipe(
      Effect.flatMap(
        (row): Effect.Effect<ContentRefRow, NotStagedByCaller> =>
          row === undefined ? Effect.fail(new NotStagedByCaller()) : Effect.succeed(row),
      ),
    );

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const STAGE_SUFFIX = ".stage";
// Checked without nested repetition: a piece is megabytes of text.
const BASE64_ALPHABET = /^[A-Za-z0-9+/]*={0,2}$/u;

const createFlags =
  constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0);
const appendFlags =
  constants.O_WRONLY | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0);

type OpenStage = {
  readonly stageId: string;
  readonly seat: ContentStageSeat;
  readonly path: string;
  byteLength: number;
  lastPieceAt: number;
  /** A piece is being written, or the upload is being closed. */
  busy: boolean;
};

const refuse = (code: ContentStageErrorCode, message: string) =>
  Effect.fail(new ContentStageError(code, message));

const decodePiece = (
  bytesBase64: string,
): Effect.Effect<Buffer, ContentStageError> => {
  const notBase64 = refuse("invalid", "bytesBase64 is not standard Base64");
  if (bytesBase64.length % 4 !== 0 || !BASE64_ALPHABET.test(bytesBase64)) {
    return notBase64;
  }
  const bytes = Buffer.from(bytesBase64, "base64");
  // The decoder forgives what it cannot read; only an exact round trip is
  // the bytes the caller meant.
  if (bytes.toString("base64") !== bytesBase64) return notBase64;
  return bytes.length > CONTENT_STAGE_PIECE_BYTES
    ? refuse(
        "invalid",
        `a piece carries at most ${String(CONTENT_STAGE_PIECE_BYTES)} bytes; send the file in more pieces`,
      )
    : Effect.succeed(bytes);
};

/** What the store said, in words that name no path and no content. */
const storeRefusal = (error: unknown): ContentStageError => {
  const code = error instanceof ContentStoreError ? error.code : undefined;
  if (code === "corrupt") {
    return new ContentStageError(
      "mismatch",
      "the uploaded bytes do not match the expected digest and length; nothing was kept",
    );
  }
  if (code === "disk-low") {
    return new ContentStageError(
      "disk-low",
      "there is not enough free disk space to keep this file",
    );
  }
  if (code === "invalid") {
    return new ContentStageError("invalid", "the media type or the name is not valid");
  }
  return new ContentStageError("failed", "the file could not be stored");
};

export type ContentStager = {
  /** One `content.stage` call for the seat the caller is bound to. */
  readonly stage: (
    seat: ContentStageSeat,
    args: ContentStageArgs,
  ) => Effect.Effect<ContentStageResult, ContentStageError>;
  /** Drop idle uploads and let go of finished ones nobody claimed. */
  readonly sweep: () => Effect.Effect<void>;
  /** How many uploads a seat has open. */
  readonly openCount: (seat: ContentStageSeat) => number;
};

export const makeContentStager = (
  content: ContentServiceShape,
  options: { readonly now?: () => number } = {},
): ContentStager => {
  const now = options.now ?? Date.now;
  const dir = contentStagingDir(content.root);
  const open = new Map<string, OpenStage>();

  const ensureDir = (): void => {
    mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    const info = lstatSync(dir);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error("content staging is not a real directory");
    }
  };

  // What is open is known only to this process: a file found here at start
  // belongs to an upload nobody can continue.
  try {
    ensureDir();
    for (const name of readdirSync(dir)) {
      if (name.endsWith(STAGE_SUFFIX)) rmSync(join(dir, name), { force: true });
    }
  } catch {
    // Staging is created again, and refused in plain words, at first use.
  }

  const drop = (stage: OpenStage): void => {
    open.delete(stage.stageId);
    try {
      rmSync(stage.path, { force: true });
    } catch {
      // Left for the next start to remove.
    }
  };

  const dropIdle = (): void => {
    const cutoff = now() - CONTENT_STAGE_IDLE_MS;
    for (const stage of [...open.values()]) {
      if (!stage.busy && stage.lastPieceAt < cutoff) drop(stage);
    }
  };

  const openCount = (seat: ContentStageSeat): number =>
    [...open.values()].filter(
      (stage) =>
        stage.seat.canvasName === seat.canvasName && stage.seat.nodeId === seat.nodeId,
    ).length;

  const begin = (seat: ContentStageSeat): Effect.Effect<OpenStage, ContentStageError> =>
    Effect.suspend(() => {
      if (openCount(seat) >= CONTENT_STAGE_MAX_OPEN_PER_SEAT) {
        return refuse(
          "too-many",
          `this seat has ${String(CONTENT_STAGE_MAX_OPEN_PER_SEAT)} uploads open; finish one or wait for the unfinished ones to expire`,
        );
      }
      const stageId = `stg_${randomBytes(16).toString("hex")}`;
      const path = join(dir, `${stageId}${STAGE_SUFFIX}`);
      return Effect.try({
        try: () => {
          ensureDir();
          closeSync(openSync(path, createFlags, FILE_MODE));
          const stage: OpenStage = {
            stageId,
            seat,
            path,
            byteLength: 0,
            lastPieceAt: now(),
            busy: false,
          };
          open.set(stageId, stage);
          return stage;
        },
        catch: () => new ContentStageError("failed", "the upload could not be started"),
      });
    });

  /** A stage id is only ever answered to the seat that opened it. */
  const find = (
    seat: ContentStageSeat,
    stageId: string,
  ): Effect.Effect<OpenStage, ContentStageError> => {
    const stage = open.get(stageId);
    return stage === undefined ||
      stage.seat.canvasName !== seat.canvasName ||
      stage.seat.nodeId !== seat.nodeId
      ? refuse(
          "not-found",
          "no such upload is open for this seat; it may have expired, start the file over",
        )
      : Effect.succeed(stage);
  };

  const append = (stage: OpenStage, bytes: Buffer): Effect.Effect<void, ContentStageError> =>
    Effect.try({
      try: () => {
        if (bytes.length > 0) {
          const fd = openSync(stage.path, appendFlags);
          try {
            let written = 0;
            while (written < bytes.length) {
              written += writeSync(fd, bytes, written, bytes.length - written);
            }
          } finally {
            closeSync(fd);
          }
        }
        stage.byteLength += bytes.length;
        stage.lastPieceAt = now();
      },
      catch: () => new ContentStageError("failed", "the piece could not be written"),
    }).pipe(
      // A piece that did not land whole leaves the file in an unknown state.
      Effect.tapError(() => Effect.sync(() => drop(stage))),
    );

  const close = (
    stage: OpenStage,
    done: NonNullable<ContentStageArgs["done"]>,
  ): Effect.Effect<ContentStageResult, ContentStageError> =>
    Effect.gen(function* () {
      yield* Effect.try({
        try: () => {
          const fd = openSync(stage.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
          try {
            fsyncSync(fd);
          } finally {
            closeSync(fd);
          }
        },
        catch: () => new ContentStageError("failed", "the file could not be stored"),
      });
      const put = yield* content
        .put({
          source: createReadStream(stage.path),
          mediaType: done.mediaType,
          ...(done.displayName === undefined ? {} : { displayName: done.displayName }),
          ...(done.expected === undefined ? {} : { expected: done.expected }),
          owner: contentStageOwner(stage.seat, stage.stageId),
        })
        .pipe(Effect.mapError(storeRefusal));
      return { ref: put.ref };
    }).pipe(
      // Closed or failed, the upload is over: a failed one is started again.
      Effect.ensuring(Effect.sync(() => drop(stage))),
    );

  let lastUnclaimedSweepAt = 0;
  const sweep = (): Effect.Effect<void> =>
    Effect.suspend(() => {
      dropIdle();
      const at = now();
      // The manifest is asked at most once a minute, however busy staging is.
      if (at - lastUnclaimedSweepAt < 60_000) return Effect.void;
      lastUnclaimedSweepAt = at;
      return content
        .releaseByRecordPrefixBefore({
          prefix: CONTENT_STAGE_OWNER_PREFIX,
          before: new Date(at - CONTENT_STAGE_UNCLAIMED_MS).toISOString(),
        })
        .pipe(Effect.ignore);
    });

  const stage: ContentStager["stage"] = (seat, args) =>
    Effect.gen(function* () {
      yield* sweep();
      const bytes =
        args.bytesBase64 === undefined ? undefined : yield* decodePiece(args.bytesBase64);
      const target =
        args.stageId === undefined ? yield* begin(seat) : yield* find(seat, args.stageId);
      if (target.busy) {
        return yield* refuse(
          "invalid",
          "a piece of this upload is still being written; send the pieces one after another",
        );
      }
      target.busy = true;
      return yield* Effect.gen(function* () {
        if (bytes !== undefined) yield* append(target, bytes);
        if (args.done !== undefined) return yield* close(target, args.done);
        return { stageId: target.stageId, byteLength: target.byteLength };
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            target.busy = false;
          }),
        ),
      );
    });

  return { stage, sweep, openCount };
};

const stagers = new WeakMap<ContentServiceShape, ContentStager>();

/** How often the process sweeps on its own, with no upload to prompt it. */
const SWEEP_EVERY_MS = 10 * 60 * 1000;

/**
 * The stager of this process for one content service. Made at first use:
 * that is when the staging folder is emptied and the sweep starts ticking.
 */
export const contentStagerFor = (content: ContentServiceShape): ContentStager => {
  const existing = stagers.get(content);
  if (existing !== undefined) return existing;
  const stager = makeContentStager(content);
  stagers.set(content, stager);
  const timer = setInterval(() => {
    Effect.runFork(stager.sweep());
  }, SWEEP_EVERY_MS);
  timer.unref();
  return stager;
};
