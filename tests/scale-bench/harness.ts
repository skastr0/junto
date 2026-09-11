/**
 * Scale-benchmark harness.
 *
 * Measures the real main-thread read path (CanvasesService.read →
 * readCanvasWorkProjection → loadSnapshot) against a real SQLite database,
 * through the real product services. Nothing here reimplements product logic:
 * the only added machinery is a StateEngine proxy that brackets each
 * `state.read` / `state.transaction` body so the SYNCHRONOUS block those
 * bodies occupy on the main thread can be timed, and (opt-in) each SQL
 * statement inside it counted.
 *
 * The proxy is transparent when `mode === "off"`: the raw reader is handed to
 * the body, so a timing pass carries no instrumentation overhead.
 */
import { Effect, Layer } from "effect";
import {
  StateEngine,
  type StateBindings,
  type StateReader,
  type StateRow,
  type StateWriter,
} from "../../src/main/vellum-command/state/service";
import { makeStateEngineLive } from "../../src/main/vellum-command/state/engine";

export type RecorderMode = "off" | "frames" | "statements";

/** One `state.read` / `state.transaction` body — one synchronous main-thread block. */
export type Frame = {
  readonly operation: string;
  readonly kind: "read" | "transaction";
  readonly ms: number;
  readonly statements: number;
  readonly gets: number;
  readonly alls: number;
  readonly runs: number;
  readonly rows: number;
};

export type StatementStat = {
  readonly sql: string;
  readonly kind: "get" | "all" | "run";
  readonly calls: number;
  readonly ms: number;
  readonly rows: number;
};

type OpenFrame = {
  operation: string;
  kind: "read" | "transaction";
  statements: number;
  gets: number;
  alls: number;
  runs: number;
  rows: number;
};

const normalizeSql = (sql: string): string =>
  sql.replace(/\s+/g, " ").trim().slice(0, 160);

/**
 * Statement + frame recorder. One instance per benchmarked database.
 */
export class SqlRecorder {
  mode: RecorderMode = "off";
  readonly frames: Array<Frame> = [];
  private readonly statementStats = new Map<string, StatementStat>();
  private readonly stack: Array<OpenFrame> = [];

  reset(mode: RecorderMode): void {
    this.mode = mode;
    this.frames.length = 0;
    this.statementStats.clear();
    this.stack.length = 0;
  }

  statements(): ReadonlyArray<StatementStat> {
    return [...this.statementStats.values()].sort((a, b) => b.ms - a.ms);
  }

  framesFor(operation: string): ReadonlyArray<Frame> {
    return this.frames.filter((frame) => frame.operation === operation);
  }

  private countStatement(
    kind: "get" | "all" | "run",
    sql: string,
    startedAt: number,
    rows: number,
  ): void {
    const open = this.stack[this.stack.length - 1];
    if (open !== undefined) {
      open.statements += 1;
      open.rows += rows;
      if (kind === "get") open.gets += 1;
      else if (kind === "all") open.alls += 1;
      else open.runs += 1;
    }
    if (this.mode !== "statements") return;
    const key = `${kind} ${normalizeSql(sql)}`;
    const previous = this.statementStats.get(key);
    const ms = performance.now() - startedAt;
    this.statementStats.set(
      key,
      previous === undefined
        ? { sql: normalizeSql(sql), kind, calls: 1, ms, rows }
        : {
            ...previous,
            calls: previous.calls + 1,
            ms: previous.ms + ms,
            rows: previous.rows + rows,
          },
    );
  }

  wrapReader(reader: StateReader): StateReader {
    return {
      get: <Row extends StateRow = StateRow>(
        sql: string,
        bindings?: StateBindings,
      ): Row | undefined => {
        const startedAt = performance.now();
        const row = reader.get<Row>(sql, bindings);
        this.countStatement("get", sql, startedAt, row === undefined ? 0 : 1);
        return row;
      },
      all: <Row extends StateRow = StateRow>(
        sql: string,
        bindings?: StateBindings,
      ): ReadonlyArray<Row> => {
        const startedAt = performance.now();
        const rows = reader.all<Row>(sql, bindings);
        this.countStatement("all", sql, startedAt, rows.length);
        return rows;
      },
    };
  }

  wrapWriter(writer: StateWriter): StateWriter {
    const reader = this.wrapReader(writer);
    return {
      get: reader.get,
      all: reader.all,
      run: (sql: string, bindings?: StateBindings) => {
        const startedAt = performance.now();
        const result = writer.run(sql, bindings);
        this.countStatement("run", sql, startedAt, 0);
        return result;
      },
    };
  }

  /** Bracket one synchronous body; returns its result unchanged. */
  frame<A>(
    operation: string,
    kind: "read" | "transaction",
    body: () => A,
  ): A {
    const open: OpenFrame = {
      operation,
      kind,
      statements: 0,
      gets: 0,
      alls: 0,
      runs: 0,
      rows: 0,
    };
    this.stack.push(open);
    const startedAt = performance.now();
    try {
      return body();
    } finally {
      const ms = performance.now() - startedAt;
      this.stack.pop();
      this.frames.push({ ...open, ms });
    }
  }
}

/**
 * The real StateEngine over `path`, wrapped so every read/transaction body is
 * bracketed by `recorder`. Same node:sqlite driver, pragmas, and statement
 * cache the app uses — only the callback handed to the body changes.
 */
export const makeInstrumentedStateEngineLive = (
  path: string,
  recorder: SqlRecorder,
): ReturnType<typeof makeStateEngineLive> =>
  Layer.effect(
    StateEngine,
    Effect.gen(function* () {
      const inner = yield* StateEngine;
      return StateEngine.of({
        ...inner,
        read: (operation, body) =>
          inner.read(operation, (reader) =>
            recorder.mode === "off"
              ? body(reader)
              : recorder.frame(operation, "read", () =>
                  body(recorder.wrapReader(reader)),
                ),
          ),
        transaction: (operation, body) =>
          inner.transaction(operation, (writer) =>
            recorder.mode === "off"
              ? body(writer)
              : recorder.frame(operation, "transaction", () =>
                  body(recorder.wrapWriter(writer)),
                ),
          ),
      });
    }),
  ).pipe(Layer.provide(makeStateEngineLive(path)));

export type Summary = {
  readonly samples: number;
  readonly meanMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly minMs: number;
  readonly maxMs: number;
  readonly totalMs: number;
};

const round = (value: number, digits = 3): number => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

export const summarize = (values: ReadonlyArray<number>): Summary => {
  if (values.length === 0) {
    return {
      samples: 0,
      meanMs: 0,
      p50Ms: 0,
      p95Ms: 0,
      minMs: 0,
      maxMs: 0,
      totalMs: 0,
    };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  const at = (fraction: number): number =>
    sorted[
      Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))
    ] as number;
  return {
    samples: sorted.length,
    meanMs: round(total / sorted.length),
    p50Ms: round(at(0.5)),
    p95Ms: round(at(0.95)),
    minMs: round(sorted[0] as number),
    maxMs: round(sorted[sorted.length - 1] as number),
    totalMs: round(total),
  };
};

export const roundTo = round;

/**
 * Run `iterations` of an async body, returning wall-clock per-iteration
 * samples plus the process CPU time the whole batch consumed.
 */
export const measure = async (
  iterations: number,
  body: (iteration: number) => Promise<unknown>,
  warmups = 1,
): Promise<{
  readonly wall: Summary;
  readonly cpuMsPerIteration: number;
}> => {
  for (let index = 0; index < warmups; index += 1) await body(-1 - index);
  const samples: Array<number> = [];
  const cpuBefore = process.cpuUsage();
  for (let index = 0; index < iterations; index += 1) {
    const startedAt = performance.now();
    await body(index);
    samples.push(performance.now() - startedAt);
  }
  const cpu = process.cpuUsage(cpuBefore);
  return {
    wall: summarize(samples),
    cpuMsPerIteration: round((cpu.user + cpu.system) / 1000 / Math.max(1, iterations)),
  };
};
