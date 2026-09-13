import { describe, expect, it } from "vitest";
import {
  cliCoverageManifest,
  expectedCliAuthorizationCellCount,
  generateCliAuthorizationMatrix,
} from "./cli-authorization-matrix";

describe("CLI authorization matrix", () => {
  it("classifies every current Vellum Command CLI subcommand into a conformance lane", () => {
    const manifest = cliCoverageManifest();
    expect(manifest.length).toBeGreaterThan(0);
    expect(new Set(manifest.map(({ commandId }) => commandId)).size).toBe(manifest.length);
    expect(manifest.filter(({ lane }) => lane === undefined)).toEqual([]);
    expect(manifest).toContainEqual({ commandId: "tasks.claim", lane: "target-matrix" });
    expect(manifest).toContainEqual({ commandId: "doctor", lane: "seat-local" });
    expect(manifest).toContainEqual({ commandId: "overseer.skill", lane: "discovery" });
    expect(manifest).toContainEqual({ commandId: "overseer.status", lane: "overseer-plane" });
    expect(manifest).toContainEqual({ commandId: "overseer.tasks.claim", lane: "overseer-plane" });
  });

  it("exhausts the current node-edge-node matrix for every target-scoped CLI command", () => {
    const matrix = generateCliAuthorizationMatrix();
    expect(matrix).toHaveLength(expectedCliAuthorizationCellCount());
    expect(new Set(matrix.map((cell) => JSON.stringify([
      cell.commandId,
      cell.sourceKind,
      cell.targetKind,
      cell.direction,
      cell.edgeMode,
    ]))).size).toBe(matrix.length);
    expect(matrix.filter(({ expected, actual }) => expected !== actual)).toEqual([]);
    expect(matrix.some((cell) => cell.actual === "allow")).toBe(true);
    expect(matrix.some((cell) => cell.actual === "deny")).toBe(true);
  });
});
