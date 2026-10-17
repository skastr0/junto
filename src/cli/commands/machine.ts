import { Effect, Schema } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import {
  MachineAddInput, MachineEmptyInput, MachineCopyInput, MachineStatusInput,
  MachineTargetInput, MachinePeerIdentity, type MachineOpName,
} from "@shared/machine-control";
import type { OperatorArgsByOp } from "@shared/operator-control";
import { OperatorSocket, requireOwnerCommand } from "../core/operator-socket";
import { MachineExchangeInput } from "@shared/machine-exchange";
import { MachineLogsInput } from "@shared/machine-log";
import { MachineSeatInput, MachineSeatStartInput } from "@shared/machine-seat";
import { MachineInstallInput, MachineLocalPaths } from "@shared/machine-install";
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

const ownerCommand = <Op extends MachineOpName>(name: string, op: Op, schema: Schema.Codec<OperatorArgsByOp[Op], unknown>) =>
  Command.make(name, {
    input: Argument.string("input").pipe(Argument.withDescription("JSON object, @file, or - for stdin")),
  }, ({ input }) => executeJsonCommand(`machine ${name}`, Effect.gen(function* () {
    yield* requireOwnerCommand;
    const raw = yield* loadJsonInput(Schema.Unknown, input);
    const args = yield* Schema.decodeUnknownEffect(schema)(raw, { onExcessProperty: "error" });
    const socket = yield* OperatorSocket;
    return yield* socket.call(op, args, op === "machine.send" || op === "machine.update" ? 15 * 60_000 : undefined);
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
const seatStart = Command.make("seat-start", {
  ...seatArguments,
  fresh: Flag.boolean("fresh").pipe(Flag.withDefault(false), Flag.withDescription("Start a fresh session where one could be resumed")),
}, ({ canvas, seat, fresh }) => executeJsonCommand("machine seat-start", Effect.gen(function* () {
  yield* requireOwnerCommand;
  const args = yield* Schema.decodeUnknownEffect(MachineSeatStartInput, { onExcessProperty: "error" })({ canvas, seatId: seat, ...(fresh ? { resume: false } : {}) });
  const socket = yield* OperatorSocket;
  return yield* socket.call("machine.seat-start", args, 120_000);
}))).pipe(Command.withDescription("Start a seat by canvas and seat id, the way the window's Start does"));

const seatStop = Command.make("seat-stop", seatArguments, ({ canvas, seat }) => executeJsonCommand("machine seat-stop", Effect.gen(function* () {
  yield* requireOwnerCommand;
  const args = yield* Schema.decodeUnknownEffect(MachineSeatInput, { onExcessProperty: "error" })({ canvas, seatId: seat });
  const socket = yield* OperatorSocket;
  return yield* socket.call("machine.seat-stop", args);
}))).pipe(Command.withDescription("Stop a seat by canvas and seat id; the seat stays on the canvas"));

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
    logs, seatStart, seatStop,
  ]),
);
