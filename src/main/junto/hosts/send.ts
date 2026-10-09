import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { execFile } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { Effect, Schema } from "effect";
import * as NodeStream from "@effect/platform-node/NodeStream";
import { MachineInstallError, MachineInstallResult, type MachineSendInput } from "@shared/machine-install";
import { SshTransport, type SshTarget } from "../ssh";
import { receiveMachineBundle } from "../ssh/machine-commands";
import { inspectMachineBundle } from "./bundle";

const exec = promisify(execFile);
const installError = (cause:unknown) => new MachineInstallError({message:cause instanceof Error?cause.message:String(cause),retryable:true,disposition:"staged"});
const uncertainError = (cause:unknown) => new MachineInstallError({message:cause instanceof Error?cause.message:String(cause),retryable:false,disposition:"uncertain"});
const Success = Schema.Struct({ok:Schema.Literal(true),command:Schema.Literal("machine install-local"),data:MachineInstallResult});

export const sendMachine = (
  target:SshTarget,
  input:Omit<MachineSendInput,"sshTarget">,
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
  const result=yield* ssh.transfer(program,NodeStream.fromReadable({evaluate:()=>createReadStream(archive),onError:installError}),20*60_000).pipe(Effect.mapError(uncertainError));
  const response=yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Success))(result.stdout.trim()).pipe(Effect.mapError(uncertainError));
  return response.data;
}));
