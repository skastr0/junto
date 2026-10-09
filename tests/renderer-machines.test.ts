/**
 * Machines in the window: which machine a seat is on, what a machine is
 * called, and the rule that the window never compares a host against a
 * written name.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import type { RemoteHost } from "../src/shared/remote-hosts";
import { DEMO_THIS_MACHINE, onDemoMachine } from "../src/renderer/demo/machine";
import { isOnMachine, machineChoices, machineLabelIn } from "../src/renderer/lib/machines";
import { seat, note } from "./support/model-nodes";

const row = (id: string, more: Partial<RemoteHost> = {}): RemoteHost => ({
  id,
  label: id,
  isThisMachine: false,
  capabilities: ["terminal"],
  ...more,
});

describe("which machine a seat is on", () => {
  it("is this one when its host is this machine's name", () => {
    expect(isOnMachine("macbook", "macbook")).toBe(true);
    expect(isOnMachine("mac-mini", "macbook")).toBe(false);
  });

  it("is never this one before the name is known", () => {
    expect(isOnMachine("macbook", "")).toBe(false);
    expect(isOnMachine("", "")).toBe(false);
    expect(isOnMachine(undefined, "")).toBe(false);
  });
});

describe("what a machine is called", () => {
  const machines = [row("macbook", { label: "Studio desk", isThisMachine: true }), row("mac-mini", { label: "  " })];

  it("is its label", () => {
    expect(machineLabelIn(machines, "macbook")).toBe("Studio desk");
  });

  it("falls back to its name when the label is blank or the machine is not listed", () => {
    expect(machineLabelIn(machines, "mac-mini")).toBe("mac-mini");
    expect(machineLabelIn(machines, "gone")).toBe("gone");
    expect(machineLabelIn([], "macbook")).toBe("macbook");
  });
});

describe("the machines a picker offers", () => {
  it("puts this machine first and the rest by label", () => {
    const choices = machineChoices(
      [row("zeta", { label: "Zeta" }), row("alpha", { label: "Alpha" }), row("macbook", { label: "Studio desk", isThisMachine: true })],
      "macbook",
    );
    expect(choices).toEqual([
      { id: "macbook", label: "Studio desk" },
      { id: "alpha", label: "Alpha" },
      { id: "zeta", label: "Zeta" },
    ]);
  });

  it("offers this machine when the list is absent", () => {
    expect(machineChoices([], "macbook")).toEqual([{ id: "macbook", label: "macbook" }]);
  });

  it("offers nothing before this machine's name is known", () => {
    expect(machineChoices([], "")).toEqual([]);
  });

  it("lists a machine once", () => {
    expect(machineChoices([row("mac-mini"), row("mac-mini")], "macbook").map((choice) => choice.id)).toEqual(["macbook", "mac-mini"]);
  });
});

describe("a demo scenario on this machine", () => {
  it("lands its own seats under this machine's name", () => {
    const landed = onDemoMachine(seat("a", { host: DEMO_THIS_MACHINE as never, agentKey: `${DEMO_THIS_MACHINE}:a` as never }), "macbook");
    expect(landed).toMatchObject({ host: "macbook", agentKey: "macbook:a" });
  });

  it("leaves another machine's seats and hostless nodes alone", () => {
    const elsewhere = seat("b", { host: "mac_mini" as never });
    expect(onDemoMachine(elsewhere, "macbook")).toBe(elsewhere);
    const plain = note("n", "text");
    expect(onDemoMachine(plain, "macbook")).toBe(plain);
  });
});

// A host is a machine's real name, and a different one on every machine. The
// window asks "is this seat mine" through lib/machines.ts; it never sets a
// host beside a name written in source, and nothing in it says `local`.
describe("the window never compares a host against a written name", () => {
  const HOST = String.raw`(?<!typeof\s+)(?<![\w$.])(?:[A-Za-z_$][\w$]*\.)*[\w$]*(?:[hH]ost(?:Id)?|[mM]achine(?:Name|Id)?)`;
  const NAME = String.raw`["'\x60][^"'\x60\n]+["'\x60]`;
  const COMPARES = new RegExp(String.raw`${HOST}\s*[!=]==?\s*${NAME}|${NAME}\s*[!=]==?\s*${HOST}\b`, "u");
  const SAYS_LOCAL = /["'`]local["'`]/u;

  it("knows a comparison when it sees one", () => {
    for (const line of [
      'const line = native.hostId === "local" ? subtitle : other;',
      'if (host !== "mac-mini") return undefined;',
      'return "studio" === node.host;',
      "if (machine == `studio`) return;",
      "if (selectedHostId === 'box-1') open();",
    ]) {
      expect(COMPARES.test(line), line).toBe(true);
    }
    for (const line of [
      'typeof hostId === "string"',
      'host.kind === "remote"',
      'if (thisMachine === "") return null;',
      "isOnMachine(native.hostId, thisMachine)",
      "left.id === thisName",
    ]) {
      expect(COMPARES.test(line), line).toBe(false);
    }
  });

  const root = join(__dirname, "..", "src", "renderer");
  const sources = (dir: string): ReadonlyArray<string> =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return sources(path);
      return /\.tsx?$/u.test(entry.name) ? [path] : [];
    });

  it("in any renderer source file", () => {
    const found: string[] = [];
    for (const path of sources(root)) {
      readFileSync(path, "utf8").split("\n").forEach((line, index) => {
        if (COMPARES.test(line) || SAYS_LOCAL.test(line)) {
          found.push(`${relative(root, path)}:${index + 1}: ${line.trim()}`);
        }
      });
    }
    expect(found).toEqual([]);
  });
});
