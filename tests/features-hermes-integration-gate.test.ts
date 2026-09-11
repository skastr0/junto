import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  HARNESS_AMP_ENABLED,
  HARNESS_FX_ENABLED,
  HARNESS_PRIME_AGENT_ENABLED,
  HERMES_INTEGRATION_ENABLED,
  managedHarnessEnabled,
  productHostCapabilities,
} from "../src/shared/features";
import {
  HARNESS_IDS,
  allTemplates,
} from "../src/shared/managed-terminal-templates";
import { LOCAL_STATION_CAPABILITIES } from "../src/shared/remote-hosts";
import { actorHostChoicesFromEnrollment } from "../src/renderer/components/node-palette/agent-launch-model";
import { makeManagedAgentNode } from "../src/renderer/lib/node-factories";

describe("Hermes integration product gate", () => {
  it("preserves durable decode vocabulary in every profile", () => {
    expect(HARNESS_IDS).toContain("hermes");
  });

  it.runIf(!HERMES_INTEGRATION_ENABLED)(
    "removes Hermes integration while retaining the independent ACP chat plane",
    () => {
      // Hermes is independent of the shipped stock Prime Agent CLI harness;
      // an explicit Prime build override may still disable its authoring. Durable
      // HARNESS_IDS retain every decode vocabulary entry in either profile.
      expect(allTemplates().map((template) => template.harness)).toEqual([
        "claude",
        "codex",
        "grok",
        "pi",
        ...(HARNESS_PRIME_AGENT_ENABLED ? ["prime-agent" as const] : []),
        "devin",
        "cursor",
        "agy",
        ...(HARNESS_AMP_ENABLED ? ["amp" as const] : []),
        ...(HARNESS_FX_ENABLED ? ["fx" as const] : []),
      ]);
      expect(managedHarnessEnabled("hermes")).toBe(false);
      expect(managedHarnessEnabled("kimi")).toBe(false);
      expect(managedHarnessEnabled("muse")).toBe(false);
      expect(managedHarnessEnabled("prime-agent")).toBe(
        HARNESS_PRIME_AGENT_ENABLED,
      );
      expect(() =>
        makeManagedAgentNode(0, 0, {
          harness: "hermes",
          host: "local",
        }),
      ).toThrow(/disabled/u);
      expect(
        makeManagedAgentNode(0, 0, {
          harness: "claude",
          host: "local",
        }).ether?.terminal?.harness,
      ).toBe("claude");
      expect(LOCAL_STATION_CAPABILITIES).toContain("hermes");
      expect(productHostCapabilities(["terminal", "hermes"])).toEqual([
        "terminal",
      ]);
      const choices = actorHostChoicesFromEnrollment(
          [
            {
              id: "station-a",
              label: "Station A",
              kind: "remote",
              capabilities: ["terminal", "hermes"],
              hermesId: "hermes-a",
            },
          ],
          { id: "local", agentHost: "local", label: "this machine" },
        );
      expect(choices.find((choice) => choice.id === "station-a")).toMatchObject({
        id: "station-a",
        agentHost: "station-a",
      });

      const preload = readFileSync("src/preload/index.ts", "utf8");
      const ipc = readFileSync("src/main/vellum-command/ipc.ts", "utf8");
      const snapshots = readFileSync("src/main/vellum-command/snapshots.ts", "utf8");
      const terminalIpc = readFileSync("src/main/vellum-command/term/ipc.ts", "utf8");
      expect(preload).toContain(
        "...(HERMES_INTEGRATION_ENABLED ? hermesIntegrationApi : {})",
      );
      expect(preload).toContain("...chatApi,");
      expect(ipc).toContain(
        "if (HERMES_INTEGRATION_ENABLED) privilegedIpc.handle(\n    IPC_CHANNELS.generatePortfolio",
      );
      expect(ipc).toContain(
        "if (HERMES_INTEGRATION_ENABLED) {\n    privilegedIpc.handle(IPC_CHANNELS.agentMessage",
      );
      expect(ipc).toContain("void registerChatIpc(");
      expect(ipc).toContain("AppRuntime.runPromise(ChatServiceContext),");
      expect(snapshots).toMatch(
        /HERMES_INTEGRATION_ENABLED\s*\?\s*plane\.fetchBundle/u,
      );
      expect(terminalIpc).toContain(
        "if (!managedHarnessEnabled(surface.harness))",
      );
    },
  );

  it.runIf(HERMES_INTEGRATION_ENABLED)(
    "restores Hermes as an independent all-on product",
    () => {
      expect(allTemplates().map((template) => template.harness)).toContain(
        "hermes",
      );
      expect(managedHarnessEnabled("hermes")).toBe(true);
      expect(LOCAL_STATION_CAPABILITIES).toContain("hermes");
    },
  );
});
