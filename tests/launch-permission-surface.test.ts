/**
 * Launch permission surface: what may make macOS name Junto before a click.
 *
 * macOS bills a child's file access to the GUI app at the top of its process
 * tree, so an agent Junto starts can raise a prompt that names Junto. That is
 * fine when the operator asked for the agent. What must never happen is Junto
 * causing a prompt for no reason, so nothing starts before a click: every
 * Command Center launch comes back paused, managed seats wake only on a
 * playing canvas, and shell terminals start only from an explicit open.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = (path: string): string => readFileSync(path, "utf8");

const sourceFiles = (root: string): string[] =>
  readdirSync(root).flatMap((name) => {
    const path = join(root, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/u.test(name) ? [path] : [];
  });

/** The kernel function each `ensureManagedSeatRunning` call sits in. */
const wakeSites = (kernel: string): Array<{ readonly fn: string; readonly body: string }> =>
  [...kernel.matchAll(/yield\* ensureManagedSeatRunning\(/gu)].map((call) => {
    const before = kernel.slice(0, call.index);
    const starts = [...before.matchAll(/\n {2}const (\w+) = /gu)];
    const start = starts[starts.length - 1]!;
    return { fn: start[1]!, body: kernel.slice(start.index, call.index) };
  });

describe("launch permission surface", () => {
  it("brings every Command Center launch back paused", () => {
    const runtime = source("src/main/runtime.ts");
    expect(runtime).toContain("Layer.provideMerge(PausePlaneLaunchPausedLive, BaseLayer)");
    expect(runtime).not.toMatch(/\bPausePlaneLive\b/u);
  });

  it("wakes a managed seat only on a playing canvas", () => {
    const sites = wakeSites(source("src/main/junto/kernel/service.ts"));
    expect(sites.map((site) => site.fn)).toEqual([
      "startManagedSeats",
      "deliverWorkingClaims",
      "wakeManagedSeatProgram",
    ]);
    for (const site of sites) {
      expect(site.body, `${site.fn} must check the play state before waking`).toMatch(/\.playing\b/u);
    }
  });

  it("creates shell terminals only from the explicit open path", () => {
    const creators = sourceFiles("src/renderer").filter((path) =>
      source(path).includes("terminalCreate("),
    );
    expect(creators).toEqual([join("src/renderer/lib/terminal-actions.ts")]);
  });
});
