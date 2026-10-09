import { Effect, Schema } from "effect";
import { Argument, Command } from "effect/unstable/cli";
import {
  MachineAddInput, MachineEmptyInput, MachineCopyInput, MachineStatusInput,
  MachineTargetInput, MachinePeerIdentity, type MachineOpName,
} from "@shared/machine-control";
import type { OperatorArgsByOp } from "@shared/operator-control";
import { OperatorSocket } from "../core/operator-socket";
import { MachineInstallInput, MachineLocalPaths } from "@shared/machine-install";
import { installMachine } from "../../main/junto/hosts/install";
import { uninstallMachine } from "../../main/junto/hosts/uninstall";
import { loadJsonInput } from "../core/json";
import { executeJsonCommand } from "../core/output";

const installLocal = Command.make("install-local",{
  input:Argument.string("input").pipe(Argument.withDescription("JSON object, @file, or - for stdin")),
},({input})=>executeJsonCommand("machine install-local",loadJsonInput(MachineInstallInput,input).pipe(Effect.flatMap(installMachine))));

const uninstallLocal = Command.make("uninstall-local", {
  input: Argument.string("input").pipe(Argument.withDescription("JSON object, @file, or - for stdin")),
}, ({input}) => executeJsonCommand("machine uninstall-local", loadJsonInput(MachineLocalPaths, input).pipe(Effect.flatMap(uninstallMachine))));

const ownerCommand = <Op extends MachineOpName>(name: string, op: Op, schema: Schema.Codec<OperatorArgsByOp[Op], unknown>) =>
  Command.make(name, {
    input: Argument.string("input").pipe(Argument.withDescription("JSON object, @file, or - for stdin")),
  }, ({ input }) => executeJsonCommand(`machine ${name}`, Effect.gen(function* () {
    const raw = yield* loadJsonInput(Schema.Unknown, input);
    const args = yield* Schema.decodeUnknownEffect(schema)(raw, { onExcessProperty: "error" });
    const socket = yield* OperatorSocket;
    return yield* socket.call(op, args, op === "machine.send" || op === "machine.update" ? 15 * 60_000 : undefined);
  })));

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
  ]),
);
