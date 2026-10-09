import { Effect } from "effect";
import { Argument, Command } from "effect/unstable/cli";
import { MachineInstallInput } from "@shared/machine-install";
import { installMachine } from "../../main/junto/hosts/install";
import { loadJsonInput } from "../core/json";
import { executeJsonCommand } from "../core/output";

const installLocal = Command.make("install-local",{
  input:Argument.string("input").pipe(Argument.withDescription("JSON object, @file, or - for stdin")),
},({input})=>executeJsonCommand("machine install-local",loadJsonInput(MachineInstallInput,input).pipe(Effect.flatMap(installMachine))));

export const machineCommand = Command.make("machine").pipe(
  Command.withDescription("Install and manage Junto on machines"),
  Command.withSubcommands([installLocal]),
);
