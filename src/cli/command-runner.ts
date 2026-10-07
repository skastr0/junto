import { Command } from "effect/unstable/cli";
import { BunServices } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { CLI_NAME, CLI_VERSION } from "./core/constants";
import { setExitCode, writeCauseEnvelope, writeFailureEnvelope } from "./core/output";
import { ARTIFACTS_ENABLED, BOARD_ENABLED, FLEET_UI_ENABLED, PAD_ENABLED, SHEET_ENABLED, TASKS_ENABLED } from "@shared/features";

type Entry = { readonly name: string; readonly enabled?: boolean; readonly load: () => Promise<Command.Command.Any> };
const commands: readonly Entry[] = [
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
  { name: "verdict", load: async () => (await import("./commands/work")).verdictCommand },
  { name: "content", enabled: TASKS_ENABLED, load: async () => (await import("./commands/content")).contentCommand },
  { name: "docs", load: async () => (await import("./commands/docs")).docsCommand },
  { name: "board", enabled: BOARD_ENABLED, load: async () => (await import("./commands/work")).boardCommand },
  { name: "pad", enabled: PAD_ENABLED, load: async () => (await import("./commands/pad")).padCommand },
  { name: "sheet", enabled: SHEET_ENABLED, load: async () => (await import("./commands/sheet")).sheetCommand },
  { name: "artifact", enabled: ARTIFACTS_ENABLED, load: async () => (await import("./commands/work")).artifactCommand },
  { name: "overseer", load: async () => (await import("./commands/overseer")).overseerCommand },
  { name: "station", load: async () => (await import("./commands/operator")).stationOperatorCommand },
  { name: "fleet", enabled: FLEET_UI_ENABLED, load: async () => (await import("./commands/operator")).fleetOperatorCommand },
  { name: "qualification", enabled: FLEET_UI_ENABLED, load: async () => (await import("./commands/operator")).qualificationOperatorCommand },
];

/** Full discovery for root help/errors; a known invocation loads only its family. */
export const loadRootCommand = async (args: ReadonlyArray<string>) => {
  const enabled = commands.filter((entry) => entry.enabled !== false);
  const selected = enabled.find((entry) => entry.name === args[0]);
  const loaded = await Promise.all((selected ? [selected] : enabled).map((entry) => entry.load()));
  return Command.make(CLI_NAME).pipe(
    Command.withDescription("Junto agent and direct-operator protocol surfaces (JSON only)"),
    Command.withSubcommands(loaded),
  );
};

export const runCli = (args: ReadonlyArray<string>): Effect.Effect<void, never, never> =>
  Effect.gen(function* () {
    const root = yield* Effect.promise(() => loadRootCommand(args));
    const known = commands.some((entry) => entry.name === args[0] && entry.enabled !== false);
    const operator = ["station", "fleet", "qualification"].includes(args[0]);
    const transport = yield* Effect.promise(async () => {
      // Global flags before the command use the complete parser and both services.
      if (!known) {
        const [work, directOperator] = await Promise.all([import("./core/socket"), import("./core/operator-socket")]);
        return Layer.mergeAll(work.WorkSocketLive, directOperator.OperatorSocketLive);
      }
      return operator ? (await import("./core/operator-socket")).OperatorSocketLive
        : (await import("./core/socket")).WorkSocketLive;
    });
    return yield* Command.runWith(root, { version: CLI_VERSION })(args).pipe(
      Effect.provide(Layer.mergeAll(BunServices.layer, transport)),
    );
  }).pipe(
    Effect.catch((error) => setExitCode(1).pipe(Effect.andThen(writeFailureEnvelope(undefined, error)))),
    Effect.catchCause((cause) => setExitCode(1).pipe(Effect.andThen(writeCauseEnvelope(undefined, cause)))),
  ) as Effect.Effect<void, never, never>;
