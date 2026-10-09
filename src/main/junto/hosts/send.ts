import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { execFile } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { Effect, Schema } from "effect";
import * as NodeStream from "@effect/platform-node/NodeStream";
import { MachineInstallError, MachineInstallResult, MachineInstallEvent, type MachineSendInput } from "@shared/machine-install";
import { SshTransport, type SshTarget } from "../ssh";
import { SshTransferExitError } from "../ssh/service";
import { receiveMachineBundle } from "../ssh/machine-commands";
import { inspectMachineBundle } from "./bundle";

const exec = promisify(execFile);
const installError = (cause:unknown) => new MachineInstallError({message:cause instanceof Error?cause.message:String(cause),retryable:true,disposition:"staged"});
const uncertainError = (cause:unknown) => new MachineInstallError({message:cause instanceof Error?cause.message:String(cause),retryable:false,disposition:"uncertain"});
const Success = Schema.Struct({ok:Schema.Literal(true),command:Schema.Literal("machine install-local"),data:MachineInstallResult});
const Failure = Schema.Struct({ ok: Schema.Literal(false), command: Schema.Literal("machine install-local"), error: Schema.Struct({
  type: Schema.Literal("MachineInstallError"), message: Schema.String.pipe(Schema.check(Schema.isMaxLength(4096))),
  details: Schema.Struct({ retryable: Schema.Boolean, disposition: MachineInstallError.fields.disposition, transitions: MachineInstallError.fields.transitions }),
}) });

export const sendMachine = (
  target:SshTarget,
  input:Omit<MachineSendInput,"sshTarget">,
  onTransition?: (event: MachineInstallEvent) => void,
) => Effect.scoped(Effect.gen(function* () {
  const scratch=yield* Effect.acquireRelease(
    Effect.tryPromise({try:()=>mkdtemp(join(tmpdir(),"junto-send-")),catch:installError}),
    directory=>Effect.tryPromise({try:()=>rm(directory,{recursive:true,force:true}),catch:installError}).pipe(Effect.ignore),
  );
  const archive=join(scratch,"package.tgz");
  const bundle=resolve(input.bundle);
  const checksum=yield* Effect.tryPromise({try:async()=>{
    await inspectMachineBundle(bundle);
    await exec("tar",["-czf",archive,"-C",bundle,"."],{timeout:120_000,maxBuffer:256*1024});
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
  const result=yield* ssh.transfer(program,NodeStream.fromReadable({evaluate:()=>createReadStream(archive),onError:installError}),20*60_000,observe).pipe(Effect.mapError(transferError));
  const response=yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Success))(result.stdout.trim(), { onExcessProperty: "error" }).pipe(Effect.mapError(uncertainError));
  return response.data;
}));
