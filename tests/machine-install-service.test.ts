import { mkdtemp, readFile, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const account = vi.hoisted(() => ({ home: "", isLive: (_pid: number): boolean => false }));
vi.mock("node:os", async original => ({ ...await original<typeof import("node:os")>(), homedir: () => account.home }));
vi.mock("../src/main/junto/process-epoch", () => ({
  readSingleProcessEpochSnapshot: (pid: number) => account.isLive(pid) ? [{ pid, startKey: `fixture-${pid}` }] : [],
}));
import { darwinMachineService } from "../src/main/junto/hosts/install-service";
import { removeMachineServiceFile } from "../src/main/junto/hosts/install-paths";

type Job = { pid: number; path: string; program: string; args: string[]; home: string };
let root: string, home: string, file: string;
const label = "dev.junto.machine.test";
const user = `user/${process.getuid!()}`, gui = `gui/${process.getuid!()}`;
let guiExists: boolean, failure: string, injectLogin: boolean;
let jobs: Map<string, Job>, calls: string[][];
const error = (code: number) => Object.assign(new Error(`launchctl ${code}`), { code });
const ownJob = (pid = 71): Job => ({ pid, path: file, program: join(root, "current/bin/node"), args: [join(root, "current/bin/node"), join(root, "current/core/junto.cjs")], home });
const launchctl = async (args: string[]): Promise<string> => {
  calls.push(args);
  const [op, target] = args;
  if (failure === op) throw error(5);
  if (op === "print" && target === gui) { if (!guiExists) throw error(112); return "gui exists"; }
  const domain = target?.startsWith("gui/") ? gui : user;
  if (domain === gui && !guiExists) {
    if (injectLogin) {
      expect(await readFile(file, "utf8")).toContain("<string>Aqua</string>");
      injectLogin = false; guiExists = true; jobs.set(gui, ownJob(73));
    }
    throw error(112);
  }
  if (op === "print") {
    const job = jobs.get(domain);
    if (!job) throw error(113);
    return `service = {\n path = ${job.path}\n program = ${job.program}\n arguments = {\n${job.args.map(arg => "  " + arg).join("\n")}\n }\n environment = {\n JUNTO_HOME => ${job.home}\n }\n pid = ${job.pid}\n}`;
  }
  if (op === "bootstrap") {
    if (jobs.has(domain)) throw error(5);
    jobs.set(domain, ownJob(72));
  } else if (op === "bootout") jobs.delete(domain);
  else if (op !== "kickstart") throw new Error("unexpected command");
  return "";
};
const service = () => darwinMachineService(root, home, label, launchctl);
const mutations = () => calls.filter(([op]) => op !== "print");
const seed = async (graphical: boolean) => {
  guiExists = graphical;
  const s = await service(); await s.start();
  return s;
};
beforeEach(async () => {
  account.home = await realpath(await mkdtemp(join(tmpdir(), "junto-launchd-test-")));
  root = join(account.home, "install"); home = join(account.home, "state");
  file = join(account.home, "Library/LaunchAgents", label + ".plist");
  guiExists = true; failure = ""; injectLogin = false; jobs = new Map(); calls = [];
  account.isLive = pid => [...jobs.values()].some(job => job.pid === pid);
});
afterEach(async () => { await rm(account.home, { recursive: true, force: true }); });

describe("owned macOS machine service", () => {
  it("starts in the graphical session with an Aqua autostart definition", async () => {
    const s = await seed(true);
    expect(await s.observe()).toEqual({ loaded: true, pid: 72, matchesDesiredPlacement: true });
    const body = await readFile(file, "utf8");
    expect(body).toContain("<key>LimitLoadToSessionType</key><string>Aqua</string>");
    expect(body).toContain("<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>");
    expect(mutations()).toEqual([["bootstrap", gui, file], ["kickstart", `${gui}/${label}`]]);
  });

  it("uses the Background definition when no graphical session exists", async () => {
    const s = await seed(false);
    expect(await s.observe()).toMatchObject({ loaded: true, matchesDesiredPlacement: true });
    expect(await readFile(file, "utf8")).toContain("<key>LimitLoadToSessionType</key><string>Background</string>");
    expect(mutations()).toEqual([["bootstrap", user, file], ["kickstart", `${user}/${label}`]]);
  });

  it("stops the old Background job before replacing its definition and starting in gui", async () => {
    await seed(false); guiExists = true; calls = [];
    const s = await service();
    expect(await s.observe()).toMatchObject({ loaded: true, matchesDesiredPlacement: false });
    await expect(s.start()).rejects.toThrow("quiescent");
    expect(mutations()).toEqual([]);
    await s.stop();
    expect(jobs.size).toBe(0);
    expect(await readFile(file, "utf8")).toContain("<string>Background</string><key>StandardOutPath");
    expect(await s.observe()).toMatchObject({ loaded: false, pid: 0 });
    await s.start();
    expect(jobs.has(gui)).toBe(true); expect(jobs.has(user)).toBe(false);
    expect(mutations()).toEqual([["bootout", `${user}/${label}`], ["bootstrap", gui, file], ["kickstart", `${gui}/${label}`]]);
    expect(await s.observe()).toMatchObject({ matchesDesiredPlacement: true });
  });

  it("falls back to user after the graphical session disappears, replacing an unloaded Aqua definition", async () => {
    await seed(true); guiExists = false; jobs.delete(gui); calls = [];
    const s = await service();
    expect(await s.observe()).toMatchObject({ loaded: false });
    await s.start();
    expect(jobs.has(user)).toBe(true);
    expect(await readFile(file, "utf8")).toContain("<string>Background</string><key>StandardOutPath");
    expect(mutations()).toEqual([["bootstrap", user, file], ["kickstart", `${user}/${label}`]]);
  });

  it("keeps a gui incumbent that appears after user was selected", async () => {
    const first = await seed(true); await first.observe(); await first.stop();
    guiExists = false;
    const next = await service();
    // Login returns after selection and RunAtLoad starts the old gui job.
    guiExists = true; jobs.set(gui, ownJob(73)); calls = [];
    await next.reconcile();
    expect(await next.observe()).toEqual({ loaded: true, pid: 73, matchesDesiredPlacement: true });
    expect(jobs.has(gui)).toBe(true); expect(jobs.has(user)).toBe(false);
    expect(mutations()).toEqual([]);
  });

  it("never changes the selected domain during activation if the graphical session disappears", async () => {
    const s = await service(); guiExists = false;
    await expect(s.start()).rejects.toMatchObject({ code: 112 });
    expect(jobs.size).toBe(0);
    expect(mutations()).toEqual([["bootstrap", gui, file]]);
    await s.removeDefinition();
    await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("repairs a late login that starts Aqua after the last absent-domain scan", async () => {
    const old = await seed(true); await old.observe(); await old.stop();
    guiExists = false;
    const next = await service(); await next.observe();
    calls = []; injectLogin = true;
    await next.start();
    expect(injectLogin).toBe(false);
    expect(jobs.size).toBe(1);
    expect(jobs.has(gui)).toBe(true); expect(jobs.has(user)).toBe(false);
    expect(await next.observe()).toMatchObject({ pid: 73, matchesDesiredPlacement: true });
    expect(await readFile(file, "utf8")).toContain("<string>Aqua</string>");
    expect(mutations()).toContainEqual(["bootout", `${user}/${label}`]);
  });

  it("does not interpret an unexpected graphical-session query failure as no session", async () => {
    failure = "print";
    await expect(service()).rejects.toMatchObject({ code: 5 });
    expect(mutations()).toEqual([]);
  });

  it.each(["path", "program", "args", "home"] as const)("refuses a foreign loaded job with changed %s", async field => {
    await seed(false); guiExists = true; calls = [];
    const job = jobs.get(user)!;
    if (field === "args") job.args = [job.program, "/foreign/core.cjs"];
    else job[field] = "/foreign";
    const s = await service();
    await expect(s.observe()).rejects.toThrow("does not belong");
    await expect(s.start()).rejects.toThrow("does not belong");
    await expect(s.removeDefinition()).rejects.toThrow("does not belong");
    expect(mutations()).toEqual([]); expect(jobs.size).toBe(1);
  });

  it("refuses a matching program when the owned definition is missing", async () => {
    await seed(true); await unlink(file); calls = [];
    const s = await service();
    await expect(s.observe()).rejects.toThrow("does not belong");
    expect(mutations()).toEqual([]);
  });

  it("refuses a foreign definition without modifying it", async () => {
    await seed(true); await writeFile(file, "foreign", { mode: 0o600 }); calls = [];
    await expect(service()).rejects.toThrow("different install");
    expect(await readFile(file, "utf8")).toBe("foreign");
    expect(mutations()).toEqual([]);
  });

  it("repairs two owned jobs by stopping user and keeping gui", async () => {
    await seed(true); jobs.set(user, ownJob(71)); calls = [];
    const s = await service();
    await s.reconcile();
    expect(await s.observe()).toEqual({ loaded: true, pid: 72, matchesDesiredPlacement: true });
    expect(mutations()).toEqual([["bootout", `${user}/${label}`]]);
    expect(jobs.size).toBe(1); expect(jobs.has(gui)).toBe(true);
  });

  it.each([user, gui])("refuses a foreign job in an otherwise owned pair, foreign=%s", async foreign => {
    await seed(true); jobs.set(user, ownJob(71));
    jobs.get(foreign)!.args = ["/foreign"];
    const before = await readFile(file, "utf8"); calls = [];
    const s = await service();
    await expect(s.reconcile()).rejects.toThrow("does not belong");
    expect(mutations()).toEqual([]); expect(jobs.size).toBe(2);
    expect(await readFile(file, "utf8")).toBe(before);
  });

  it("does not claim a repaired pair when the fallback stop is uncertain", async () => {
    await seed(true); jobs.set(user, ownJob(71));
    const s = await service(); failure = "bootout";
    await expect(s.reconcile()).rejects.toMatchObject({ code: 5 });
    expect(jobs.size).toBe(2);
    failure = "";
    await s.reconcile();
    expect(jobs.size).toBe(1); expect(jobs.has(gui)).toBe(true);
  });

  it("repairs a late-login pair for uninstall, then removes the remaining graphical job", async () => {
    await seed(false); guiExists = true; jobs.set(gui, ownJob(73)); calls = [];
    const s = await service();
    await s.reconcile(); await s.observe(); await s.stop(); await s.removeDefinition();
    expect(jobs.size).toBe(0);
    expect(mutations()).toEqual([["bootout", `${user}/${label}`], ["bootout", `${gui}/${label}`]]);
    await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("quiesces both owned jobs if login occurs after a user incumbent was admitted for stopping", async () => {
    const s = await seed(false); await s.observe();
    guiExists = true; jobs.set(gui, ownJob(73)); calls = [];
    await s.stop();
    expect(jobs.size).toBe(0);
    expect(mutations()).toEqual([["bootout", `${user}/${label}`], ["bootout", `${gui}/${label}`]]);
  });

  it("refuses to stop a replacement job after the original admission", async () => {
    const s = await seed(true); await s.observe(); jobs.set(gui, ownJob(99)); calls = [];
    await expect(s.stop()).rejects.toThrow("changed after admission");
    expect(mutations()).toEqual([]); expect(jobs.get(gui)?.pid).toBe(99);
  });

  it("refuses removing a definition while the job remains loaded", async () => {
    const s = await seed(true); calls = [];
    await expect(s.removeDefinition()).rejects.toThrow("quiescent");
    expect(mutations()).toEqual([]); expect(await readFile(file, "utf8")).toContain(label);
  });

  it.each([true, false])("uninstalls either owned placement and is idempotent, gui=%s", async graphical => {
    await seed(graphical);
    guiExists = true; calls = [];
    const s = await service(); await s.observe(); await s.stop(); await s.removeDefinition();
    expect(jobs.size).toBe(0);
    await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
    expect(mutations()).toEqual([["bootout", `${graphical ? gui : user}/${label}`]]);
    calls = [];
    const again = await service(); await again.observe(); await again.stop(); await again.removeDefinition();
    expect(mutations()).toEqual([]);
  });

  it.each(["bootstrap", "kickstart"])("cleans only the selected owned candidate after %s fails", async op => {
    const s = await service(); failure = op;
    await expect(s.start()).rejects.toMatchObject({ code: 5 });
    failure = "";
    const observed = await s.observe();
    if (observed.loaded) await s.stop();
    await s.removeDefinition();
    expect(jobs.size).toBe(0);
    await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
    expect(mutations().some(([, target]) => target?.startsWith("user/"))).toBe(false);
  });

  it("retains the old definition when stopping the incumbent fails", async () => {
    await seed(false); guiExists = true;
    const previous = await readFile(file, "utf8"); const s = await service(); await s.observe();
    failure = "bootout";
    await expect(s.stop()).rejects.toMatchObject({ code: 5 });
    await expect(s.start()).rejects.toThrow("quiescent");
    expect(await readFile(file, "utf8")).toBe(previous); expect(jobs.has(user)).toBe(true);
  });

  it("refuses the legacy Background uninstaller's exact-definition cleanup of a gui installation", async () => {
    const backgroundService = await seed(false); await backgroundService.observe();
    const legacyBody = await readFile(file, "utf8");
    await backgroundService.stop(); guiExists = true;
    const next = await service(); await next.start(); calls = [];
    // The old installer admits exactly this body before its user-domain stop;
    // its shared cleanup boundary also refuses the new Aqua bytes.
    await expect(removeMachineServiceFile(file, legacyBody)).rejects.toThrow("definition changed");
    expect(mutations()).toEqual([]); expect(jobs.has(gui)).toBe(true);
    expect(await readFile(file, "utf8")).not.toBe(legacyBody);
  });
});
