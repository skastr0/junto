import { Effect } from "effect";
import { makeRemoteCommand, type SshTarget } from "./domain";
import { dedicatedStream, oneShot } from "./program";

interface Location { readonly juntoHome: string; readonly installRoot: string }
const ownerCommand = (target: SshTarget, location: Location, op: "configure" | "setup", input: unknown) => Effect.gen(function* () {
  if (![location.juntoHome, location.installRoot].every(path => /^\/[^\u0000-\u001f\u007f]*$/.test(path))) return yield* Effect.fail(new Error("machine owner command requires absolute install paths"));
  const command = yield* makeRemoteCommand("/usr/bin/env", [
    `JUNTO_HOME=${location.juntoHome}`, `${location.installRoot}/current/bin/junto`, "machine", op, JSON.stringify(input),
  ]);
  return dedicatedStream(target, command);
});

export const configureMachine = (target: SshTarget, location: Location, name: string) =>
  ownerCommand(target, location, "configure", { name });
export const setupMachine = (target: SshTarget, location: Location, peer: { readonly machineName: string; readonly installationId: string }) =>
  ownerCommand(target, location, "setup", peer);
export const machinePlatform = (target: SshTarget) =>
  makeRemoteCommand("/usr/bin/uname", ["-sm"]).pipe(Effect.map(command => oneShot(target, command, { budget: "short" })));
