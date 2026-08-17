// V4: Args→Argument, Options→Flag. Map: ../effect-v4-import-map.ts
import { Argument, Command, Flag } from "effect/unstable/cli";
import { Effect, Option, Result } from "effect";
import {
  PadGetArgs,
  PadLookHereArgs,
  PadPatchArgs,
  PadReadArgs,
  PadTargetArgs,
  type WorkOpName,
} from "../../shared/work-control";
import { DEFAULT_BATCH_CONCURRENCY, runMutationBatch } from "../core/batch";
import { DEFAULT_TIMEOUT_MS } from "../core/constants";
import { InputError } from "../core/errors";
import { loadJsonInput } from "../core/json";
import { executeJsonCommand } from "../core/output";
import {
  callerNodeIdFromCapabilities,
  decodePadReadResult,
  projectPadDigest,
  projectPadGet,
  projectPadLookHere,
  projectPadSvg,
  projectPadTagged,
} from "../core/pad";
import { WorkSocket } from "../core/socket";

const toUndefined = <A>(value: Option.Option<A>) =>
  Option.isSome(value) ? value.value : undefined;

const jsonInputArg = Argument.string("input").pipe(
  Argument.withDescription("JSON object, @file path, raw JSON string, or - for stdin"),
);

const concurrencyOption = Flag.integer("concurrency").pipe(
  Flag.optional,
  Flag.withDescription(
    `Max concurrent mutations (default ${DEFAULT_BATCH_CONCURRENCY}); reject <= 0`,
  ),
);

const timeoutOption = Flag.integer("timeout").pipe(
  Flag.optional,
  Flag.withDescription(`Socket call timeout in ms (default ${DEFAULT_TIMEOUT_MS})`),
);

const callDomain = <A>(op: WorkOpName, item: A, timeout?: number) =>
  Effect.gen(function* () {
    const socket = yield* WorkSocket;
    return yield* socket.call(op, item, timeout);
  });

const requirePadRead = (value: unknown) => {
  const decoded = decodePadReadResult(value);
  if (Result.isFailure(decoded)) return Effect.fail(decoded.failure);
  return Effect.succeed(decoded.success);
};

const padReadCommand = Command.make(
  "read",
  { input: jsonInputArg, timeout: timeoutOption },
  ({ input, timeout }) =>
    executeJsonCommand(
      "pad read",
      Effect.gen(function* () {
        const item = yield* loadJsonInput(PadReadArgs, input);
        return yield* callDomain("pad.read", item, toUndefined(timeout));
      }),
    ),
).pipe(
  Command.withDescription(
    "Read a connected pad (grant pad.read): revision, IR, digest, SVG. Optional pinId adds look-here. Agents never write the factory canvas.",
  ),
);

const padPatchCommand = Command.make(
  "patch",
  { input: jsonInputArg, concurrency: concurrencyOption, timeout: timeoutOption },
  ({ input, concurrency, timeout }) =>
    executeJsonCommand(
      "pad patch",
      runMutationBatch({
        input,
        concurrency: toUndefined(concurrency) ?? DEFAULT_BATCH_CONCURRENCY,
        itemSchema: PadPatchArgs,
        run: (item) => callDomain("pad.patch", item, toUndefined(timeout)),
      }),
    ),
).pipe(
  Command.withDescription(
    "Apply PadPatch on a connected pad (grant pad.patch). Agents may upsert shapes, edges, and pin posts. Agent ink or image upserts are refused. Mentions must be inbound actor node ids.",
  ),
);

const padDigestCommand = Command.make(
  "digest",
  { input: jsonInputArg, timeout: timeoutOption },
  ({ input, timeout }) =>
    executeJsonCommand(
      "pad digest",
      Effect.gen(function* () {
        const item = yield* loadJsonInput(PadTargetArgs, input);
        const raw = yield* callDomain("pad.read", item, toUndefined(timeout));
        const read = yield* requirePadRead(raw);
        return projectPadDigest(read);
      }),
    ),
).pipe(
  Command.withDescription(
    "Text IR of a connected pad (grant pad.read). Working copy for a wired seat — not the factory canvas.",
  ),
);

const padSvgCommand = Command.make(
  "svg",
  { input: jsonInputArg, timeout: timeoutOption },
  ({ input, timeout }) =>
    executeJsonCommand(
      "pad svg",
      Effect.gen(function* () {
        const item = yield* loadJsonInput(PadTargetArgs, input);
        const raw = yield* callDomain("pad.read", item, toUndefined(timeout));
        const read = yield* requirePadRead(raw);
        return projectPadSvg(read);
      }),
    ),
).pipe(
  Command.withDescription(
    "SVG picture of a connected pad (grant pad.read). Agents read the page; they never write the factory canvas.",
  ),
);

const padLookHereCommand = Command.make(
  "look-here",
  { input: jsonInputArg, timeout: timeoutOption },
  ({ input, timeout }) =>
    executeJsonCommand(
      "pad look-here",
      Effect.gen(function* () {
        const item = yield* loadJsonInput(PadLookHereArgs, input);
        const raw = yield* callDomain(
          "pad.read",
          { target: item.target, pinId: item.pinId },
          toUndefined(timeout),
        );
        const read = yield* requirePadRead(raw);
        const crop = projectPadLookHere(read, item.pinId);
        if (Result.isFailure(crop)) return yield* Effect.fail(crop.failure);
        return crop.success;
      }),
    ),
).pipe(
  Command.withDescription(
    "Crop around a pin on a connected pad (grant pad.read). pinId required. Mentions are inbound wired actors — @ cannot name an unwired agent.",
  ),
);

const padGetCommand = Command.make(
  "get",
  { input: jsonInputArg, timeout: timeoutOption },
  ({ input, timeout }) =>
    executeJsonCommand(
      "pad get",
      Effect.gen(function* () {
        const item = yield* loadJsonInput(PadGetArgs, input);
        const raw = yield* callDomain(
          "pad.read",
          { target: item.target },
          toUndefined(timeout),
        );
        const read = yield* requirePadRead(raw);
        const focused = projectPadGet(read, item.id);
        if (Result.isFailure(focused)) return yield* Effect.fail(focused.failure);
        return focused.success;
      }),
    ),
).pipe(
  Command.withDescription(
    "Compact focused items from a connected pad (grant pad.read). Optional id returns that item. Agents never write the factory canvas.",
  ),
);

const padTaggedCommand = Command.make(
  "tagged",
  { input: jsonInputArg, timeout: timeoutOption },
  ({ input, timeout }) =>
    executeJsonCommand(
      "pad tagged",
      Effect.gen(function* () {
        const item = yield* loadJsonInput(PadTargetArgs, input);
        const socket = yield* WorkSocket;
        const timeoutMs = toUndefined(timeout);
        const raw = yield* socket.call("pad.read", item, timeoutMs);
        const read = yield* requirePadRead(raw);
        const caps = yield* socket.call("capabilities", {}, timeoutMs);
        const seatNodeId = callerNodeIdFromCapabilities(caps);
        if (seatNodeId === undefined) {
          return yield* Effect.fail(
            new InputError({
              message: "process-bound seat id missing from capabilities",
              path: "capabilities.node.id",
              hint: "run vellum-command onboard under the live Vellum Command agent process",
              next_step: "vellum-command onboard",
            }),
          );
        }
        return projectPadTagged(read, seatNodeId);
      }),
    ),
).pipe(
  Command.withDescription(
    "Pins that mention this process-bound seat (grant pad.read). Mention universe is inbound actor edges; unwired names are refused on pad.patch.",
  ),
);

export const padCommand = Command.make("pad").pipe(
  Command.withDescription(
    "Pad ops — shared page on the work plane; agents never write the factory canvas",
  ),
  Command.withSubcommands([
    padReadCommand,
    padPatchCommand,
    padDigestCommand,
    padSvgCommand,
    padLookHereCommand,
    padGetCommand,
    padTaggedCommand,
  ]),
);
