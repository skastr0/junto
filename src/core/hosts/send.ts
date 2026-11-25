import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { execFile } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { Clock, Effect, Schema } from "effect";
import * as NodeStream from "@effect/platform-node/NodeStream";
import { MACHINE_INSTALL_CHECKS, MachineInstallError, MachineInstallResult, MachineInstallEvent, type MachineInstallCheck, type MachineSendInput } from "@shared/machine-install";
import { installCheckWords } from "./install-check-words";
import { InstallationId } from "@shared/installation-id";
import { SshTransport, type SshTarget } from "../ssh";
import { SshTransferExitError } from "../ssh/service";
import { SshExitError, SshTimeoutError } from "../ssh/domain";
import { receiveMachineBundle } from "../ssh/machine-commands";
import { machinePreflight } from "../ssh/machine-preflight";
import { inspectMachineBundle } from "../../node/hosts/bundle";
import { makeCopyProgress } from "./copy-progress";
import { failureHere } from "./failure-here";
import { LogService } from "../../node/observability/logger";
import { scrubText } from "../../node/credentials/scrub";
import type { MachineSendEvent } from "@shared/machine-progress";
import { MACHINE_ARCHIVE_TIMEOUT_MS, MACHINE_TRANSFER_TIMEOUT_MS } from "@shared/machine-command-bounds";

const exec = promisify(execFile);
/** The preflight script printed something other than ready; its words arrive scrubbed. */
export class MachinePreflightRefused extends Schema.TaggedError<MachinePreflightRefused>()("MachinePreflightRefused", { message: Schema.String }) {}
export class MachinePackageTooLarge extends Schema.TaggedError<MachinePackageTooLarge>()("MachinePackageTooLarge", { message: Schema.String, limitBytes: Schema.Number }) {}
/** Packing the bundle failed or ran out of time; it says which, by name and limit, never the command it ran. */
export class MachineArchiveFailed extends Schema.TaggedError<MachineArchiveFailed>()("MachineArchiveFailed", {
  message: Schema.String, timedOut: Schema.Boolean, limitMs: Schema.Number,
}) {}
export const archiveFailure = (cause: unknown, machine: string, limitMs: number = MACHINE_ARCHIVE_TIMEOUT_MS): MachineArchiveFailed => {
  const failed: { readonly killed?: unknown; readonly code?: unknown; readonly stderr?: unknown } =
    cause !== null && typeof cause === "object" ? cause : {};
  const minutes = `${String(Math.round(limitMs / 60_000))} minute`;
  if (failed.killed === true) return new MachineArchiveFailed({ timedOut: true, limitMs,
    message: `Packing Junto on ${machine} took longer than its ${minutes} limit, so nothing was sent. ${machine} may be busy; send Junto again when it is quieter` });
  const said = typeof failed.stderr === "string" ? scrubText(failed.stderr.trim()).split("\n").at(-1)?.slice(0, 512) : undefined;
  const exit = typeof failed.code === "number" ? `it exited ${String(failed.code)}` : "it could not run";
  return new MachineArchiveFailed({ timedOut: false, limitMs,
    message: `Packing Junto on ${machine} failed, so nothing was sent: ${exit}${said ? `, saying ${said}` : ""}` });
};
const installErrorWith = (machine: string) => (cause: unknown) => {
  // Only a whole sentence written here is the core's own words; one carrying an SSH detail or a cause's message is not.
  const own = (cause instanceof SshExitError && cause.detail === "permission denied") || cause instanceof SshTimeoutError;
  const message = cause instanceof SshExitError
    ? cause.detail === "permission denied" ? "SSH refused this account's key. Check SSH access, then send Junto again"
      : `Cannot reach this machine over SSH: ${cause.detail ?? "the connection failed"}. Check its address and SSH access, then send Junto again`
    : cause instanceof SshTimeoutError ? "This machine did not answer over SSH. Check that it is online and reachable, then send Junto again"
    : cause instanceof Error ? cause.message : String(cause);
  return new MachineInstallError({message,retryable:true,disposition:"staged",...(own ? { ownWords: true as const } : {}),...failureHere(cause, machine)});
};
const Success = Schema.Struct({ok:Schema.Literal(true),command:Schema.Literal("machine install-local"),data:MachineInstallResult});
const Failure = Schema.Struct({ ok: Schema.Literal(false), command: Schema.Literal("machine install-local"), error: Schema.Struct({
  type: Schema.Literal("MachineInstallError"), message: Schema.String.pipe(Schema.check(Schema.isMaxLength(4096))),
  details: Schema.Struct({
    retryable: Schema.Boolean,
    disposition: MachineInstallError.fields.disposition,
    transitions: MachineInstallError.fields.transitions,
    runningSeats: MachineInstallError.fields.runningSeats,
    runningSeatsUnknown: MachineInstallError.fields.runningSeatsUnknown,
    // Checked by admitCheck, not here: a code this side does not know is dropped and the rest still decodes.
    check: Schema.optionalKey(Schema.Unknown),
    // Checked by admitStarted, not here: kept only as an InstallationId under installation-changed.
    startedInstallationId: Schema.optionalKey(Schema.Unknown),
  }),
}) });
/** A far code, admitted only when it is one of this side's own: anything else is dropped. */
/** The started core's id on installation-changed, only as an InstallationId: anything else is dropped. Display only. */
const admitStarted = (check: MachineInstallCheck | undefined, value: unknown): InstallationId | undefined => {
  if (check !== "installation-changed") return undefined;
  const decoded = Schema.decodeUnknownResult(InstallationId)(value);
  return decoded._tag === "Success" ? decoded.success : undefined;
};
const admitCheck = (value: unknown): MachineInstallCheck | undefined =>
  typeof value === "string" && value.length <= 64 && /^[a-z][a-z-]*$/.test(value)
    && (MACHINE_INSTALL_CHECKS as ReadonlyArray<string>).includes(value) ? value as MachineInstallCheck : undefined;
/** The far machine's text as one log line: scrubbed, no control characters, line breaks or bidi controls, at most 2 KB. */
export const farLogLine = (text: string): string => scrubText(text).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]+/g, " ").slice(0, 2048);

export const sendMachine = (
  target:SshTarget,
  input:Omit<MachineSendInput,"sshTarget">,
  onTransition?: (event: MachineSendEvent) => void,
  /** This machine's own name for the target, from its list: the take-over line's name, never the far's. */
  takeoverName?: string,
) => Effect.scoped(Effect.gen(function* () {
  const machine = (yield* LogService).machine();
  const installError = installErrorWith(machine);
  const scratch=yield* Effect.acquireRelease(
    Effect.tryPromise({try:()=>mkdtemp(join(tmpdir(),"junto-send-")),catch:installError}),
    // A private temp directory; a cleanup failure is logged, never the send's result.
    directory=>Effect.tryPromise(()=>rm(directory,{recursive:true,force:true})).pipe(
      Effect.catch(cause=>Effect.logWarning("a machine send scratch directory could not be removed", cause)),
      Effect.annotateLogs({ area: "machines", operation: "send-cleanup" })),
  );
  const archive=join(scratch,"package.tgz");
  const bundle=resolve(input.bundle);
  const manifest = yield* Effect.tryPromise({ try: () => inspectMachineBundle(bundle), catch: installError });
  const checksum=yield* Effect.tryPromise({try:async()=>{
    await exec("tar",["-czf",archive,"-C",bundle,"."],{timeout:MACHINE_ARCHIVE_TIMEOUT_MS,maxBuffer:256*1024,env:{...process.env,COPYFILE_DISABLE:"1"}})
      .catch((cause: unknown) => { throw archiveFailure(cause, machine); });
    if ((await stat(archive)).size > 512*1024*1024) throw new MachinePackageTooLarge({ message: "machine package exceeds the copy limit", limitBytes: 512 * 1024 * 1024 });
    const hash=createHash("sha256");
    for await (const chunk of createReadStream(archive)) hash.update(chunk);
    return hash.digest("hex");
  },catch:installError});
  const program=yield* receiveMachineBundle(target,checksum,{
    ...(input.juntoHome===undefined?{}:{juntoHome:input.juntoHome}),
    ...(input.installRoot===undefined?{}:{installRoot:input.installRoot}),
    ...(input.expectedInstallationId===undefined?{}:{expectedInstallationId:input.expectedInstallationId}),
    ...(input.stopRunningSeats===true?{stopRunningSeats:true}:{}),
  }).pipe(Effect.mapError(installError));
  const ssh=yield* SshTransport;
  const archiveBytes = yield* Effect.tryPromise({ try: async () => (await stat(archive)).size, catch: installError });
  const preflight = yield* machinePreflight(target, {
    target: manifest.target,
    requiredKiB: Math.ceil((archiveBytes + 2 * manifest.files.reduce((sum, file) => sum + file.bytes, 0) + 32 * 1024 * 1024) / 1024),
    ...(input.juntoHome === undefined ? {} : { juntoHome: input.juntoHome }),
    ...(input.installRoot === undefined ? {} : { installRoot: input.installRoot }),
  }).pipe(Effect.mapError(installError));
  const checks = yield* ssh.run(preflight).pipe(Effect.mapError(installError));
  if (checks.stdout !== "ready\n") return yield* Effect.fail(installError(new MachinePreflightRefused({ message: scrubText(checks.stdout.trim()).slice(0, 4096) || "Cannot check this machine before sending Junto" })));
  const clock = yield* Clock.Clock;
  const copy = makeCopyProgress(archiveBytes, clock.currentTimeMillisUnsafe(), event => onTransition?.(event));
  yield* Effect.forkScoped(Effect.forever(Effect.sleep("1 second").pipe(
    Effect.andThen(Effect.sync(() => copy.check(clock.currentTimeMillisUnsafe()))),
  )));
  const decodeEvent = Schema.decodeUnknownResult(MachineInstallEvent, { onExcessProperty: "error" });
  const decoder = new TextDecoder();
  let pending = "";
  let events = 0;
  const transitions: MachineInstallResult["transitions"][number][] = [];
  let dropped = false;
  const observe = (bytes: Uint8Array): void => {
    if (events >= 5) return;
    for (const part of decoder.decode(bytes, { stream: true }).split(/(?<=\n)/)) {
      if (!dropped) pending += part;
      if (pending.length > 8192) { pending = ""; dropped = true; }
      if (!part.endsWith("\n")) continue;
      if (!dropped) {
        try {
          const event = decodeEvent(JSON.parse(pending));
          if (event._tag === "Success" && events < 5) {
            events++;
            const { event: _event, juntoHome: _home, installRoot: _root, ...transition } = event.success;
            transitions.push(transition);
            onTransition?.(structuredClone(event.success));
          }
        } catch { /* Ordinary SSH diagnostics are not progress events. */ }
      }
      pending = ""; dropped = false;
    }
  };
  const transferError = (cause: unknown): { readonly error: MachineInstallError; readonly check?: MachineInstallCheck; readonly said?: string } => {
    if (cause instanceof SshTransferExitError) {
      const decoded = Schema.decodeUnknownResult(Schema.fromJsonString(Failure), { onExcessProperty: "error" })(cause.stderr.trim().split("\n").at(-1));
      if (decoded._tag === "Success") {
        const { message: said, details } = decoded.success.error;
        // Every field but the words is decided as before: the code picks a sentence and nothing else.
        const decided = {
          disposition: details.disposition, retryable: false,
          ...(details.transitions === undefined ? {} : { transitions: details.transitions }),
          ...(details.runningSeats === undefined ? {} : { runningSeats: details.runningSeats }),
          ...(details.runningSeatsUnknown === undefined ? {} : { runningSeatsUnknown: details.runningSeatsUnknown }),
        };
        const check = admitCheck(details.check);
        const words = check === undefined ? undefined : installCheckWords(check, details.disposition);
        // The far text goes to the log only: the chain behind it would carry it to the companion, so it is left off.
        const started = admitStarted(check, details.startedInstallationId);
        // Display only: it fills the CLI's take-over line and decides nothing above.
        const takeover = started === undefined || takeoverName === undefined || input.expectedInstallationId === undefined ? {}
          : { takeover: { machineName: takeoverName, installationId: started, previousInstallationId: input.expectedInstallationId } };
        if (check !== undefined && words !== undefined) return { error: new MachineInstallError({ message: words, ownWords: true, ...decided, ...takeover }), check, said };
        // The remote's words are data: scrubbed again on receipt.
        return { error: new MachineInstallError({ message: scrubText(said), ...decided, ...failureHere(cause, machine) }) };
      }
    }
    return { error: new MachineInstallError({ message: cause instanceof Error ? cause.message : String(cause), retryable: false, disposition: "uncertain", transitions, ...failureHere(cause, machine) }) };
  };
  const transferFailed = (cause: unknown) => {
    const { error, check, said } = transferError(cause);
    return said === undefined ? Effect.fail(error)
      : Effect.logWarning("the far install refused", { check, said: farLogLine(said) }).pipe(Effect.andThen(Effect.fail(error)));
  };
  const result=yield* ssh.transfer(program,NodeStream.fromReadable({evaluate:()=>createReadStream(archive),onError:installError}),MACHINE_TRANSFER_TIMEOUT_MS,observe,
    bytes => copy.advance(bytes, clock.currentTimeMillisUnsafe())).pipe(Effect.catch(transferFailed));
  const response=yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Success))(result.stdout.trim(), { onExcessProperty: "error" }).pipe(Effect.mapError(cause => transferError(cause).error));
  return response.data;
}));
