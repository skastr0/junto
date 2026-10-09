import { Command } from "effect/unstable/cli";
import { Effect, Layer } from "effect";
import { CLI_NAME, CLI_VERSION } from "./core/constants";
import { setExitCode, writeCauseEnvelope, writeFailureEnvelope } from "./core/output";
import { ARTIFACTS_ENABLED, BOARD_ENABLED, PAD_ENABLED, SHEET_ENABLED, TASKS_ENABLED } from "@shared/features";

type Entry = { readonly name: string; readonly enabled?: boolean; readonly load: () => Promise<Command.Command.Any> };
const commands: readonly Entry[] = [
  { name: "machine", load: async () => (await import("./commands/machine")).machineCommand },
  { name: "ping", load: async () => (await import("./commands/seat-discovery")).pingCommand },
  { name: "doctor", load: async () => (await import("./commands/seat-discovery")).doctorCommand },
  { name: "capabilities", load: async () => (await import("./commands/seat-discovery")).capabilitiesCommand },
  { name: "onboard", load: async () => (await import("./commands/seat-discovery")).onboardCommand },
  { name: "offboard", load: async () => (await import("./commands/seat-discovery")).offboardCommand },
  { name: "schema", load: async () => (await import("./commands/discovery")).schemaCommand },
  { name: "examples", load: async () => (await import("./commands/discovery")).examplesCommand },
  { name: "preamble", load: async () => (await import("./commands/work")).preambleCommand },
  { name: "escalate", load: async () => (await import("./commands/signals")).escalateCommand },
  { name: "blocked", load: async () => (await import("./commands/signals")).blockedCommand },
  { name: "feedback", load: async () => (await import("./commands/signals")).feedbackCommand },
  { name: "signal", load: async () => (await import("./commands/signals")).signalCommand },
  { name: "tasks", enabled: TASKS_ENABLED, load: async () => (await import("./commands/work")).tasksCommand },
  { name: "rulings", enabled: TASKS_ENABLED, load: async () => (await import("./commands/work")).rulingsCommand },
  { name: "msg", load: async () => (await import("./commands/work")).msgCommand },
  { name: "seat", load: async () => (await import("./commands/seat")).seatCommand },
  { name: "env", load: async () => (await import("./commands/env")).envCommand },
  { name: "references", load: async () => (await import("./commands/references")).referencesCommand },
  { name: "verdict", load: async () => (await import("./commands/work")).verdictCommand },
  { name: "content", enabled: TASKS_ENABLED, load: async () => (await import("./commands/content")).contentCommand },
  { name: "docs", load: async () => (await import("./commands/docs")).docsCommand },
  { name: "board", enabled: BOARD_ENABLED, load: async () => (await import("./commands/work")).boardCommand },
  { name: "pad", enabled: PAD_ENABLED, load: async () => (await import("./commands/pad")).padCommand },
  { name: "sheet", enabled: SHEET_ENABLED, load: async () => (await import("./commands/sheet")).sheetCommand },
  { name: "artifact", enabled: ARTIFACTS_ENABLED, load: async () => (await import("./commands/work")).artifactCommand },
  { name: "overseer", load: async () => (await import("./commands/overseer")).overseerCommand },
];

/** Full discovery for root help/errors; a known invocation loads only its family. */
export const loadRootCommand = async (args: ReadonlyArray<string>) => {
  const enabled = commands.filter((entry) => entry.enabled !== false);
  const selected = enabled.find((entry) => entry.name === args[0]);
  const loaded = await Promise.all((selected ? [selected] : enabled).map((entry) => entry.load()));
  return Command.make(CLI_NAME).pipe(
    Command.withDescription("Junto agent protocol surfaces (JSON only)"),
    Command.withSubcommands(loaded),
  );
};

export const runCli = (args: ReadonlyArray<string>): Effect.Effect<void, never, never> =>
  Effect.gen(function* () {
    // A retired overseer family is answered in one line, before any parsing.
    if (args[0] === "overseer" && args[1] === "edge") {
      const { retiredOverseerInvocation } = yield* Effect.promise(() => import("./commands/overseer-retired"));
      const retired = retiredOverseerInvocation(args);
      if (retired !== undefined) return yield* Effect.fail(retired);
    }
    const root = yield* Effect.promise(() => loadRootCommand(args));
    const BunServices = yield* Effect.promise(() => import("@effect/platform-bun/BunServices"));
    const transport = args[0] === "machine"
      ? (yield* Effect.promise(() => import("./core/operator-socket"))).OperatorSocketLive
      : (yield* Effect.promise(() => import("./core/socket"))).WorkSocketLive;
    return yield* Command.runWith(root, { version: CLI_VERSION })(args).pipe(
      Effect.provide(Layer.mergeAll(BunServices.layer, transport)),
    );
  }).pipe(
    Effect.catch((error) => setExitCode(1).pipe(Effect.andThen(writeFailureEnvelope(undefined, error)))),
    Effect.catchCause((cause) => setExitCode(1).pipe(Effect.andThen(writeCauseEnvelope(undefined, cause)))),
  ) as Effect.Effect<void, never, never>;
