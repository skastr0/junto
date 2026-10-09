import { chmod, mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { readlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ home: "", root: "", loaded: false, pid: 0, stopped: false, stopFailure: false, startFailure: false, copiedFrom: "", stopSelections: [] as string[], starts: 0, definitionRemoved: false }));
vi.mock("node:os", async original => ({ ...await original<typeof import("node:os")>(), homedir: () => fixture.home }));
vi.mock("node:fs/promises", async original => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs, cp: (source: string, destination: string, options: Parameters<typeof fs.cp>[2]) => fs.cp(fixture.copiedFrom || source, destination, options) };
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
      await writeFile(join(fixture.home, ".status.json"), JSON.stringify({ ok: true, command: "machine status", data: { build: manifest.build, installationId: "install-one", machineName: "mini", juntoHome: fixture.home, pid: 71, ready: true } }));
    },
    removeDefinition: async () => { fixture.definitionRemoved = true; },
  }),
}));

import { installMachine } from "../src/main/junto/hosts/install";
import { uninstallMachine } from "../src/main/junto/hosts/uninstall";
import { machineBundleFiles } from "../src/main/junto/hosts/bundle";
import { writeMachineServiceFile } from "../src/main/junto/hosts/install-paths";

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
  Object.assign(fixture, { home: scratch, root: join(scratch, "install"), loaded: false, pid: 0, stopped: false, stopFailure: false, startFailure: false, copiedFrom: "", stopSelections: [], starts: 0, definitionRemoved: false });
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(async () => { vi.restoreAllMocks(); await rm(scratch, { recursive: true, force: true }); });

describe("machine install", () => {
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
    expect(await readlink(join(fixture.root, "current"))).toContain("a".repeat(64));
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
    await expect(writeMachineServiceFile(service, "replace")).rejects.toThrow("regular file");
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
