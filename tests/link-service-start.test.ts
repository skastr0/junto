/**
 * The install writers produce exactly the bodies the native `junto link`
 * start accepts (native/cli/src/commands/pipes/link/start.rs), from one
 * fixture both languages read. The service-manager calls are doubles; no
 * test starts a service. This imports src/cli/hosts until install is ported
 * to Rust, then the check moves into cargo test against the same fixture.
 */
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const account = vi.hoisted(() => ({ home: "" }));
vi.mock("node:os", async original => ({ ...await original<typeof import("node:os")>(), homedir: () => account.home }));

import { machineServiceLabel } from "../src/cli/hosts/install";
import { admitMachineServiceLabel, darwinMachineService, linuxMachineService } from "../src/cli/hosts/install-service";

type Fixture = {
  root: string; home: string; label: string;
  launchd: { aqua: string; background: string };
  systemd: { current: string; legacy: string };
};
const fixture = JSON.parse(readFileSync(join(__dirname, "fixtures/link-service-bodies.json"), "utf8")) as Fixture;

let scratch: string;
beforeEach(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), "junto-link-start-")));
  account.home = scratch;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(scratch, { recursive: true, force: true });
});

const label = admitMachineServiceLabel(fixture.label);

describe("the install's service bodies, through the writers", () => {
  it("labels an install exactly as the native CLI's fixture does", () => {
    expect(machineServiceLabel(fixture.root, fixture.home)).toBe(fixture.label);
  });

  it("writes the exact current and legacy Linux unit", async () => {
    const file = join(scratch, ".config/systemd/user", `${fixture.label}.service`);
    const runner = async (): Promise<string> => "";
    await (await linuxMachineService(fixture.root, fixture.home, label, runner)).start();
    expect(await readFile(file, "utf8")).toBe(fixture.systemd.current);

    await writeFile(file, fixture.systemd.legacy, { mode: 0o600 });
    await (await linuxMachineService(fixture.root, fixture.home, label, runner)).start();
    expect(await readFile(file, "utf8")).toBe(fixture.systemd.current);
  });

  const launchd = (graphical: boolean) => {
    const calls: string[][] = [];
    let first = true;
    const run = async (args: string[]): Promise<string> => {
      calls.push(args);
      const [op, target] = args;
      if (op !== "print") return "";
      if (target === `gui/${process.getuid!()}`) {
        if (first) {
          first = false;
          if (graphical) return "gui exists";
          throw Object.assign(new Error("no gui"), { code: 112 });
        }
      }
      throw Object.assign(new Error("no job"), { code: 113 });
    };
    return { calls, run };
  };

  it("writes the exact Aqua plist in the graphical session", async () => {
    const fake = launchd(true);
    await (await darwinMachineService(fixture.root, fixture.home, label, fake.run)).start();
    const file = join(scratch, "Library/LaunchAgents", `${fixture.label}.plist`);
    expect(await readFile(file, "utf8")).toBe(fixture.launchd.aqua);
    expect(fake.calls.filter(([op]) => op === "bootstrap")).toEqual([["bootstrap", `gui/${process.getuid!()}`, file]]);
  });

  it("writes the exact Background plist with no graphical session", async () => {
    const fake = launchd(false);
    await (await darwinMachineService(fixture.root, fixture.home, label, fake.run)).start();
    const file = join(scratch, "Library/LaunchAgents", `${fixture.label}.plist`);
    expect(await readFile(file, "utf8")).toBe(fixture.launchd.background);
    expect(fake.calls.filter(([op]) => op === "bootstrap")).toEqual([["bootstrap", `user/${process.getuid!()}`, file]]);
  });
});
