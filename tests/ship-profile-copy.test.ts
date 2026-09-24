import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CanvasNode } from "@shared/canvas";
import { ALL_FEATURES, SHIP_FEATURES } from "@shared/feature-catalog";
import { TASKS_ENABLED } from "@shared/features";
import { SEED_CANVAS_NAME } from "@shared/seed";
import { RegionRules } from "../src/renderer/components/rules/RegionRules";
import { crewPauseDetail, firstPlayConsequences } from "../src/renderer/lib/factory-pause";
import { deadStateCopy } from "../src/renderer/lib/terminal-kill-ux";

// Copy that names a feature follows that feature's build flag.

const read = (path: string): string => readFileSync(path, "utf8");

describe("ship profile copy", () => {
  it("keeps tasks, board, cron, and relay off in the ship profile", () => {
    expect(SHIP_FEATURES).toMatchObject({
      tasks: false,
      board: false,
      cron: false,
      relay: false,
    });
  });

  it("names the first canvas a workspace", () => {
    expect(SEED_CANVAS_NAME).toBe("workspace");
  });

  it("ends an agent seat without pointing at a task board", () => {
    const ship = deadStateCopy({ agentSeat: true }, SHIP_FEATURES);
    expect(ship).toEqual({
      headline: "Agent stopped",
      detail: "The last output stays frozen below.",
      reopenLabel: "Reopen",
      closeViewLabel: "Close view",
    });
    expect(deadStateCopy({ agentSeat: true }, ALL_FEATURES).detail).toBe(
      "If it still held a task, unassign it from the task board.",
    );
  });

  it("describes the pause switch by what the ship build runs", () => {
    expect(crewPauseDetail(true, SHIP_FEATURES)).toBe("Stop agent delivery on this canvas");
    expect(crewPauseDetail(false, SHIP_FEATURES)).toBe("Start agent delivery on this canvas");
    expect(crewPauseDetail(true, ALL_FEATURES)).toBe(
      "Stop cron, relay, and agent delivery on this canvas",
    );
    expect(crewPauseDetail(false, { cron: true, relay: false, tasks: false })).toBe(
      "Start cron and agent delivery on this canvas",
    );
  });

  it("lists only ship consequences on first play", () => {
    expect(firstPlayConsequences(SHIP_FEATURES)).toEqual([
      "Agents can act through the Junto CLI.",
      "Queued messages deliver to their targets.",
    ]);
    expect(firstPlayConsequences(ALL_FEATURES)).toEqual([
      "Cron and relay nodes start firing, and may spend real agent turns.",
      "Agents can act through the Junto CLI.",
      "Queued messages deliver to their targets.",
      "Queued tasks are handed to free connected agents.",
    ]);
  });

  it.runIf(!TASKS_ENABLED)("hides region rules, which only tasks answer", () => {
    const group = { id: "g", type: "group", x: 0, y: 0, width: 100, height: 100 } as CanvasNode;
    expect(renderToStaticMarkup(createElement(RegionRules, { node: group }))).toBe("");
  });

  it("calls the digest a projection of the canvas", () => {
    const source = read("src/renderer/lib/command-bar-actions.ts");
    expect(source).toContain('"Deterministic text projection of the canvas"');
  });

  it("drops the task caveat from the ledger activity title when tasks are off", () => {
    const source = read("src/renderer/components/terminal/ActorLedgerPane.tsx");
    expect(source).toMatch(
      /TASKS_ENABLED\s*\?\s*"Identity-backed CLI activity only - task updates are not attributed"\s*:\s*"Identity-backed CLI activity only"/u,
    );
  });
});
