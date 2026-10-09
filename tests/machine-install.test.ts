import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { chmod, mkdir, mkdtemp, readFile, readlink, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { readlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ home: "", root: "", loaded: false, pid: 0, stopped: false, stopFailure: false, startFailure: false, copiedFrom: "", collideCopy: false, stopSelections: [] as string[], starts: 0, definitionRemoved: false }));
vi.mock("node:os", async original => ({ ...await original<typeof import("node:os")>(), homedir: () => fixture.home }));
vi.mock("node:fs/promises", async original => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs, cp: async (source: string, destination: string, options: Parameters<typeof fs.cp>[2]) => {
    if (fixture.collideCopy) {
      await fs.mkdir(join(destination, "core"), { recursive: true, mode: 0o700 });
      await fs.writeFile(join(destination, "core/junto.cjs"), "collision\n", { mode: 0o600 });
    }
    return fs.cp(fixture.copiedFrom || source, destination, options);
  } };
});
vi.mock("../src/main/junto/process-epoch", () => ({
  readSingleProcessEpochSnapshot: (pid: number) => fixture.stopped ? [] : [{ pid, startKey: "incumbent" }],
}));
vi.mock("../src/main/junto/hosts/install-service", () => ({
  machineService: async () => ({
    provider: "launchd",
    observe: async () => ({ loaded: fixture.loaded, pid: fixture.pid }),
    stop: async () => {
      fixture.stopSelections.push(await readlink(join(fixture.root, "current")));
      if (fixture.stopFailure) throw new Error("stop outcome unknown");
      fixture.stopped = true; fixture.loaded = false; fixture.pid = 0;
    },
    start: async () => {
      fixture.starts++;
      if (fixture.startFailure) throw new Error("start outcome unknown");
      fixture.loaded = true; fixture.pid = 71;
      const generation = await readlink(join(fixture.root, "current"));
      const manifest = JSON.parse(await readFile(join(fixture.root, generation, "manifest.json"), "utf8"));
      await writeFile(join(fixture.home, ".status.json"), JSON.stringify({ ok: true, command: "machine status", data: { build: manifest.build, installationId: "install-one", machineName: "mini", juntoHome: fixture.home, pid: 71, ready: true, form: "mac-mini" } }));
    },
    removeDefinition: async () => { fixture.definitionRemoved = true; },
  }),
}));

import { installMachine, machineServiceLabel } from "../src/main/junto/hosts/install";
import { uninstallMachine } from "../src/main/junto/hosts/uninstall";
import { machineBundleFiles } from "../src/main/junto/hosts/bundle";
import { writeMachineServiceFile } from "../src/main/junto/hosts/install-paths";
import { acquireInstallLock, admitInstallLockRoot, type OwnedInstallLockRoot } from "../src/main/junto/hosts/install-lock";

let scratch: string;
const makeBundle = async (build: string): Promise<string> => {
  const bundle = join(scratch, "bundle-" + build[0]);
  await mkdir(join(bundle, "bin"), { recursive: true, mode: 0o700 });
  await mkdir(join(bundle, "core"), { mode: 0o700 });
  await writeFile(join(bundle, "bin/node"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await writeFile(join(bundle, "bin/junto"), '#!/bin/sh\ncat "$JUNTO_HOME/.status.json"\n', { mode: 0o755 });
  await writeFile(join(bundle, "core/junto.cjs"), "fixture\n");
  await writeFile(join(bundle, "manifest.json"), JSON.stringify({ build, target: `${process.platform}-${process.arch}`, node: "fixture", appVersion: "fixture", files: await machineBundleFiles(bundle) }));
  return bundle;
};
const install = (bundle: string) => Effect.runPromise(installMachine({ bundle, juntoHome: fixture.home, installRoot: fixture.root }));
const errorFrom = async (bundle: string) => Effect.runPromise(installMachine({ bundle, juntoHome: fixture.home, installRoot: fixture.root }).pipe(Effect.flip));

beforeEach(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), "junto-install-test-")));
  Object.assign(fixture, { home: scratch, root: join(scratch, "install"), loaded: false, pid: 0, stopped: false, stopFailure: false, startFailure: false, copiedFrom: "", collideCopy: false, stopSelections: [], starts: 0, definitionRemoved: false });
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(async () => { vi.restoreAllMocks(); await rm(scratch, { recursive: true, force: true }); });

// Installation runs in the packaged Bun CLI. The Node test runner launches
// that runtime to exercise these cases rather than mocking the kernel lease.
if (typeof Bun === "undefined") it("exercises the installer in its packaged CLI runtime", async () => {
  await promisify(execFile)("bun", ["--bun", "node_modules/vitest/vitest.mjs", "run", "tests/machine-install.test.ts"], { cwd: process.cwd(), timeout: 30_000, maxBuffer: 256 * 1024 });
}, 35_000);
else describe("machine install", () => {
  it("serializes sends with a kernel lease and reuses an abandoned empty lock directory", async () => {
    await mkdir(join(fixture.root, ".install-lock"), { recursive: true, mode: 0o700 });
    await writeFile(join(fixture.root, "owner.json"), "owned", { mode: 0o600 });
    const handle = await admitInstallLockRoot(fixture.root, "owned");
    const release = await acquireInstallLock(handle);
    try { await expect(acquireInstallLock(handle)).rejects.toThrow("already being sent"); }
    finally { await release(); }
    // The durable lease file can remain. Kernel ownership ended at release.
    expect(await readFile(join(fixture.root, ".install-lock/lease"), "utf8")).toBe("");
    await (await acquireInstallLock(handle))();
    await expect(acquireInstallLock({} as OwnedInstallLockRoot)).rejects.toThrow("owned installation");
    await expect(admitInstallLockRoot(fixture.root, "other")).rejects.toThrow("another Junto installation");
  });

  it("releases the kernel lease when the installer exits without cleanup", async () => {
    await mkdir(fixture.root, { mode: 0o700 });
    await writeFile(join(fixture.root, "owner.json"), "owned", { mode: 0o600 });
    const leaseModule = pathToFileURL(join(process.cwd(), "src/main/junto/hosts/install-lock.ts")).href;
    const source = `import {acquireInstallLock, admitInstallLockRoot} from ${JSON.stringify(leaseModule)};
const release = await acquireInstallLock(await admitInstallLockRoot(${JSON.stringify(fixture.root)}, "owned"));
console.log("locked");
if (process.argv.at(-1) === "hold") { for await (const _ of process.stdin) {} process.exit(17); }
await release();`;
    const environment = { ...process.env, HOME: fixture.home };
    const child = spawn(process.execPath, ["--eval", source, "hold"], { env: environment, stdio: ["pipe", "pipe", "pipe"] });
    const closed = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    const ready = new Promise<void>((resolve, reject) => {
      let output = "", detail = "";
      child.stdout.on("data", bytes => { output += String(bytes); if (output === "locked\n") resolve(); });
      child.stderr.on("data", bytes => { detail += String(bytes); });
      void closed.then(() => reject(new Error(detail || "lease process exited before admission")), reject);
    });
    try {
      await ready;
      await expect(promisify(execFile)(process.execPath, ["--eval", source, "once"], { env: environment })).rejects.toThrow("already being sent");
    } finally { child.stdin.end(); await closed; }
    expect(await closed).toBe(17);
    expect((await promisify(execFile)(process.execPath, ["--eval", source, "once"], { env: environment })).stdout).toBe("locked\n");
  });

  it("refuses a linked lease without touching its target", async () => {
    await mkdir(join(fixture.root, ".install-lock"), { recursive: true, mode: 0o700 });
    await writeFile(join(fixture.root, "owner.json"), "owned", { mode: 0o600 });
    const target = join(scratch, "untouched");
    await writeFile(target, "keep", { mode: 0o600 });
    await symlink(target, join(fixture.root, ".install-lock/lease"));
    await expect(acquireInstallLock(await admitInstallLockRoot(fixture.root, "owned"))).rejects.toThrow(/regular file|not writable by others/);
    expect(await readFile(target, "utf8")).toBe("keep");
  });

  it("verifies readiness and stops the incumbent before selecting the next build", async () => {
    const first = await install(await makeBundle("a".repeat(64)));
    expect(first.disposition).toBe("ready");
    let selectedAtReceipt = "";
    vi.mocked(process.stderr.write).mockImplementation(chunk => {
      const event = JSON.parse(String(chunk));
      if (event.step === "quiescent") selectedAtReceipt = readlinkSync(join(fixture.root, "current"));
      return true;
    });
    const second = await install(await makeBundle("b".repeat(64)));
    expect(second.installationId).toBe(first.installationId);
    expect(second.build).toBe("b".repeat(64));
    expect(second.transitions.map(event => event.step)).toEqual(["verified", "quiescent", "selected", "started", "ready"]);
    expect(second.transitions[1]).toEqual({ step: "quiescent", build: first.build, pid: 71, startKey: "incumbent", service: "unloaded" });
    expect(selectedAtReceipt).toContain(first.build);
    expect(fixture.stopSelections).toEqual([`builds/${"a".repeat(64)}-${process.platform}-${process.arch}`]);
  });

  it("installs into private directories under a permissive ambient umask", async () => {
    const bundle = await makeBundle("a".repeat(64));
    await mkdir(join(bundle, "core/nested/deeper"), { recursive: true, mode: 0o700 });
    await writeFile(join(bundle, "core/nested/deeper/module.cjs"), "nested\n", { mode: 0o644 });
    const manifest = JSON.parse(await readFile(join(bundle, "manifest.json"), "utf8"));
    manifest.files = await machineBundleFiles(bundle);
    await writeFile(join(bundle, "manifest.json"), JSON.stringify(manifest));
    const prior = process.umask(0);
    try {
      const installed = await install(bundle);
      expect(installed.disposition).toBe("ready");
      for (const relative of ["", "bin", "core", "core/nested", "core/nested/deeper"]) {
        expect((await stat(join(installed.directory, relative))).mode & 0o777).toBe(0o700);
      }
      expect((await stat(join(installed.directory, "core/nested/deeper/module.cjs"))).mode & 0o777).toBe(0o644);
    } finally { process.umask(prior); }
  });

  it("verifies bytes on an idempotent resend before accepting the running core", async () => {
    const bundle = await makeBundle("a".repeat(64));
    const first = await install(bundle);
    expect((await install(bundle)).updated).toBe(false);
    expect(fixture.starts).toBe(1);
    await writeFile(join(first.directory, "core/junto.cjs"), "changed\n");
    const error = await errorFrom(bundle);
    expect(error.message).toContain("do not match");
    expect(error.disposition).toBe("staged");
    expect(fixture.starts).toBe(1);
  });

  it("rejects a different, self-consistent bundle substituted during copy", async () => {
    const bundle = await makeBundle("a".repeat(64));
    fixture.copiedFrom = await makeBundle("b".repeat(64));
    const error = await errorFrom(bundle);
    expect(error.message).toContain("differs from the bundle");
    expect(fixture.starts).toBe(0);
  });

  it("refuses an existing copy destination file before activation", async () => {
    const bundle = await makeBundle("a".repeat(64));
    fixture.collideCopy = true;
    const error = await errorFrom(bundle);
    expect(error.message).toContain("copy destination already exists");
    expect(error.disposition).toBe("staged");
    expect(fixture.starts).toBe(0);
    expect(await readFile(join(bundle, "core/junto.cjs"), "utf8")).toBe("fixture\n");
  });

  it.each(["builds", "logs", "owner.json"])("refuses a symlink at %s without touching its target", async name => {
    const bundle = await makeBundle("a".repeat(64));
    await install(bundle);
    const path = join(fixture.root, name);
    await rm(path, { recursive: true, force: true });
    const victim = join(scratch, "victim");
    await writeFile(victim, "keep");
    await symlink(victim, path);
    expect((await errorFrom(bundle)).disposition).toBe("staged");
    expect(await readFile(victim, "utf8")).toBe("keep");
  });

  it("keeps the old selection and forbids retry when stop is uncertain", async () => {
    await install(await makeBundle("a".repeat(64)));
    fixture.stopFailure = true;
    const error = await errorFrom(await makeBundle("b".repeat(64)));
    expect(error.disposition).toBe("uncertain");
    expect(error.retryable).toBe(false);
    expect(await readlink(join(fixture.root, "current"))).toContain("a".repeat(64));
  });

  it("keeps the activated candidate and forbids retry when start fails", async () => {
    const bundle = await makeBundle("a".repeat(64));
    fixture.startFailure = true;
    const error = await errorFrom(bundle);
    expect(error.disposition).toBe("activated");
    expect(error.retryable).toBe(false);
    expect(error.message).toContain("Nothing is running there. Send a fixed build to recover");
    expect(fixture.definitionRemoved).toBe(true);
    expect(await readlink(join(fixture.root, "current"))).toContain("a".repeat(64));
    fixture.startFailure = false;
    expect((await install(await makeBundle("b".repeat(64)))).disposition).toBe("ready");
  });

  it("stops a timed-out candidate, removes its autostart and reports the bounded service error", async () => {
    await mkdir(join(fixture.root, "logs"), { recursive: true, mode: 0o700 });
    // Establish an installation marker before writing a diagnostic fixture.
    await writeFile(join(fixture.root, "owner.json"), JSON.stringify({ serviceLabel: machineServiceLabel(fixture.root, fixture.home), juntoHome: fixture.home }), { mode: 0o600 });
    await writeFile(join(fixture.root, "logs/stderr.log"), "Error: fixture core exited at start\n", { mode: 0o600 });
    let elapsed = 0;
    vi.spyOn(Date, "now").mockImplementation(() => elapsed += 30_000);
    const error = await errorFrom(await makeBundle("a".repeat(64)));
    expect(error.disposition).toBe("activated");
    expect(error.message).toContain("Nothing is running there");
    expect(error.message).toContain("fixture core exited at start");
    expect(fixture.loaded).toBe(false);
    expect(fixture.pid).toBe(0);
    expect(fixture.definitionRemoved).toBe(true);
    expect(await readlink(join(fixture.root, "current"))).toContain("a".repeat(64));
  });

  it("does not claim nothing is running when failed-candidate shutdown is uncertain", async () => {
    fixture.stopFailure = true;
    let elapsed = 0;
    vi.spyOn(Date, "now").mockImplementation(() => elapsed += 30_000);
    const error = await errorFrom(await makeBundle("a".repeat(64)));
    expect(error.disposition).toBe("uncertain");
    expect(error.message).toContain("stopping it could not be confirmed");
    expect(error.message).not.toContain("Nothing is running there");
    expect(fixture.definitionRemoved).toBe(false);
  });

  it("refuses writable ancestors and symlinked service files", async () => {
    const bundle = await makeBundle("a".repeat(64));
    await mkdir(fixture.root, { mode: 0o777 });
    await chmod(fixture.root, 0o777);
    expect((await errorFrom(bundle)).message).toContain("not writable by others");
    const victim = join(scratch, "victim");
    await writeFile(victim, "keep");
    const service = join(scratch, "service");
    await symlink(victim, service);
    await expect(writeMachineServiceFile(service, "replace")).rejects.toThrow(/regular file|not writable by others/);
    expect(await readFile(victim, "utf8")).toBe("keep");
  });

  it("uninstalls only the quiesced owned service and retains package and home bytes", async () => {
    const installed = await install(await makeBundle("a".repeat(64)));
    const result = await Effect.runPromise(uninstallMachine({ juntoHome: fixture.home, installRoot: fixture.root }));
    expect(result.disposition).toBe("stopped");
    expect(result.transitions[0]).toMatchObject({ step: "quiescent", pid: 71, startKey: "incumbent", service: "unloaded" });
    expect(fixture.definitionRemoved).toBe(true);
    expect(await readFile(join(installed.directory, "core/junto.cjs"), "utf8")).toBe("fixture\n");
    expect(await readFile(join(fixture.home, ".status.json"), "utf8")).toContain("install-one");
  });

  it("leaves the service definition alone when uninstall stop is uncertain", async () => {
    await install(await makeBundle("a".repeat(64)));
    fixture.stopFailure = true;
    const error = await Effect.runPromise(uninstallMachine({ juntoHome: fixture.home, installRoot: fixture.root }).pipe(Effect.flip));
    expect(error.disposition).toBe("uncertain");
    expect(error.retryable).toBe(false);
    expect(fixture.definitionRemoved).toBe(false);
  });
});
