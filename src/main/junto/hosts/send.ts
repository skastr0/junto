import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { execFile } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { Clock, Effect, Schema } from "effect";
import * as NodeStream from "@effect/platform-node/NodeStream";
import { MachineInstallError, MachineInstallResult, MachineInstallEvent, type MachineSendInput } from "@shared/machine-install";
import { SshTransport, type SshTarget } from "../ssh";
import { SshTransferExitError } from "../ssh/service";
import { SshExitError, SshTimeoutError } from "../ssh/domain";
import { receiveMachineBundle } from "../ssh/machine-commands";
import { machinePreflight } from "../ssh/machine-preflight";
import { inspectMachineBundle } from "./bundle";
import { makeCopyProgress } from "./copy-progress";
import type { MachineSendEvent } from "@shared/machine-progress";

const exec = promisify(execFile);
const installError = (cause:unknown) => {
  const message = cause instanceof SshExitError
    ? cause.detail === "permission denied" ? "SSH refused this account's key. Check SSH access, then send Junto again"
      : `Cannot reach this machine over SSH: ${cause.detail ?? "the connection failed"}. Check its address and SSH access, then send Junto again`
    : cause instanceof SshTimeoutError ? "This machine did not answer over SSH. Check that it is online and reachable, then send Junto again"
    : cause instanceof Error ? cause.message : String(cause);
  return new MachineInstallError({message,retryable:true,disposition:"staged"});
};
const Success = Schema.Struct({ok:Schema.Literal(true),command:Schema.Literal("machine install-local"),data:MachineInstallResult});
const Failure = Schema.Struct({ ok: Schema.Literal(false), command: Schema.Literal("machine install-local"), error: Schema.Struct({
  type: Schema.Literal("MachineInstallError"), message: Schema.String.pipe(Schema.check(Schema.isMaxLength(4096))),
  details: Schema.Struct({ retryable: Schema.Boolean, disposition: MachineInstallError.fields.disposition, transitions: MachineInstallError.fields.transitions }),
}) });

export const sendMachine = (
  target:SshTarget,
  input:Omit<MachineSendInput,"sshTarget">,
  onTransition?: (event: MachineSendEvent) => void,
) => Effect.scoped(Effect.gen(function* () {
  const scratch=yield* Effect.acquireRelease(
    Effect.tryPromise({try:()=>mkdtemp(join(tmpdir(),"junto-send-")),catch:installError}),
    directory=>Effect.tryPromise({try:()=>rm(directory,{recursive:true,force:true}),catch:installError}).pipe(Effect.ignore),
  );
  const archive=join(scratch,"package.tgz");
  const bundle=resolve(input.bundle);
  const manifest = yield* Effect.tryPromise({ try: () => inspectMachineBundle(bundle), catch: installError });
  const checksum=yield* Effect.tryPromise({try:async()=>{
    await exec("tar",["-czf",archive,"-C",bundle,"."],{timeout:120_000,maxBuffer:256*1024,env:{...process.env,COPYFILE_DISABLE:"1"}});
    if ((await stat(archive)).size > 512*1024*1024) throw new Error("machine package exceeds the copy limit");
    const hash=createHash("sha256");
    for await (const chunk of createReadStream(archive)) hash.update(chunk);
    return hash.digest("hex");
  },catch:installError});
  const program=yield* receiveMachineBundle(target,checksum,{
    ...(input.juntoHome===undefined?{}:{juntoHome:input.juntoHome}),
    ...(input.installRoot===undefined?{}:{installRoot:input.installRoot}),
    ...(input.expectedInstallationId===undefined?{}:{expectedInstallationId:input.expectedInstallationId}),
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
  if (checks.stdout !== "ready\n") return yield* Effect.fail(installError(new Error(checks.stdout.trim().slice(0, 4096) || "Cannot check this machine before sending Junto")));
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
  const transferError = (cause: unknown): MachineInstallError => {
    if (cause instanceof SshTransferExitError) {
      const decoded = Schema.decodeUnknownResult(Schema.fromJsonString(Failure), { onExcessProperty: "error" })(cause.stderr.trim().split("\n").at(-1));
      if (decoded._tag === "Success") return new MachineInstallError({ message: decoded.success.error.message,
        disposition: decoded.success.error.details.disposition, retryable: false,
        ...(decoded.success.error.details.transitions === undefined ? {} : { transitions: decoded.success.error.details.transitions }),
      });
    }
    return new MachineInstallError({ message: cause instanceof Error ? cause.message : String(cause), retryable: false, disposition: "uncertain", transitions });
  };
  const result=yield* ssh.transfer(program,NodeStream.fromReadable({evaluate:()=>createReadStream(archive),onError:installError}),20*60_000,observe,
    bytes => copy.advance(bytes, clock.currentTimeMillisUnsafe())).pipe(Effect.mapError(transferError));
  const response=yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Success))(result.stdout.trim(), { onExcessProperty: "error" }).pipe(Effect.mapError(transferError));
  return response.data;
}));
