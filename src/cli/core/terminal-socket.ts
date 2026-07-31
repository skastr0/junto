import { readFile } from "node:fs/promises";
import { Context, Effect, Layer } from "effect";
import {
  termControlSocketPath,
  termControlTokenPath,
} from "../../shared/term-control";
import { resolveVellumHome } from "../../shared/vellum-home";
import type { TerminalSessionSummary } from "../../shared/terminal";
import {
  TermControlClient,
} from "../../main/vellum/term/control-client";
import type {
  JournalEntry,
  LocalHostEvent,
} from "../../main/vellum/term/local-host";
import { RuntimeDown, WireError } from "./errors";

export type TerminalAttachedFrame = {
  readonly type: "attached";
  readonly bindingId: string;
  readonly epoch: string;
  readonly status: string;
  readonly cols: number;
  readonly rows: number;
  readonly pid?: number;
  readonly screen?: {
    readonly seq: string;
    readonly serialized: string;
  };
};

export type TerminalEventFrame =
  | {
      readonly type: "output";
      readonly bindingId: string;
      readonly epoch: string;
      readonly seq: string;
      readonly data: string;
    }
  | {
      readonly type: "resize";
      readonly bindingId: string;
      readonly epoch: string;
      readonly seq: string;
      readonly cols: number;
      readonly rows: number;
    }
  | {
      readonly type: "exit";
      readonly bindingId: string;
      readonly epoch: string;
      readonly seq: string;
      readonly code?: number;
      readonly signal?: number;
    }
  | {
      readonly type: "session";
      readonly bindingId: string;
      readonly epoch: string;
      readonly status: "starting" | "running" | "exited";
      readonly pid?: number;
    };

export type TerminalStreamFrame = TerminalAttachedFrame | TerminalEventFrame;

export type TerminalCreateInput = {
  readonly bindingId: string;
  readonly cols?: number;
  readonly rows?: number;
};

export type TerminalProjectedAgentCreateInput = {
  readonly canvasName: string;
  readonly nodeId: string;
  readonly cols?: number;
  readonly rows?: number;
};

export class TerminalSocket extends Context.Tag("@vellum/cli/TerminalSocket")<
  TerminalSocket,
  {
    readonly create: (
      input: TerminalCreateInput,
    ) => Effect.Effect<TerminalSessionSummary, RuntimeDown | WireError>;
    readonly createProjectedAgent: (
      input: TerminalProjectedAgentCreateInput,
    ) => Effect.Effect<TerminalSessionSummary, RuntimeDown | WireError>;
    readonly list: Effect.Effect<
      ReadonlyArray<TerminalSessionSummary>,
      RuntimeDown | WireError
    >;
    readonly get: (
      bindingId: string,
    ) => Effect.Effect<TerminalSessionSummary | undefined, RuntimeDown | WireError>;
    readonly kill: (
      bindingId: string,
    ) => Effect.Effect<boolean, RuntimeDown | WireError>;
    readonly write: (
      bindingId: string,
      data: string,
    ) => Effect.Effect<boolean, RuntimeDown | WireError>;
    readonly resize: (
      bindingId: string,
      cols: number,
      rows: number,
    ) => Effect.Effect<boolean, RuntimeDown | WireError>;
    readonly attach: (
      bindingId: string,
      onFrame: (frame: TerminalStreamFrame) => void,
    ) => Effect.Effect<void, RuntimeDown | WireError>;
  }
>() {}

const toWireError = (error: unknown): WireError =>
  new WireError({
    type: "InternalError",
    message:
      error instanceof Error
        ? error.message
        : String(error),
  });

const acquireClient = Effect.gen(function* () {
  const home = resolveVellumHome();
  const token = yield* Effect.tryPromise({
    try: async () => (await readFile(termControlTokenPath(home), "utf8")).trim(),
    catch: () =>
      new RuntimeDown({
        message: "terminal control token unavailable — is Vellum Command running?",
        next_step: "start the local Vellum Command runtime, then retry",
      }),
  });
  if (!/^[0-9a-f]{64}$/u.test(token)) {
    return yield* Effect.fail(
      new RuntimeDown({
        message: "terminal control token is malformed",
        next_step: "restart the local Vellum Command runtime",
      }),
    );
  }
  return yield* Effect.tryPromise({
    try: () =>
      TermControlClient.connect({
        socketPath: termControlSocketPath(home),
        token,
      }),
    catch: (error) =>
      new RuntimeDown({
        message:
          error instanceof Error
            ? error.message
            : "terminal control socket unavailable",
        next_step: "start the local Vellum Command runtime, then retry",
      }),
  });
});

const withClient = <A>(
  use: (
    client: TermControlClient,
  ) => Effect.Effect<A, RuntimeDown | WireError>,
): Effect.Effect<A, RuntimeDown | WireError> =>
  Effect.acquireUseRelease(
    acquireClient,
    use,
    (client) =>
      Effect.promise(() => client.drainOnQuit()).pipe(
        Effect.asVoid,
      ),
  );

const clientCall = <A>(
  call: () => Promise<A>,
): Effect.Effect<A, WireError> =>
  Effect.tryPromise({
    try: call,
    catch: toWireError,
  });

const eventFrame = (event: LocalHostEvent): TerminalEventFrame => {
  switch (event.type) {
    case "output":
      return { ...event, seq: event.seq.toString() };
    case "resize":
      return { ...event, seq: event.seq.toString() };
    case "exit":
      return {
        type: "exit",
        bindingId: event.bindingId,
        epoch: event.epoch,
        seq: event.seq.toString(),
        ...(event.code === undefined ? {} : { code: event.code }),
        ...(event.signal === undefined ? {} : { signal: event.signal }),
      };
    case "session":
      return event;
  }
};

const journalFrame = (
  bindingId: string,
  epoch: string,
  entry: JournalEntry,
): TerminalEventFrame => {
  switch (entry.type) {
    case "output":
      return {
        type: "output",
        bindingId,
        epoch,
        seq: entry.seq.toString(),
        data: entry.data,
      };
    case "resize":
      return {
        type: "resize",
        bindingId,
        epoch,
        seq: entry.seq.toString(),
        cols: entry.cols,
        rows: entry.rows,
      };
    case "exit":
      return {
        type: "exit",
        bindingId,
        epoch,
        seq: entry.seq.toString(),
        ...(entry.code === undefined ? {} : { code: entry.code }),
        ...(entry.signal === undefined ? {} : { signal: entry.signal }),
      };
  }
};

const attachUntilExit = (
  client: TermControlClient,
  bindingId: string,
  onFrame: (frame: TerminalStreamFrame) => void,
): Effect.Effect<void, WireError> =>
  Effect.async<void, WireError>((resume) => {
    let settled = false;
    let attached = false;
    const queued: LocalHostEvent[] = [];
    const finish = (result: Effect.Effect<void, WireError>): void => {
      if (settled) return;
      settled = true;
      client.off("event", onEvent);
      resume(result);
    };
    const publish = (event: LocalHostEvent): void => {
      onFrame(eventFrame(event));
      if (event.type === "exit") finish(Effect.void);
    };
    const onEvent = (event: LocalHostEvent): void => {
      if (!attached) {
        queued.push(event);
        return;
      }
      publish(event);
    };
    client.on("event", onEvent);

    void client
      .attach({ bindingId, mode: "observe" })
      .then((result) => {
        if (!result.ok) {
          finish(Effect.fail(toWireError(new Error(result.message))));
          return;
        }
        onFrame({
          type: "attached",
          bindingId: result.lease.bindingId,
          epoch: result.lease.epoch,
          status: result.status,
          cols: result.cols,
          rows: result.rows,
          ...(result.pid === undefined ? {} : { pid: result.pid }),
          ...(result.screen === undefined
            ? {}
            : {
                screen: {
                  seq: result.screen.seq.toString(),
                  serialized: result.screen.serialized,
                },
              }),
        });
        attached = true;
        let historicalExit = false;
        for (const entry of result.journal) {
          const frame = journalFrame(
            result.lease.bindingId,
            result.lease.epoch,
            entry,
          );
          onFrame(frame);
          if (frame.type === "exit") historicalExit = true;
        }
        for (const event of queued.splice(0)) publish(event);
        if (result.status === "exited" || historicalExit) finish(Effect.void);
      })
      .catch((error) => finish(Effect.fail(toWireError(error))));

    return Effect.sync(() => {
      settled = true;
      client.off("event", onEvent);
    });
  });

export const TerminalSocketLive = Layer.succeed(
  TerminalSocket,
  TerminalSocket.of({
    create: (input) =>
      withClient((client) =>
        clientCall(() =>
          client.create({
            bindingId: input.bindingId,
            launch: { kind: "shell" },
            ...(input.cols === undefined ? {} : { cols: input.cols }),
            ...(input.rows === undefined ? {} : { rows: input.rows }),
          }),
        ),
      ),
    createProjectedAgent: (input) =>
      withClient((client) =>
        clientCall(() => client.createProjectedAgent(input)),
      ),
    list: withClient((client) => clientCall(() => client.list())),
    get: (bindingId) =>
      withClient((client) => clientCall(() => client.get(bindingId))),
    kill: (bindingId) =>
      withClient((client) => clientCall(() => client.kill(bindingId))),
    write: (bindingId, data) =>
      withClient((client) =>
        Effect.gen(function* () {
          const attached = yield* clientCall(() =>
            client.attach({
              bindingId,
              mode: "control",
            }),
          );
          if (!attached.ok) {
            return yield* Effect.fail(toWireError(new Error(attached.message)));
          }
          try {
            return yield* clientCall(() =>
              client.write(attached.lease.leaseId, data),
            );
          } finally {
            yield* clientCall(() =>
              client.release(attached.lease.leaseId),
            ).pipe(Effect.ignore);
          }
        }),
      ),
    resize: (bindingId, cols, rows) =>
      withClient((client) =>
        Effect.gen(function* () {
          const attached = yield* clientCall(() =>
            client.attach({
              bindingId,
              mode: "control",
            }),
          );
          if (!attached.ok) {
            return yield* Effect.fail(toWireError(new Error(attached.message)));
          }
          try {
            return yield* clientCall(() =>
              client.resize(attached.lease.leaseId, cols, rows),
            );
          } finally {
            yield* clientCall(() =>
              client.release(attached.lease.leaseId),
            ).pipe(Effect.ignore);
          }
        }),
      ),
    attach: (bindingId, onFrame) =>
      withClient((client) =>
        attachUntilExit(client, bindingId, onFrame),
      ),
  }),
);
