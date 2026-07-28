import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const main = readFileSync(
  new URL("../src/main/index.ts", import.meta.url),
  "utf8",
);
const policy = JSON.parse(
  readFileSync(
    new URL("../scripts/package-security-policy.json", import.meta.url),
    "utf8",
  ),
) as { readonly fuses?: { readonly RunAsNode?: boolean } };

describe("packaged state preflight mode", () => {
  it("runs the fixed clone proof before every product runtime surface", () => {
    const branchStart = main.indexOf("if (stateUpdatePreflight) {");
    const normalStartup = main.indexOf(
      "if (!(await ensureSupervised())) return;",
      branchStart,
    );
    const branch = main.slice(branchStart, normalStartup);

    expect(branchStart).toBeGreaterThan(0);
    expect(normalStartup).toBeGreaterThan(branchStart);
    expect(branch).toContain("if (!app.isPackaged)");
    expect(branch).toContain(
      "withStateUpdateCandidate(inspectStateUpdateCandidate)",
    );
    expect(branch).toContain(
      'exitAfterDetach(0, "state-update-preflight-complete")',
    );
    expect(branch).not.toContain("AppRuntime.runPromise");
    expect(branch).not.toContain("process.env");
    expect(branch).not.toContain("startWorkControlServer");
    expect(branch).not.toContain("startStationControlServer");
    expect(branch).not.toContain("KernelService");
    expect(branch).not.toContain("createWindow");
  });

  it("accepts no database path and keeps Electron RunAsNode fused off", () => {
    expect(main).toContain(
      'process.argv.includes("--vellum-state-preflight")',
    );
    expect(main).not.toMatch(
      /--vellum-state-preflight(?:=|\s+<|\s+\[).*database/iu,
    );
    expect(policy.fuses?.RunAsNode).toBe(false);
  });
});
