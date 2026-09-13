import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { resolveBuildFeatures } from "../scripts/build-features";
import { LIVE_OVERSEER_ENABLED, managedHarnessEnabled } from "../src/shared/features";
import { HARNESS_IDS, allTemplates } from "../src/shared/managed-terminal-templates";
import { defaultSettings } from "../src/shared/settings";
import { ProvidersSettingsSection } from "../src/renderer/components/settings/ProvidersSettingsSection";
import { makeManagedAgentNode } from "../src/renderer/lib/node-factories";
import { canStartOverseerLive, openOverseerLive, overseerLive$ } from "../src/renderer/lib/overseer-live-state";
import { state$ } from "../src/renderer/lib/state";

afterEach(() => {
  overseerLive$.target.set(null);
  overseerLive$.expanded.set(false);
  state$.settings.set(defaultSettings());
});

describe("Live Overseer product gate", () => {
  it("defaults off and requires an explicit build opt-in", () => {
    expect(resolveBuildFeatures({}).features.liveOverseer).toBe(false);
    expect(resolveBuildFeatures({ VELLUM_COMMAND_LIVE_OVERSEER: "1" }).features.liveOverseer).toBe(true);
    expect(resolveBuildFeatures({ VELLUM_COMMAND_FEATURE_PROFILE: "all-on" }).features.liveOverseer).toBe(true);
    expect(resolveBuildFeatures({ VELLUM_COMMAND_FEATURE_PROFILE: "all-on", VELLUM_COMMAND_LIVE_OVERSEER: "0" }).features.liveOverseer).toBe(false);
  });

  it("retains durable harness vocabulary independently of authoring", () => {
    expect(HARNESS_IDS).toContain("vellum-overseer");
    expect(managedHarnessEnabled("vellum-overseer")).toBe(LIVE_OVERSEER_ENABLED);
    expect(allTemplates().some((template) => template.harness === "vellum-overseer")).toBe(LIVE_OVERSEER_ENABLED);
  });

  it("gates credentials, model settings, and programmatic conversation opening", () => {
    const html = renderToStaticMarkup(createElement(ProvidersSettingsSection));
    expect(html.includes('aria-label="GPT-Live settings"')).toBe(LIVE_OVERSEER_ENABLED);
    openOverseerLive({ canvasName: "main", nodeId: "overseer", title: "Overseer" });
    expect(overseerLive$.expanded.peek()).toBe(LIVE_OVERSEER_ENABLED);
    expect(overseerLive$.target.peek() !== null).toBe(LIVE_OVERSEER_ENABLED);
  });

  it.runIf(!LIVE_OVERSEER_ENABLED)("refuses new native seats and the executable entry point", () => {
    expect(() => makeManagedAgentNode(0, 0, { harness: "vellum-overseer", host: "local" })).toThrow(/disabled/u);
    const process = spawnSync("bun", ["src/cli/main.ts", "overseer-host"], {
      encoding: "utf8",
      timeout: 15_000,
      env: { ...globalThis.process.env, VELLUM_COMMAND_LIVE_OVERSEER: "0" },
    });
    expect(process.status).toBe(2);
    expect(process.stdout).toBe("");
    expect(process.stderr).toContain("live conversation is disabled");
  });

  it.runIf(LIVE_OVERSEER_ENABLED)("allows explicitly enabled managed seats", () => {
    const node = makeManagedAgentNode(0, 0, { harness: "vellum-overseer", host: "local" });
    expect(canStartOverseerLive(node)).toBe(false);
    expect(canStartOverseerLive({ ...node, ether: { ...node.ether, overseer: true } })).toBe(true);
  });

  it("keeps main composition, preload exposure, and app mounting behind the same gate", () => {
    expect(readFileSync("src/main/index.ts", "utf8")).toContain("if (LIVE_OVERSEER_ENABLED) {\n        overseerLive = await composeOverseerLive");
    expect(readFileSync("src/preload/index.ts", "utf8")).toContain("...(LIVE_OVERSEER_ENABLED ? liveApi : {})");
    expect(readFileSync("src/renderer/App.tsx", "utf8")).toContain("{LIVE_OVERSEER_ENABLED && <LiveConversationHost />}");
  });
});
