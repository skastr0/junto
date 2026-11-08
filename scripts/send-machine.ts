import { Effect } from "effect";
import { Argument, Command } from "effect/cli";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { MachineSendInput } from "../src/shared/machine-install";
import { loadJsonInput } from "../src/cli/core/json";
import { executeJsonCommand } from "../src/cli/core/output";
import { parseSshRoute, SshTransportLive } from "../src/core/ssh";
import { sendMachine } from "../src/core/hosts/send";
import { createLogger, LogService } from "../src/node/observability/logger";

const log = createLogger({ process: "core", echo: false });

const command=Command.make("send-machine",{input:Argument.String("input")},({input})=>executeJsonCommand("machine send",Effect.gen(function*(){
  const item=yield* loadJsonInput(MachineSendInput,input);
  const target=yield* parseSshRoute({endpoint:item.sshTarget,
    ...(item.sshPort === undefined ? {} : {port:item.sshPort}),
    ...(item.sshIdentityFile === undefined ? {} : {identityFile:item.sshIdentityFile}),
    ...(item.sshKnownHostsFile === undefined ? {} : {knownHostsFile:item.sshKnownHostsFile}),
    ...(item.sshHostKeyAlias === undefined ? {} : {hostKeyAlias:item.sshHostKeyAlias}),
  });
  return yield* sendMachine(target,item);
})));
if(import.meta.main) BunRuntime.runMain(Command.runWith(command,{version:"1"})(process.argv.slice(2)).pipe(Effect.provide(SshTransportLive),Effect.provideService(LogService, log),Effect.provide(BunServices.layer)));
