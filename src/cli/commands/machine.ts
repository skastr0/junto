import { Effect, Option, Schema } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import {
  MachineAddInput, MachineEmptyInput, MachineCopyInput, MachineStatusInput,
  MachineTargetInput, MachinePeerIdentity, type MachineOpName,
} from "@shared/machine-control";
import type { OperatorArgsByOp } from "@shared/operator-control";
import { OperatorSocket, requireOwnerCommand } from "../core/operator-socket";
import { MachineExchangeInput } from "@shared/machine-exchange";
import { MachineLogsInput } from "@shared/machine-log";
import { MachineSeatInput, MachineSeatReadInput, MachineSeatStartInput } from "@shared/machine-seat";
import { MachineInstallInput, MachineLocalPaths } from "@shared/machine-install";
import { BoatAddInput, BoatMachineKeyDelivery } from "@shared/boat";
import { resolveJuntoHome } from "@shared/junto-home";
import { writeBoatMachineSelf } from "../../main/junto/boat/files";
import {
  CodeAllowanceScope,
  DEFAULT_CODE_ALLOWANCE_SCOPE,
  readCodeAllowances,
  writeCodeAllowance,
} from "../../main/junto/automation/code-allowance";
import { installMachine } from "../../main/junto/hosts/install";
import { uninstallMachine } from "../../main/junto/hosts/uninstall";
import { loadJsonInput } from "../core/json";
import { executeJsonCommand } from "../core/output";
import { logsFilterFlags, logsFlagsOf, lowerLogsFlags } from "./logs";

const installLocal = Command.make("install-local", {
  input: Argument.string("input").pipe(Argument.withDescription("JSON object, @file, or - for stdin")),
}, ({ input }) => executeJsonCommand("machine install-local", requireOwnerCommand.pipe(
  Effect.andThen(loadJsonInput(MachineInstallInput, input)),
  Effect.flatMap(installMachine),
)));

const uninstallLocal = Command.make("uninstall-local", {
  input: Argument.string("input").pipe(Argument.withDescription("JSON object, @file, or - for stdin")),
}, ({ input }) => executeJsonCommand("machine uninstall-local", requireOwnerCommand.pipe(
  Effect.andThen(loadJsonInput(MachineLocalPaths, input)),
  Effect.flatMap(uninstallMachine),
)));

/** Fixed words: a key that fails to decode never shows in the failure. */
class BoatKeyNotPlaced extends Schema.TaggedError<BoatKeyNotPlaced>()("BoatKeyNotPlaced", { message: Schema.String }) {}

const readStdin = Effect.tryPromise({
  try: async () => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of process.stdin) {
      bytes += (chunk as Buffer).length;
      if (bytes > 4096) throw new Error("too large");
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks).toString("utf8");
  },
  catch: () => new BoatKeyNotPlaced({ message: "The machine key could not be read from stdin" }),
});

/**
 * On a Boat machine, over the editing machine's SSH session: the machine key
 * from stdin into this Junto home, 0600. Its answer never carries the key.
 */
const boatKeyLocal = Command.make("boat-key-local", {}, () => executeJsonCommand("machine boat-key-local", requireOwnerCommand.pipe(
  Effect.andThen(readStdin),
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
))).pipe(Command.withDescription("Write this Boat machine's key from stdin (run by the editing machine over SSH)"));

/** A send and a Boat machine made from nothing take minutes; a wake or a key, a few. */
const LONG_OPS: ReadonlySet<string> = new Set(["machine.send", "machine.update", "machine.boat-add"]);
const SLOW_OPS: ReadonlySet<string> = new Set(["machine.boat-connect", "machine.boat-disconnect", "machine.boat-delete", "machine.wake", "machine.sleep", "machine.remove"]);

const ownerCommand = <Op extends MachineOpName>(name: string, op: Op, schema: Schema.Codec<OperatorArgsByOp[Op], unknown>) =>
  Command.make(name, {
    input: Argument.string("input").pipe(Argument.withDescription("JSON object, @file, or - for stdin")),
  }, ({ input }) => executeJsonCommand(`machine ${name}`, Effect.gen(function* () {
    yield* requireOwnerCommand;
    const raw = yield* loadJsonInput(Schema.Unknown, input);
    const args = yield* Schema.decodeUnknownEffect(schema)(raw, { onExcessProperty: "error" });
    const socket = yield* OperatorSocket;
    return yield* socket.call(op, args, LONG_OPS.has(op) ? 15 * 60_000 : SLOW_OPS.has(op) ? 5 * 60_000 : undefined);
  })));

/**
 * The owner reads one machine's log: this one whole, a linked one scoped by
 * that machine to the canvases this one holds. Refused from a seat, like
 * every machine command.
 */
const logs = Command.make("logs", {
  name: Argument.string("name").pipe(Argument.withDescription("Machine name: this machine or a linked one")),
  ...logsFilterFlags,
}, ({ name, ...flags }) => executeJsonCommand("machine logs", Effect.gen(function* () {
  yield* requireOwnerCommand;
  const query = yield* lowerLogsFlags(logsFlagsOf(flags));
  const args = yield* Schema.decodeUnknownEffect(MachineLogsInput, { onExcessProperty: "error" })({ name, query });
  const socket = yield* OperatorSocket;
  return yield* socket.call("machine.logs", args);
}))).pipe(Command.withDescription("Read a machine's log, this one or a linked one, with the junto logs filters"));

const seatArguments = {
  canvas: Argument.string("canvas").pipe(Argument.withDescription("Canvas name")),
  seat: Argument.string("seat").pipe(Argument.withDescription("Seat id on that canvas")),
};

/**
 * The owner starts or stops a seat by canvas and seat id without the window,
 * through the code the window uses. Refused from a seat, like every machine
 * command. A refused spawn answers with status exited and its exit message.
 */
const seatStart = Command.make("seat-start", seatArguments, ({ canvas, seat }) => executeJsonCommand("machine seat-start", Effect.gen(function* () {
  yield* requireOwnerCommand;
  const args = yield* Schema.decodeUnknownEffect(MachineSeatStartInput, { onExcessProperty: "error" })({ canvas, seatId: seat });
  const socket = yield* OperatorSocket;
  return yield* socket.call("machine.seat-start", args, 120_000);
}))).pipe(Command.withDescription("Start a seat by canvas and seat id, the way the window's Start does"));

const seatStop = Command.make("seat-stop", seatArguments, ({ canvas, seat }) => executeJsonCommand("machine seat-stop", Effect.gen(function* () {
  yield* requireOwnerCommand;
  const args = yield* Schema.decodeUnknownEffect(MachineSeatInput, { onExcessProperty: "error" })({ canvas, seatId: seat });
  const socket = yield* OperatorSocket;
  return yield* socket.call("machine.seat-stop", args);
}))).pipe(Command.withDescription("Stop a seat by canvas and seat id; the seat stays on the canvas"));

const seatRead = Command.make("seat-read", {
  ...seatArguments,
  lines: Flag.integer("lines").pipe(Flag.optional, Flag.withDescription("Last lines of the settled grid to read (default 40, at most 2000)")),
}, ({ canvas, seat, lines }) => executeJsonCommand("machine seat-read", Effect.gen(function* () {
  yield* requireOwnerCommand;
  const args = yield* Schema.decodeUnknownEffect(MachineSeatReadInput, { onExcessProperty: "error" })({
    canvas, seatId: seat, ...(Option.isSome(lines) ? { lines: lines.value } : {}),
  });
  const socket = yield* OperatorSocket;
  return yield* socket.call("machine.seat-read", args);
}))).pipe(Command.withDescription("Read what a seat's terminal shows, on this machine or the one that runs it"));

/** The allowance file could not be written in this Junto home. */
class CodeAllowanceNotWritten extends Schema.TaggedError<CodeAllowanceNotWritten>()("CodeAllowanceNotWritten", { message: Schema.String }) {}

const allowanceWrite = (canvas: string, allowance: Parameters<typeof writeCodeAllowance>[2]) => Effect.tryPromise({
  try: async () => {
    const canvases = await writeCodeAllowance(resolveJuntoHome(), canvas, allowance);
    return { canvas, allowance: Object.hasOwn(canvases, canvas) ? canvases[canvas] : null };
  },
  catch: () => new CodeAllowanceNotWritten({ message: "The code allowance could not be written in this Junto home" }),
});

const canvasArgument = Argument.string("canvas").pipe(Argument.withDescription("Canvas name"));

/**
 * This machine's owner allows code steps for one canvas, from the installations
 * that rule it (docs/security-doctrine.md, Code steps, check 4). Machine-local:
 * never a row, never set over a link, refused from a seat.
 */
const codeAllow = Command.make("allow", {
  canvas: canvasArgument,
  installation: Flag.string("installation").pipe(Flag.atLeast(1), Flag.withDescription("An installation that rules this canvas, whose code this machine runs (repeat for standby rulers)")),
  scope: Flag.choice("scope", CodeAllowanceScope.literals).pipe(Flag.optional, Flag.withDescription(`Who may author the code: operator, or operator-and-overseers (default ${DEFAULT_CODE_ALLOWANCE_SCOPE})`)),
}, ({ canvas, installation, scope }) => executeJsonCommand("machine code allow", requireOwnerCommand.pipe(
  Effect.andThen(allowanceWrite(canvas, {
    scope: Option.getOrElse(scope, () => DEFAULT_CODE_ALLOWANCE_SCOPE),
    installations: [...new Set(installation)],
  })),
))).pipe(Command.withDescription("Allow this machine to run code steps for a canvas, ruled by the given installations"));

const codeDeny = Command.make("deny", { canvas: canvasArgument }, ({ canvas }) => executeJsonCommand("machine code deny", requireOwnerCommand.pipe(
  Effect.andThen(allowanceWrite(canvas, undefined)),
))).pipe(Command.withDescription("Stop this machine running code steps for a canvas; a run in flight ends at its timeout"));

const codeShow = Command.make("show", {
  canvas: Argument.string("canvas").pipe(Argument.optional, Argument.withDescription("Canvas name; every allowed canvas when absent")),
}, ({ canvas }) => executeJsonCommand("machine code show", requireOwnerCommand.pipe(
  Effect.andThen(Effect.promise(() => readCodeAllowances(resolveJuntoHome()))),
  Effect.map((canvases) => Option.isSome(canvas)
    ? { canvas: canvas.value, allowance: Object.hasOwn(canvases, canvas.value) ? canvases[canvas.value] : null }
    : { canvases }),
))).pipe(Command.withDescription("Show which canvases this machine runs code steps for"));

const code = Command.make("code").pipe(
  Command.withDescription("Whether this machine runs automation code steps, per canvas"),
  Command.withSubcommands([codeAllow, codeDeny, codeShow]),
);

export const machineCommand = Command.make("machine").pipe(
  Command.withDescription("Install and manage Junto on machines"),
  Command.withSubcommands([
    installLocal, uninstallLocal,
    ownerCommand("add", "machine.add", MachineAddInput),
    ownerCommand("list", "machine.list", MachineEmptyInput),
    ownerCommand("send", "machine.send", MachineCopyInput),
    ownerCommand("status", "machine.status", MachineStatusInput),
    ownerCommand("update", "machine.update", MachineCopyInput),
    ownerCommand("remove", "machine.remove", MachineTargetInput),
    ownerCommand("harnesses", "machine.harnesses", MachineStatusInput),
    ownerCommand("configure", "machine.configure", MachineTargetInput),
    ownerCommand("setup", "machine.setup", MachinePeerIdentity),
    ownerCommand("exchange", "machine.exchange", MachineExchangeInput),
    ownerCommand("boat-connect", "machine.boat-connect", MachineEmptyInput),
    ownerCommand("boat-disconnect", "machine.boat-disconnect", MachineEmptyInput),
    ownerCommand("boat-status", "machine.boat-status", MachineEmptyInput),
    ownerCommand("boat-add", "machine.boat-add", BoatAddInput),
    ownerCommand("boat-delete", "machine.boat-delete", MachineTargetInput),
    ownerCommand("wake", "machine.wake", MachineTargetInput),
    ownerCommand("sleep", "machine.sleep", MachineTargetInput),
    logs, seatStart, seatStop, seatRead, boatKeyLocal, code,
  ]),
);
