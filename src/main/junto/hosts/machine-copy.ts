import { Effect, Schema, Stream } from "effect";
import { MachineBuild, MachineConfigured, MachinePeerPin, type MachineCopyInput } from "@shared/machine-control";
import { MachineInstallError, MachineInstallResult, MachineSetupError } from "@shared/machine-install";
import type { MachineSendEvent } from "@shared/machine-progress";
import type { InstallationId } from "@shared/installation-id";
import type { RemoteHost } from "@shared/remote-hosts";
import { OperatorErrorBody } from "@shared/operator-control";
import { MachineRepository } from "../machines/repository";
import { parseHostSshRoute, SshTransport, type ScopedStreamProgram } from "../ssh";
import { SshTransferExitError } from "../ssh/service";
import { configureMachine, setupMachine, machinePlatform } from "../ssh/machine-owner-commands";
import { inspectMachineBundle } from "./bundle";
import { sendMachine } from "./send";
import { HostsService } from "./service";

type Target = "darwin-arm64" | "linux-x64";
export interface MachineCopyOptions {
  readonly build: string;
  readonly bundles: Readonly<Partial<Record<Target, string>>>;
  readonly connectSetup: (host: RemoteHost, expectedInstallationId: InstallationId) => Effect.Effect<unknown, unknown>;
  readonly connect: (host: RemoteHost) => Effect.Effect<unknown, unknown>;
  readonly disconnect: (name: string) => Effect.Effect<void, unknown>;
}
const staged = (cause: unknown) => new MachineInstallError({ message: cause instanceof Error ? cause.message : String(cause), disposition: "staged", retryable: false });
const ConfigureResponse = Schema.Struct({ ok: Schema.Literal(true), command: Schema.Literal("machine configure"), data: MachineConfigured });
const SetupResponse = Schema.Struct({ ok: Schema.Literal(true), command: Schema.Literal("machine setup"), data: MachinePeerPin });

/** Explicit send completes setup through a checked first hello; update uses an existing pin only. */
export const makeMachineCopy = (options: MachineCopyOptions) => Effect.gen(function* () {
  const machines = yield* MachineRepository;
  const hosts = yield* HostsService;
  const ssh = yield* SshTransport;
  const build = yield* Schema.decodeUnknownEffect(MachineBuild)(options.build);
  const ownerTransfer = (program: ScopedStreamProgram, command: "machine configure" | "machine setup") =>
    ssh.transfer(program, Stream.empty, 30_000).pipe(Effect.catch(cause => {
      if (cause instanceof SshTransferExitError) {
        const failure = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Struct({
          ok: Schema.Literal(false), command: Schema.Literal(command), error: OperatorErrorBody,
        })), { onExcessProperty: "error" })(cause.stderr.trim().split("\n").at(-1));
        if (failure._tag === "Success") return Effect.fail(new Error(failure.success.error.message));
      }
      return Effect.fail(cause);
    }));
  return (host: RemoteHost, input: MachineCopyInput, mode: "send" | "update", onTransition?: (event: MachineSendEvent) => void) => Effect.gen(function* () {
    const pin = yield* machines.peer(host.id);
    if (mode === "update" && pin === undefined) return yield* Effect.fail(staged(new Error("Set up this machine before updating Junto")));
    const target = yield* parseHostSshRoute(host).pipe(Effect.mapError(staged));
    const platform = yield* machinePlatform(target).pipe(Effect.flatMap(program => ssh.run(program)), Effect.mapError(staged));
    const reported = platform.stdout.trim();
    const targetPlatform: Target | undefined = reported === "Darwin arm64" ? "darwin-arm64" : reported === "Linux x86_64" ? "linux-x64" : undefined;
    if (targetPlatform === undefined) return yield* Effect.fail(staged(new Error("This machine's platform is not supported by Junto")));
    const bundle = input.bundle ?? options.bundles[targetPlatform];
    if (bundle === undefined) return yield* Effect.fail(staged(new Error(targetPlatform === "linux-x64" ? "This Junto has no build for a Linux machine" : "This Junto has no build for a Mac machine")));
    const manifest = yield* Effect.tryPromise({ try: () => inspectMachineBundle(bundle), catch: staged });
    if (manifest.build !== build || manifest.target !== targetPlatform) return yield* Effect.fail(staged(new Error("The selected Junto package does not match this build and the target platform")));
    // Existing channels must close before the service can be replaced.
    yield* options.disconnect(host.id).pipe(Effect.mapError(staged));
    const installed = yield* sendMachine(target, {
      bundle,
      ...(host.juntoHome === undefined ? {} : { juntoHome: host.juntoHome }),
      ...(host.installRoot === undefined ? {} : { installRoot: host.installRoot }),
      ...(pin === undefined ? {} : { expectedInstallationId: pin.installationId }),
    }, onTransition).pipe(Effect.provideService(SshTransport, ssh));
    const receipt = yield* Schema.decodeUnknownEffect(MachineInstallResult)(installed, { onExcessProperty: "error" });
    return yield* Effect.gen(function* () {
      if (receipt.build !== build || (pin !== undefined && receipt.installationId !== pin.installationId)) return yield* Effect.fail(new Error("The installed Junto identity does not match the selected machine"));
      if (pin === undefined) {
        const configuredProgram = yield* configureMachine(target, receipt, host.id);
        const configuredOutput = yield* ownerTransfer(configuredProgram, "machine configure");
        const configured = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ConfigureResponse))(configuredOutput.stdout.trim(), { onExcessProperty: "error" });
        if (configured.data.machineName !== host.id || configured.data.installationId !== receipt.installationId) return yield* Effect.fail(new Error("The machine did not keep its selected name and installation identity"));
        const own = { machineName: yield* machines.machineName, installationId: yield* machines.installationId };
        const setupProgram = yield* setupMachine(target, receipt, own);
        const setupOutput = yield* ownerTransfer(setupProgram, "machine setup");
        const setup = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(SetupResponse))(setupOutput.stdout.trim(), { onExcessProperty: "error" });
        if (setup.data.machineName !== own.machineName || setup.data.installationId !== own.installationId) return yield* Effect.fail(new Error("The machine did not bind this Junto installation"));
      } else if (receipt.machineName !== host.id) return yield* Effect.fail(new Error("The machine calls itself another name; keep its setup binding and choose the correct machine"));
      const configuredHost = { ...host, juntoHome: receipt.juntoHome, installRoot: receipt.installRoot };
      yield* hosts.upsert(configuredHost);
      if (pin === undefined) yield* options.connectSetup(configuredHost, receipt.installationId);
      else yield* options.connect(configuredHost);
      return { ...receipt, machineName: host.id };
    }).pipe(Effect.mapError(cause => new MachineSetupError({
      message: `Junto is installed, but could not ${pin === undefined ? "finish setup" : "connect"}: ${cause instanceof Error ? cause.message : String(cause)}. Check this machine before sending again`,
      retryable: false, installed: receipt,
    })));
  });
});
