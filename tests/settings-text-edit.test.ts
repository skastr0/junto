import { describe, expect, test } from "vitest";
import { nameFromFile } from "../src/renderer/components/settings/ReferencesSettingsSection";
import { appendText, textSize } from "../src/renderer/components/settings/text-edit";

describe("bringing text into the Briefing and References editors", () => {
  test("a file's text lands after what is written, one blank line between", () => {
    expect(appendText("", "# Rules\n")).toBe("# Rules\n");
    expect(appendText("first\n\n\n", "\n\nsecond\n")).toBe("first\n\nsecond\n");
  });

  test("a file name becomes a name an agent can type", () => {
    expect(nameFromFile("AGENTS.md")).toBe("agents");
    expect(nameFromFile("Deploy Notes (v2).txt")).toBe("deploy-notes-v2");
    expect(nameFromFile("__private.md")).toBe("private");
    expect(nameFromFile(`${"a".repeat(120)}.md`)).toHaveLength(80);
  });

  test("size reads in bytes, then kilobytes", () => {
    expect(textSize(340)).toBe("340 B");
    expect(textSize(1_234)).toBe("1.2 kB");
    expect(textSize(45_600)).toBe("46 kB");
  });
});
