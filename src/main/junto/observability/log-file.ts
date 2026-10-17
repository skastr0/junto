import { chmodSync, closeSync, fchmodSync, fstatSync, mkdirSync, openSync, renameSync, writeSync } from "node:fs";
import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Effect, Option, Schema } from "effect";
import {
  failureDetailNamesSeat,
  failureDetailSeat,
  LOG_READ_DEFAULT_LIMIT,
  MachineLogRow,
  matchesMachineLogQuery,
  type LogProcess,
  type MachineLogQuery,
  type MachineLogRead,
} from "@shared/machine-log";

/**
 * The machine log on disk: `<home>/.junto/logs/<process>.jsonl`, one JSON row
 * per line, rotated to `<process>.1.jsonl` .. `<process>.4.jsonl`. The
 * directory is 0700 and every file 0600 (docs/security-doctrine.md, Logs).
 * One process writes each file: the app writes `app`, a windowless core
 * writes `core`, so rotation never races another writer.
 */

export const MACHINE_LOG_FILE_BYTES = 4 * 1024 * 1024;
export const MACHINE_LOG_KEPT_FILES = 4;

export const machineLogDir = (home: string): string => join(home, ".junto", "logs");

const fileName = (process: LogProcess, generation: number): string =>
  generation === 0 ? `${process}.jsonl` : `${process}.${generation}.jsonl`;

const LOG_FILE = /^(?:app|core)(?:\.[1-9])?\.jsonl$/u;

export type MachineLogSink = {
  readonly path: string;
  /** Appends one serialized row; the line must already be bounded. */
  readonly write: (line: string) => void;
  readonly close: () => void;
};

export type MachineLogSinkOptions = {
  readonly home: string;
  readonly process: LogProcess;
  readonly maxFileBytes?: number;
  readonly keptFiles?: number;
  /** A write that failed. Reported once until a write succeeds again. */
  readonly onWriteFailure?: (cause: unknown) => void;
};

export const openMachineLogSink = (options: MachineLogSinkOptions): MachineLogSink => {
  const dir = machineLogDir(options.home);
  const path = join(dir, fileName(options.process, 0));
  const maxFileBytes = options.maxFileBytes ?? MACHINE_LOG_FILE_BYTES;
  const keptFiles = options.keptFiles ?? MACHINE_LOG_KEPT_FILES;
  let fd: number | undefined;
  let size = 0;
  let failing = false;

  const open = (): number => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    const opened = openSync(path, "a", 0o600);
    fchmodSync(opened, 0o600);
    size = fstatSync(opened).size;
    fd = opened;
    return opened;
  };

  const rotate = (): void => {
    if (fd !== undefined) closeSync(fd);
    fd = undefined;
    for (let generation = keptFiles - 1; generation >= 0; generation -= 1) {
      try {
        renameSync(join(dir, fileName(options.process, generation)), join(dir, fileName(options.process, generation + 1)));
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
      }
    }
  };

  const write = (line: string): void => {
    try {
      const bytes = Buffer.byteLength(line, "utf8") + 1;
      if (fd !== undefined && size > 0 && size + bytes > maxFileBytes) rotate();
      const target = fd ?? open();
      writeSync(target, `${line}\n`);
      size += bytes;
      failing = false;
    } catch (cause) {
      if (fd !== undefined) {
        try { closeSync(fd); } catch { /* the descriptor is already gone; the next write reopens */ }
      }
      fd = undefined;
      if (!failing) options.onWriteFailure?.(cause);
      failing = true;
    }
  };

  const close = (): void => {
    if (fd === undefined) return;
    closeSync(fd);
    fd = undefined;
  };

  return { path, write, close };
};

export class MachineLogReadError extends Schema.TaggedError<MachineLogReadError>()("MachineLogReadError", {
  path: Schema.String,
  code: Schema.optionalKey(Schema.String),
  message: Schema.String,
}) {}

const decodeRow = Schema.decodeUnknownOption(MachineLogRow, { onExcessProperty: "error" });

/** Keeps the newest `limit` matches of one file in time order. */
const readFileMatches = (path: string, query: MachineLogQuery, limit: number, admit: (row: MachineLogRow) => boolean) =>
  Effect.tryPromise({
    try: async () => {
      const kept: MachineLogRow[] = [];
      let matched = 0;
      let unreadable = 0;
      const lines = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
      for await (const line of lines) {
        if (line.length === 0) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          unreadable += 1;
          continue;
        }
        const row = decodeRow(parsed);
        if (Option.isNone(row)) {
          unreadable += 1;
          continue;
        }
        if (!admit(row.value) || !matchesMachineLogQuery(row.value, query)) continue;
        matched += 1;
        kept.push(row.value);
        if (kept.length > limit) kept.shift();
      }
      return { kept, matched, unreadable };
    },
    catch: (cause) => new MachineLogReadError({
      path,
      ...((cause as NodeJS.ErrnoException).code === undefined ? {} : { code: (cause as NodeJS.ErrnoException).code! }),
      message: "a machine log file could not be read",
    }),
  });

/**
 * The newest rows of this machine's log that match `query`, oldest first.
 * `admit` is the caller's scope; it runs before the limit, so a row the
 * caller may not see never takes the place of one it may.
 */
export const readMachineLog = Effect.fn("readMachineLog")(function* (
  home: string,
  machine: string,
  query: MachineLogQuery,
  admit: (row: MachineLogRow) => boolean = () => true,
) {
  const dir = machineLogDir(home);
  const limit = query.limit ?? LOG_READ_DEFAULT_LIMIT;
  const names = yield* Effect.tryPromise({
    try: () => readdir(dir),
    catch: (cause) => cause as NodeJS.ErrnoException,
  }).pipe(
    Effect.catch((cause) => cause.code === "ENOENT"
      ? Effect.succeed([] as string[])
      : Effect.fail(new MachineLogReadError({ path: dir, ...(cause.code === undefined ? {} : { code: cause.code }), message: "the machine log directory could not be read" }))),
  );
  const files = names.filter((name) => LOG_FILE.test(name));
  const results = yield* Effect.forEach(files, (name) => readFileMatches(join(dir, name), query, limit, admit).pipe(
    // A file rotated away between the listing and the read held nothing we can still show.
    Effect.catchIf((error) => error.code === "ENOENT", () => Effect.succeed({ kept: [], matched: 0, unreadable: 0 })),
  ), { concurrency: 1 });
  const rows = results.flatMap((result) => result.kept).sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
  const matched = results.reduce((total, result) => total + result.matched, 0);
  return {
    machine,
    rows: rows.slice(-limit),
    cut: matched > limit,
    unreadable: results.reduce((total, result) => total + result.unreadable, 0),
  } satisfies MachineLogRead;
});

/**
 * What a seat may read (docs/security-doctrine.md, Logs): its own rows, rows
 * for seats it holds `terminal.read` to, and rows that name no seat.
 */
export const seatLogScope = (visibleSeats: ReadonlySet<string>) => (row: MachineLogRow): boolean => {
  // A row written before its seat was lifted from the failure detail still
  // answers to the seat that detail names.
  const fromDetail = failureDetailSeat(row.failure);
  // A detail that names a seat this reader cannot validate fails closed.
  if (fromDetail === undefined && failureDetailNamesSeat(row.failure)) return false;
  const named: ReadonlyArray<string | undefined> = [row.seat, fromDetail];
  return named.every((seat) => seat === undefined || visibleSeats.has(seat));
};
