import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { HARNESS_IDS, templateFor } from "../src/shared/managed-terminal-templates";

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
    // Nor in a case label, a list, or copy: any quoted harness id or display name.
    const named = HARNESS_IDS.flatMap((id) => [`"${id}"`, `'${id}'`, templateFor(id).displayName]).filter((needle) =>
      source.split("\n").some((line) => !/^(\/\/|\/\*|\*)/.test(line.trim()) && line.includes(needle)),
    );
    expect(named).toEqual([]);
  });
});
