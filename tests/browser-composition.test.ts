import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BROWSER_COMPOSITION_STARTUP_FAILURE_MESSAGE,
  BrowserCompositionStartupError,
} from "../src/main/vellum/browser/composition";
import { makeBrowserCapabilityRegistry } from "../src/main/vellum/browser/capabilities";
import { makeBrowserProfileGate } from "../src/main/vellum/browser/profile-gate";

describe("browser composition (no ceremony)", () => {
  it("source no longer wires grant delivery / agent product", () => {
    const root = join(import.meta.dirname, "..");
    const composition = readFileSync(
      join(root, "src/main/vellum/browser/composition.ts"),
      "utf8",
    );
    const index = readFileSync(join(root, "src/main/index.ts"), "utf8");
    expect(composition).not.toContain("agent-product");
    expect(composition).not.toContain("makeBrowserAutomationProduct");
    expect(composition).not.toContain("agent-runtime");
    expect(composition).not.toContain("agent-authority");
    expect(index).not.toContain("registerBrowserAgentIpc");
    expect(index).not.toContain("confirmBrowserAutomation");
    expect(index).not.toContain("agent-confirmation");
    expect(index).toContain("composition.registry");
    expect(index).not.toContain("composition.automation");
  });

  it("ceremony modules are gone from the tree", () => {
    const root = join(import.meta.dirname, "..");
    for (const rel of [
      "src/main/vellum/browser/agent-product.ts",
      "src/main/vellum/browser/agent-runtime.ts",
      "src/main/vellum/browser/agent-authority.ts",
      "src/main/vellum/browser/agent-confirmation.ts",
      "src/main/vellum/browser/agent-ipc.ts",
      "src/main/vellum/browser/herdr-agent-delivery.ts",
    ]) {
      expect(() => readFileSync(join(root, rel))).toThrow();
    }
  });

  it("internal registry still supports edge-grant leases", () => {
    const gate = makeBrowserProfileGate();
    const registry = makeBrowserCapabilityRegistry({ profileGate: gate });
    try {
      const principal = registry.createPrincipal();
      expect(principal.ownerId.length).toBeGreaterThan(0);
      registry.reapAfterResume();
    } finally {
      registry.close();
    }
  });

  it("startup failure type stays fixed-message", () => {
    const err = new BrowserCompositionStartupError();
    expect(err.message).toBe(BROWSER_COMPOSITION_STARTUP_FAILURE_MESSAGE);
    expect(err.name).toBe("BrowserCompositionStartupError");
  });
});
