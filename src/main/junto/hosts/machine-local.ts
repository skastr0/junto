/**
 * What runs on a machine's own files, on its bundle's Node: install,
 * uninstall and a Boat machine's key (N6). The native `junto` hands
 * `machine install-local`, `uninstall-local` and `boat-key-local` here, and
 * the editing machine's SSH session runs it directly:
 * `bin/node core/machine-local.cjs <command> [input]`. It prints the same
 * envelopes the CLI's commands print.
 */
import { readFile } from "node:fs/promises";
import { Effect, Schema } from "effect";
import { BoatMachineKeyDelivery } from "@shared/boat";
import { resolveJuntoHome } from "@shared/junto-home";
import { MachineInstallInput, MachineLocalPaths } from "@shared/machine-install";
import { AuthError, InputError } from "../../../cli/core/errors";
import { decodeJsonText } from "../../../cli/core/json";
import { executeJsonCommand, setExitCode, writeCauseEnvelope, writeFailureEnvelope } from "../../../cli/core/output";
import { ownerCommandRefusal } from "../../../cli/core/owner-access";
import { writeBoatMachineSelf } from "../boat/files";
import { installMachine } from "./install";
import { uninstallMachine } from "./uninstall";

const requireOwner = Effect.suspend(() => {
  const refusal = ownerCommandRefusal();
  return refusal === undefined ? Effect.void : Effect.fail(new AuthError({ message: refusal }));
});

/** The whole of stdin, at most `limit` bytes. */
const readStdin = (limit: number) =>
  Effect.tryPromise({
    try: async () => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of process.stdin) {
        bytes += (chunk as Buffer).length;
        if (bytes > limit) throw new Error("too large");
        chunks.push(chunk as Buffer);
      }
      return Buffer.concat(chunks).toString("utf8");
    },
    catch: (cause) => cause,
  });

/** A JSON input as the CLI takes it, inline, `@file`, or `-` for stdin, read by Node. */
const loadInput = <S extends Schema.Top>(schema: S, input: string | undefined) =>
  Effect.gen(function* () {
    const trimmed = input?.trim() ?? "";
    if (trimmed.length === 0) return yield* new InputError({ message: "JSON input is empty", path: "inline" });
    if (trimmed === "-" || trimmed === "@-") {
      const text = yield* readStdin(64 * 1024 * 1024).pipe(
        Effect.mapError(() => new InputError({ message: "Failed to read stdin", path: "stdin" })),
      );
      return yield* decodeJsonText(schema, text, "stdin");
    }
    if (trimmed.startsWith("@")) {
      const path = trimmed.slice(1);
      const text = yield* Effect.tryPromise({
        try: () => readFile(path, "utf8"),
        catch: (cause) => new InputError({ message: cause instanceof Error ? cause.message : "read failed", path }),
      });
      return yield* decodeJsonText(schema, text, path);
    }
    return yield* decodeJsonText(schema, trimmed, "inline");
  });

/** Fixed words: a key that fails to decode never shows in the failure. */
class BoatKeyNotPlaced extends Schema.TaggedError<BoatKeyNotPlaced>()("BoatKeyNotPlaced", { message: Schema.String }) {}

/**
 * On a Boat machine, over the editing machine's SSH session: the machine key
 * from stdin into this Junto home, 0600. Its answer never carries the key.
 */
const boatKeyLocal = requireOwner.pipe(
  Effect.andThen(readStdin(4096).pipe(Effect.mapError(() => new BoatKeyNotPlaced({ message: "The machine key could not be read from stdin" })))),
  Effect.flatMap((text) => Effect.try({
    try: () => Schema.decodeUnknownSync(BoatMachineKeyDelivery, { onExcessProperty: "error" })(JSON.parse(text)),
    catch: () => new BoatKeyNotPlaced({ message: "The machine key did not match its shape" }),
  })),
  Effect.flatMap((delivery) => Effect.tryPromise({
    try: async () => {
      await writeBoatMachineSelf(resolveJuntoHome(), { version: 1, sandboxId: delivery.sandboxId, keyId: delivery.keyId }, delivery.key);
      return { placed: true, sandboxId: delivery.sandboxId };
    },
    catch: () => new BoatKeyNotPlaced({ message: "The machine key could not be written in this Junto home" }),
  })),
);

const run = (argv: ReadonlyArray<string>) => {
  const [command, input] = argv;
  switch (command) {
    case "install-local":
      return executeJsonCommand("machine install-local", requireOwner.pipe(
        Effect.andThen(loadInput(MachineInstallInput, input)),
        Effect.flatMap(installMachine),
      ));
    case "uninstall-local":
      return executeJsonCommand("machine uninstall-local", requireOwner.pipe(
        Effect.andThen(loadInput(MachineLocalPaths, input)),
        Effect.flatMap(uninstallMachine),
      ));
    case "boat-key-local":
      return executeJsonCommand("machine boat-key-local", boatKeyLocal);
    default:
      return setExitCode(1).pipe(Effect.andThen(writeFailureEnvelope(undefined, new InputError({
        message: "machine-local runs install-local, uninstall-local or boat-key-local",
        path: "command",
      }))));
  }
};

/** One command of this entry, by its argv; a defect prints as InternalError, exit 1. */
export const machineLocal = (argv: ReadonlyArray<string>) =>
  run(argv).pipe(Effect.catchCause((cause) =>
    setExitCode(1).pipe(Effect.andThen(writeCauseEnvelope(argv[0] === undefined ? undefined : `machine ${argv[0]}`, cause)))));
