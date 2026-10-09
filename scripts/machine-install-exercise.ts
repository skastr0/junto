/**
 * Packaged install acceptance, using two genuine bundles in a disposable home.
 * Run under with-app-run-lock.sh with {sshTarget,bundle,updateBundle} JSON.
 * Any uncertain failure preserves the remote root for explicit inspection.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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

const Input = Schema.Struct({
  sshTarget: MachineSendInput.fields.sshTarget,
  sshPort: MachineSendInput.fields.sshPort,
  sshIdentityFile: MachineSendInput.fields.sshIdentityFile,
  sshKnownHostsFile: MachineSendInput.fields.sshKnownHostsFile,
  sshHostKeyAlias: MachineSendInput.fields.sshHostKeyAlias,
  bundle: MachineAbsolutePath,
  updateBundle: MachineAbsolutePath,
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
const CREATE = `import json,os,pathlib,tempfile,sys
p=pathlib.Path(tempfile.mkdtemp(prefix='.junto-install-exercise-',dir=pathlib.Path.home()))
(p/'exercise-owner').write_text(sys.argv[1])
print(json.dumps({'root':str(p)}))`;
const OBSERVE = `import json,os,pathlib,re,subprocess,sys
x=json.loads(sys.argv[1]); root=pathlib.Path(x['root'])
assert not root.is_symlink() and root.stat().st_uid==os.getuid()
assert (root/'exercise-owner').read_text()==x['owner']
home=root/'home'; install=root/'install'
env={k:v for k,v in os.environ.items() if not k.startswith('JUNTO_')}
env['JUNTO_HOME']=str(home)
r=subprocess.run([str(install/'current/bin/junto'),'machine','status','{}'],env=env,capture_output=True,text=True,timeout=5,check=True)
envelope=json.loads(r.stdout); assert envelope['ok'] is True and envelope['command']=='machine status'
status=envelope['data']; pid=status['pid']; assert isinstance(pid,int) and pid>0
ps=subprocess.run(['/bin/ps','-p',str(pid),'-o','pid=,pgid=,sess=,lstart='],env={**env,'LC_ALL':'C','TZ':'UTC'},capture_output=True,text=True,timeout=5,check=True)
assert not ps.stderr.strip()
line=ps.stdout.strip().split(None,3); assert len(line)==4 and int(line[0])==pid
print(json.dumps({'status':status,'epoch':{'pid':pid,'startKey':line[3]},'selected':os.readlink(install/'current')}))`;
const UNINSTALL = `import json,os,pathlib,subprocess,sys
x=json.loads(sys.argv[1]); root=pathlib.Path(x['root'])
assert not root.is_symlink() and root.stat().st_uid==os.getuid()
assert (root/'exercise-owner').read_text()==x['owner']
home=root/'home'; install=root/'install'
env={k:v for k,v in os.environ.items() if not k.startswith('JUNTO_')}
env.update(JUNTO_HOME=str(home),LC_ALL='C',TZ='UTC')
args=json.dumps({'juntoHome':str(home),'installRoot':str(install)})
r=subprocess.run([str(install/'current/bin/junto'),'machine','uninstall-local',args],env=env,capture_output=True,text=True,timeout=40,check=True)
receipt=json.loads(r.stdout)
assert receipt['ok'] is True and receipt['command']=='machine uninstall-local'
data=receipt['data']; assert data['disposition']=='stopped' and data['definitionRemoved'] is True
assert data['serviceLabel']==x['serviceLabel'] and data['juntoHome']==str(home) and data['installRoot']==str(install)
pid=x['epoch']['pid']; assert isinstance(pid,int) and pid>0
ps=subprocess.run(['/bin/ps','-p',str(pid),'-o','pid=,pgid=,sess=,lstart='],env=env,capture_output=True,text=True,timeout=5)
assert ps.returncode in (0,1) and not ps.stderr.strip()
if ps.stdout.strip():
 line=ps.stdout.strip().split(None,3)
 assert len(line)==4 and int(line[0])==pid and line[3]!=x['epoch']['startKey']
label=x['serviceLabel']
if sys.platform=='darwin':
 definition=pathlib.Path.home()/'Library/LaunchAgents'/(label+'.plist')
 observed=subprocess.run(['/bin/launchctl','print','user/'+str(os.getuid())+'/'+label],capture_output=True,text=True,timeout=5)
 assert observed.returncode==113
else:
 definition=pathlib.Path.home()/'.config/systemd/user'/(label+'.service')
 observed=subprocess.run(['/usr/bin/systemctl','--user','show',label+'.service','--property=LoadState,MainPID'],capture_output=True,text=True,timeout=5,check=True)
 fields=dict(line.split('=',1) for line in observed.stdout.strip().splitlines())
 assert fields=={'LoadState':'not-found','MainPID':'0'}
assert not definition.exists() and not definition.is_symlink()
print(json.dumps({'uninstall':receipt,'epochGone':True,'definitionGone':True,'serviceAbsent':True}))`;
const REMOVE_ROOT = `import json,os,pathlib,shutil,stat,sys
x=json.loads(sys.argv[1]); root=pathlib.Path(x['root']); marker=root/'exercise-owner'
assert root.parent==pathlib.Path.home().resolve() and root.name.startswith('.junto-install-exercise-')
assert not root.is_symlink() and root.stat().st_uid==os.getuid()
assert stat.S_ISREG(marker.lstat().st_mode) and marker.stat().st_uid==os.getuid()
assert marker.read_text()==x['owner']
shutil.rmtree(root)
print(json.dumps({'removed':not root.exists()}))`;

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
  const nextBundle = yield* attempt(() => inspectMachineBundle(input.updateBundle));
  if (firstBundle.build === nextBundle.build || firstBundle.target !== nextBundle.target) {
    return yield* Effect.fail(new Error("provide two different real builds for the same platform"));
  }
  const receipts = yield* attempt(() => mkdtemp(join(tmpdir(), "junto-install-exercise-")));
  const owner = randomUUID();
  yield* attempt(() => writeFile(join(receipts, "exercise-owner"), owner, { mode: 0o600, flag: "wx" }));
  const receipt: { ok: boolean; receipts: string; sshTarget: string; root?: string; steps: Record<string, unknown>; error?: string } = {
    ok: false, receipts, sshTarget: input.sshTarget, steps: {},
  };
  const save = () => attempt(() => writeFile(join(receipts, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n"));
  const ssh = (code: string, argument: string) => Effect.gen(function* () {
    const command = yield* makeRemoteCommand("python3", ["-c", code, argument]);
    const reply = yield* transport.transfer(dedicatedStream(target, command), Stream.empty, 60_000);
    return reply.stdout;
  });
  const run = Effect.gen(function* () {
    const created = yield* ssh(CREATE, owner).pipe(Effect.flatMap(Schema.decodeUnknownEffect(
      Schema.fromJsonString(Schema.Struct({ root: MachineAbsolutePath })))));
    const root = created.root;
    receipt.root = root;
    yield* save();
    const paths = { juntoHome: join(root, "home"), installRoot: join(root, "install") };
    const observe = () => ssh(OBSERVE, JSON.stringify({ root, owner })).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Observation))));
    const first = yield* sendMachine(target, { bundle: input.bundle, ...paths });
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
    const update = yield* sendMachine(target, { bundle: input.updateBundle, ...paths, expectedInstallationId: first.installationId });
    receipt.steps.update = update;
    const afterUpdate = yield* observe();
    receipt.steps.updateStatus = afterUpdate;
    yield* save();
    yield* attempt(async () => {
      requireProof(update.build === nextBundle.build, "update selected the wrong bundle");
      assertOrderedUpdate(resend, afterResend, update, afterUpdate);
    });
    const cleanup = yield* ssh(UNINSTALL, JSON.stringify({ root, owner, serviceLabel: update.serviceLabel, epoch: afterUpdate.epoch })).pipe(
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
    const removed = yield* ssh(REMOVE_ROOT, JSON.stringify({ root, owner })).pipe(
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
