import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
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
      // Ship/default: experimental harnesses (kimi/muse/prime-agent) and Hermes
      // are compile-time off. Durable HARNESS_IDS still include them for decode.
      expect(allTemplates().map((template) => template.harness)).toEqual([
        "claude",
        "codex",
        "grok",
        "pi",
        "devin",
        "cursor",
      ]);
      expect(managedHarnessEnabled("hermes")).toBe(false);
      expect(managedHarnessEnabled("kimi")).toBe(false);
      expect(managedHarnessEnabled("muse")).toBe(false);
      expect(managedHarnessEnabled("prime-agent")).toBe(false);
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
      const ipc = readFileSync("src/main/vellum/ipc.ts", "utf8");
      const snapshots = readFileSync("src/main/vellum/snapshots.ts", "utf8");
      const terminalIpc = readFileSync("src/main/vellum/term/ipc.ts", "utf8");
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
      expect(snapshots).toContain(
        "HERMES_INTEGRATION_ENABLED\n        ? plane.fetchBundle",
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
