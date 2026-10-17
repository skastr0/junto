import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const FILES = [
  "../src/renderer/components/customize/ParamsSection.tsx",
  "../src/renderer/components/node-palette/AgentCascadeMenu.tsx",
  "../src/renderer/components/node-palette/agent-launch-model.ts",
  "../src/renderer/components/settings/HarnessesSettingsSection.tsx",
];

describe("harness dials read the harness record", () => {
  test.each(FILES)("%s names no harness id", (file) => {
    const source = readFileSync(join(__dirname, file), "utf8");
    expect(source.match(/harness\s*[!=]==\s*"[a-z-]+"/g) ?? []).toEqual([]);
  });
});
