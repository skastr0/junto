import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { Result } from "effect";
import { describe, expect, it } from "vitest";
import { decodeCanvasDoc, type CanvasDoc } from "../src/shared/canvas";
import { TASKS_ENABLED } from "../src/shared/features";
import { regionContractOf, rulesInForce } from "../src/shared/rules";
import {
  BASE_CONTRACT,
  buildInjectionText,
  SEAT_DOCTRINE,
} from "../src/shared/managed-terminal-injection";
import {
  allExamples,
  allSchemas,
  commandCapabilities,
} from "../src/cli/core/discovery";

/**
 * Region rules gate. A region's contract (rules and pinned rulings) rides the
 * Tasks gate: a tasks-off build shows no rules UI, teaches no rulings, serves
 * no `junto rulings`, and stacks no region rule onto a board. Stored
 * contracts still decode and round-trip untouched; they are inert, not gone.
 */

const storedContract = {
  rules: [{ id: "r-region", text: "cite the ticket" }],
  rulings: [{ id: "p1", text: "prices stay in BRL", pinnedAt: "2026-08-01T00:00:00.000Z" }],
};

const regionWithRules = (): CanvasDoc =>
  ({
    nodes: [
      {
        id: "region-1",
        type: "group",
        label: "Delivery",
        x: 0,
        y: 0,
        width: 1000,
        height: 1000,
        ether: { region: { instruction: "ship small", contract: storedContract } },
      },
      {
        id: "board-1",
        type: "text",
        text: "tasks",
        x: 100,
        y: 100,
        width: 100,
        height: 60,
        ether: { entity: { kind: "task" }, tasks: { items: [] } },
      },
    ],
    edges: [],
  }) as CanvasDoc;

const seatText = (): string =>
  buildInjectionText({
    seatBound: true,
    connected: false,
    seatRef: "canvas-a::worker-1",
    connectedTargets: [],
  }) ?? "";

describe("region rules gate", () => {
  it("keeps a stored region contract through decode in every profile", () => {
    const decoded = Result.getOrThrow(decodeCanvasDoc(regionWithRules()));
    expect(decoded.nodes[0]?.ether?.region?.contract).toEqual(storedContract);
  });

  it.runIf(!TASKS_ENABLED)("leaves stored region rules inert and absent from the ship build", () => {
    const doc = regionWithRules();
    expect(regionContractOf(doc.nodes[0]!)).toBeUndefined();
    expect(rulesInForce(doc, "board-1")).toEqual([]);

    for (const text of [SEAT_DOCTRINE, BASE_CONTRACT, seatText()]) {
      expect(text).not.toMatch(/ruling/iu);
      expect(text).not.toContain("Rules in force");
    }

    expect(allSchemas.some((s) => s.command_id === "rulings")).toBe(false);
    expect(allExamples.some((e) => e.command_id === "rulings")).toBe(false);
    expect(commandCapabilities.some((c) => c.command_id === "rulings")).toBe(false);

    const runtime = spawnSync("bun", ["src/cli/main.ts", "rulings"], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(runtime.status).toBe(2);
    expect(runtime.stderr).toContain("disabled in this Junto build");

    // The one render site and the pin control carry the gate; the write
    // paths refuse on their own so no side door can author a contract.
    const inspector = readFileSync("src/renderer/components/InspectorFields.tsx", "utf8");
    expect(inspector).toContain("{TASKS_ENABLED ? <RegionRules node={node} /> : null}");
    const ledger = readFileSync("src/renderer/components/work/WorkLedger.tsx", "utf8");
    expect(ledger).toMatch(/TASKS_ENABLED \? \(\s*<PinRulingControl/u);
    const mutations = readFileSync("src/renderer/lib/mutations.ts", "utf8");
    expect(mutations).toContain("if (!TASKS_ENABLED) return;");
    expect(mutations).toContain("if (!trimmed || !TASKS_ENABLED) return;");
    const control = readFileSync("src/main/junto/work/control.ts", "utf8");
    expect(control).toContain("region rulings are disabled in this Junto build");
  });

  it.runIf(TASKS_ENABLED)("restores region rules and rulings with the Tasks gate", () => {
    const doc = regionWithRules();
    expect(regionContractOf(doc.nodes[0]!)).toEqual(storedContract);
    expect(rulesInForce(doc, "board-1").map((entry) => entry.rule.id)).toEqual(["r-region"]);
    expect(SEAT_DOCTRINE).toContain("junto rulings");
    expect(BASE_CONTRACT).toContain("junto rulings");
    expect(allSchemas.some((s) => s.command_id === "rulings")).toBe(true);
  });
});
