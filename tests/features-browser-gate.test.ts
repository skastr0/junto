import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BROWSER_ENABLED,
  productHostCapabilities,
} from "../src/shared/features";
import { LOCAL_STATION_CAPABILITIES } from "../src/shared/remote-hosts";
import { DEFAULT_NODE_CATALOG_ENTRIES } from "../src/renderer/components/node-palette/NodeCatalogGrid";

const catalogIds = (): ReadonlyArray<string> =>
  DEFAULT_NODE_CATALOG_ENTRIES.map((entry) => entry.id);

describe("browser hard product gate", () => {
  it.runIf(!BROWSER_ENABLED)(
    "removes authoring, capability advertising, live composition, preload IPC, and CLI dispatch",
    () => {
      expect(catalogIds()).not.toContain("page");
      expect(LOCAL_STATION_CAPABILITIES).toContain("browser");
      expect(productHostCapabilities(["terminal", "browser"])).toEqual([
        "terminal",
      ]);

      const preload = readFileSync("src/preload/index.ts", "utf8");
      const main = readFileSync("src/main/index.ts", "utf8");
      const cli = readFileSync("src/cli/main.ts", "utf8");
      const canvas = readFileSync(
        "src/renderer/components/Canvas.tsx",
        "utf8",
      );
      const linkNode = readFileSync(
        "src/renderer/components/nodes/LinkNode.tsx",
        "utf8",
      );
      expect(preload).toContain("...(BROWSER_ENABLED ? browserApi : {})");
      expect(main).toContain(
        "if (BROWSER_ENABLED) try {\n      if (headless) await browserCompositionHost.ensureHeadlessHost();",
      );
      expect(main).toContain(
        "if (BROWSER_ENABLED && productRuntimeStarted)",
      );
      expect(cli).toContain('dispatch.kind === "browser"');
      expect(canvas).toContain("addPage: () => {\n    if (!BROWSER_ENABLED) return;");
      expect(linkNode).toContain("BROWSER_ENABLED &&\n  node.type === \"link\"");

      const runtime = spawnSync(
        "bun",
        ["scripts/browser-cli.ts", "doctor", "--json"],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: {
            ...process.env,
            VELLUM_COMMAND_BROWSER: "0",
          },
        },
      );
      expect(runtime.status).toBe(2);
      expect(runtime.stdout).toBe("");
      expect(runtime.stderr).toContain(
        "Browser is disabled in this Junto build",
      );
    },
  );

  it.runIf(BROWSER_ENABLED)("restores the browser product in all-on builds", () => {
    expect(catalogIds()).toContain("page");
    expect(LOCAL_STATION_CAPABILITIES).toContain("browser");
    expect(productHostCapabilities(["terminal", "browser"])).toEqual([
      "terminal",
      "browser",
    ]);
  });
});
