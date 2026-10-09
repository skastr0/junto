/**
 * Packaged link/install acceptance in disposable homes, with optional real update.
 * Run under with-app-run-lock.sh with {sshTarget,bundle,updateBundle?} JSON.
 * Any uncertain failure preserves the remote root for explicit inspection.
 */
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Effect, Schema, Stream } from "effect";
import { Argument, Command } from "effect/unstable/cli";
import { loadJsonInput } from "../src/cli/core/json";
import { executeJsonCommandWithVerdict } from "../src/cli/core/output";
import { inspectMachineBundle } from "../src/main/junto/hosts/bundle";
import { sendMachine } from "../src/main/junto/hosts/send";
import { parseSshRoute, SshTransport, SshTransportLive } from "../src/main/junto/ssh";
import { makeRemoteCommand } from "../src/main/junto/ssh/domain";
import { dedicatedStream } from "../src/main/junto/ssh/program";
import { MachineOwnStatus } from "../src/shared/machine-control";
import { MachineAbsolutePath, MachineInstallResult, MachineSendInput, MachineUninstallResult } from "../src/shared/machine-install";
import { exerciseMachineLink } from "./machine-link-exercise";

const Input = Schema.Struct({
  sshTarget: MachineSendInput.fields.sshTarget,
  sshPort: MachineSendInput.fields.sshPort,
  sshIdentityFile: MachineSendInput.fields.sshIdentityFile,
  sshKnownHostsFile: MachineSendInput.fields.sshKnownHostsFile,
  sshHostKeyAlias: MachineSendInput.fields.sshHostKeyAlias,
  bundle: MachineAbsolutePath,
  updateBundle: Schema.optionalKey(MachineAbsolutePath),
  localBundle: Schema.optionalKey(MachineAbsolutePath),
  receiptsDirectory: Schema.optionalKey(MachineAbsolutePath),
});
const Epoch = Schema.Struct({ pid: Schema.Number, startKey: Schema.String });
const Observation = Schema.Struct({
  status: MachineOwnStatus,
  epoch: Epoch,
  selected: Schema.String,
});
const Cleanup = Schema.Struct({
  uninstall: Schema.Struct({ ok: Schema.Literal(true), command: Schema.Literal("machine uninstall-local"), data: MachineUninstallResult }),
  epochGone: Schema.Literal(true),
  definitionGone: Schema.Literal(true),
  serviceAbsent: Schema.Literal(true),
});
export type InstallObservation = typeof Observation.Type;

const requireProof = (condition: boolean, message: string): void => {
  if (!condition) throw new Error(message);
};

/** Final status is independent evidence; it does not establish stop ordering. */
export function assertInstallObservation(result: MachineInstallResult, observed: InstallObservation) {
  const status = observed.status;
  requireProof(status.ready, "core did not report ready");
  for (const key of ["build", "installationId", "machineName", "juntoHome", "pid"] as const) {
    requireProof(status[key] === result[key], `independent core status differs at ${key}`);
  }
  requireProof(observed.epoch.pid === result.pid && observed.epoch.startKey.length > 0,
    "could not observe the ready core epoch");
  requireProof(join(result.installRoot, observed.selected) === result.directory,
    "installed selection differs from readiness receipt");
}

export function assertUnchangedResend(first: MachineInstallResult, before: InstallObservation,
  resend: MachineInstallResult, after: InstallObservation) {
  assertInstallObservation(resend, after);
  requireProof(!resend.updated, "identical resend changed the selected package");
  for (const key of ["build", "installationId", "machineName", "juntoHome", "installRoot", "serviceLabel", "provider", "directory", "pid"] as const) {
    requireProof(first[key] === resend[key], `identical resend changed ${key}`);
  }
  requireProof(before.epoch.startKey === after.epoch.startKey, "identical resend restarted the core");
  requireProof(resend.transitions.map(row => row.step).join(",") === "verified,ready",
    "identical resend performed activation steps");
}

export function assertOrderedUpdate(before: MachineInstallResult, observedBefore: InstallObservation,
  update: MachineInstallResult, observedAfter: InstallObservation) {
  assertInstallObservation(update, observedAfter);
  requireProof(update.updated && update.build !== before.build, "update did not select a different real build");
  for (const key of ["installationId", "machineName", "juntoHome", "installRoot", "serviceLabel", "provider"] as const) {
    requireProof(update[key] === before[key], `update changed ${key}`);
  }
  requireProof(update.transitions.map(row => row.step).join(",") === "verified,quiescent,selected,started,ready",
    "update lacks ordered verification, quiescence, selection, start and readiness evidence");
  const stopped = update.transitions[1]!;
  requireProof(stopped.pid === observedBefore.epoch.pid && stopped.startKey === observedBefore.epoch.startKey,
    "quiescence receipt does not name the independently observed incumbent epoch");
  requireProof(stopped.build === before.build, "quiescence receipt does not name the incumbent build");
  requireProof(stopped.service === (update.provider === "launchd" ? "unloaded" : "inactive"),
    "quiescence receipt does not prove the owned service stopped");
  requireProof(update.transitions[0]!.build === update.build && update.transitions[2]!.build === update.build,
    "verified and selected builds differ from the ready core");
  requireProof(update.transitions[4]!.pid === update.pid, "ready transition names another process");
  requireProof(update.pid !== before.pid || observedAfter.epoch.startKey !== observedBefore.epoch.startKey,
    "update still reports the incumbent process epoch");
}

const attempt = <A>(run: () => Promise<A>) => Effect.tryPromise({
  try: run, catch: cause => cause instanceof Error ? cause : new Error(String(cause)),
});
const CREATE = [
  "set -eu", "umask 077",
  'root=$(mktemp -d "$HOME/.junto-install-exercise-XXXXXXXX")',
  'printf %s "$1" > "$root/exercise-owner"',
  'printf "%s\\n" "$root"',
].join("\n");

const exercise = (input: typeof Input.Type) => Effect.gen(function* () {
  if (process.env.JUNTO_APP_RUN_LOCK_HELD !== "1") return yield* Effect.fail(new Error("run through scripts/with-app-run-lock.sh"));
  const target = yield* parseSshRoute({
    endpoint: input.sshTarget,
    identityFile: input.sshIdentityFile,
    port: input.sshPort,
    knownHostsFile: input.sshKnownHostsFile,
    hostKeyAlias: input.sshHostKeyAlias,
  });
  const transport = yield* SshTransport;
  const firstBundle = yield* attempt(() => inspectMachineBundle(input.bundle));
  const nextBundle = input.updateBundle === undefined ? undefined : yield* attempt(() => inspectMachineBundle(input.updateBundle!));
  if (nextBundle !== undefined && (firstBundle.build === nextBundle.build || firstBundle.target !== nextBundle.target)) {
    return yield* Effect.fail(new Error("provide two different real builds for the same platform"));
  }
  const localBundle = input.localBundle ?? input.bundle;
  const localManifest = yield* attempt(() => inspectMachineBundle(localBundle));
  if (localManifest.build !== firstBundle.build || localManifest.target !== `${process.platform}-${process.arch}`) {
    return yield* Effect.fail(new Error("provide a native local bundle with the same build as the first remote bundle"));
  }
  const receiptsDirectory = input.receiptsDirectory ?? join(homedir(), "junto-receipts");
  yield* attempt(() => mkdir(receiptsDirectory, { recursive: true, mode: 0o700 }));
  const receipts = yield* attempt(() => mkdtemp(join(receiptsDirectory, "a-")));
  // Keep the runtime path within macOS sockaddr_un, without disposable receipts.
  if (Buffer.byteLength(join(receipts, "local-home/.junto/operator/control.sock")) > 103) {
    return yield* Effect.fail(new Error("choose a shorter receiptsDirectory for the local owner socket"));
  }
  const owner = randomUUID();
  yield* attempt(() => writeFile(join(receipts, "exercise-owner"), owner, { mode: 0o600, flag: "wx" }));
  const receipt: { ok: boolean; receipts: string; sshTarget: string; root?: string; steps: Record<string, unknown>; error?: string } = {
    ok: false, receipts, sshTarget: input.sshTarget, steps: {},
  };
  const save = () => attempt(() => writeFile(join(receipts, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n"));
  const remoteSource = yield* attempt(() => readFile(new URL("./machine-install-exercise-remote.cjs", import.meta.url), "utf8"));
  const ssh = (operation: string, argument: string) => Effect.gen(function* () {
    const { root } = JSON.parse(argument) as { root: string };
    const code = remoteSource + "\nconsole.log(JSON.stringify(exercise(process.argv[1], JSON.parse(process.argv[2]))));";
    const command = yield* makeRemoteCommand(join(root, "install/current/bin/node"), ["-e", code, operation, argument]);
    const reply = yield* transport.transfer(dedicatedStream(target, command), Stream.empty, 60_000);
    return reply.stdout;
  });
  const run = Effect.gen(function* () {
    const createCommand = yield* makeRemoteCommand("/bin/sh", ["-c", CREATE, "junto-exercise", owner]);
    const created = yield* transport.transfer(dedicatedStream(target, createCommand), Stream.empty, 60_000);
    const root = yield* Schema.decodeUnknownEffect(MachineAbsolutePath)(created.stdout.trim());
    receipt.root = root;
    yield* save();
    const paths = { juntoHome: join(root, "home"), installRoot: join(root, "install") };
    const observe = () => ssh("observe", JSON.stringify({ root, owner })).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Observation))));
    const first = yield* attempt(() => exerciseMachineLink({
      bundle: localBundle, remoteBundle: input.bundle, receipts,
      localName: `exercise-open-${owner.slice(0, 8)}`,
      remote: { name: `exercise-peer-${owner.slice(0, 8)}`, sshTarget: input.sshTarget,
        ...(input.sshPort === undefined ? {} : { sshPort: input.sshPort }),
        ...(input.sshIdentityFile === undefined ? {} : { sshIdentityFile: input.sshIdentityFile }),
        ...(input.sshKnownHostsFile === undefined ? {} : { sshKnownHostsFile: input.sshKnownHostsFile }),
        ...(input.sshHostKeyAlias === undefined ? {} : { sshHostKeyAlias: input.sshHostKeyAlias }),
        ...paths },
      record: async (step, value) => {
        receipt.steps[step] = value;
        await writeFile(join(receipts, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
      },
    }));
    receipt.steps.install = first;
    yield* save();
    const before = yield* observe();
    receipt.steps.firstStatus = before;
    yield* attempt(async () => {
      assertInstallObservation(first, before);
      requireProof(first.updated && first.build === firstBundle.build, "fresh install selected the wrong bundle");
      requireProof(first.juntoHome === paths.juntoHome && first.installRoot === paths.installRoot, "install escaped the exercise paths");
      requireProof(first.transitions.map(row => row.step).join(",") === "verified,quiescent,selected,started,ready",
        "fresh install lacks its verification and readiness sequence");
      requireProof(first.transitions[1]!.service === "absent", "fresh install found an existing service");
    });
    const resend = yield* sendMachine(target, { bundle: input.bundle, ...paths, expectedInstallationId: first.installationId });
    receipt.steps.resend = resend;
    const afterResend = yield* observe();
    receipt.steps.resendStatus = afterResend;
    yield* save();
    yield* attempt(async () => assertUnchangedResend(first, before, resend, afterResend));
    let update = resend;
    let afterUpdate = afterResend;
    if (input.updateBundle !== undefined && nextBundle !== undefined) {
      update = yield* sendMachine(target, { bundle: input.updateBundle, ...paths, expectedInstallationId: first.installationId });
      receipt.steps.update = update;
      afterUpdate = yield* observe();
      receipt.steps.updateStatus = afterUpdate;
      yield* save();
      yield* attempt(async () => {
        requireProof(update.build === nextBundle.build, "update selected the wrong bundle");
        assertOrderedUpdate(resend, afterResend, update, afterUpdate);
      });
    }
    const cleanup = yield* ssh("uninstall", JSON.stringify({ root, owner, serviceLabel: update.serviceLabel, epoch: afterUpdate.epoch })).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Cleanup))));
    receipt.steps.uninstall = cleanup;
    yield* save();
    yield* attempt(async () => {
      const transitions = cleanup.uninstall.data.transitions;
      requireProof(transitions.length === 1 && transitions[0]!.step === "quiescent" &&
        transitions[0]!.pid === update.pid && transitions[0]!.startKey === afterUpdate.epoch.startKey &&
        transitions[0]!.build === update.build &&
        transitions[0]!.service === (update.provider === "launchd" ? "unloaded" : "inactive"),
        "uninstall did not quiesce the observed candidate epoch");
    });
    const removed = yield* ssh("remove", JSON.stringify({ root, owner })).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Struct({ removed: Schema.Literal(true) })))));
    receipt.steps.cleanup = removed;
    receipt.ok = true;
  });
  yield* run.pipe(Effect.catch(cause => Effect.sync(() => {
    receipt.error = cause instanceof Error ? cause.message : String(cause);
    if (cause !== null && typeof cause === "object" && "disposition" in cause) receipt.steps.failure = cause;
  })));
  yield* save();
  return receipt;
});

if (import.meta.main) {
  const { BunRuntime, BunServices } = await import("@effect/platform-bun");
  const command = Command.make("machine-install-exercise", { input: Argument.string("input") }, ({ input }) =>
    executeJsonCommandWithVerdict("machine install exercise", loadJsonInput(Input, input).pipe(
      Effect.flatMap(exercise)), result => !result.ok));
  BunRuntime.runMain(Command.runWith(command, { version: "1" })(process.argv.slice(2)).pipe(
    Effect.provide(SshTransportLive), Effect.provide(BunServices.layer)));
}
