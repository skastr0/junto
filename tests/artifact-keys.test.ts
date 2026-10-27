import { describe, expect, it } from "vitest";
import { artifactKeyRows } from "../src/renderer/components/artifacts/ArtifactKeys";

describe("an artifact's keys, from the key table", () => {
  it("names the pane's keys for every type, the rail and the comment send among them", () => {
    const { pane } = artifactKeyRows("sheet", true);
    const keysFor = (start: string) => pane.find((row) => row.action.startsWith(start))?.keys;
    expect(keysFor("Move the keyboard to the next pane")).toBe("⌘⌥→");
    expect(keysFor("Move the keyboard to the previous pane")).toBe("⌘⌥←");
    expect(keysFor("Open or close the comments")).toBe("⌘B");
    expect(keysFor("Send the comment")).toBe("⌘↵");
    expect(keysFor("Move through the artifacts")).toBe("↓ - ↑");
  });

  it("adds the editor's own keys for a document and a pad", () => {
    expect(artifactKeyRows("document", true).editor.map((row) => row.keys)).toEqual(["↵", "Esc", "@"]);
    expect(artifactKeyRows("pad", true).editor.length).toBeGreaterThan(0);
    expect(artifactKeyRows("link", true).editor).toEqual([]);
  });

  it("follows the chord the operator chose, and writes keys in words off macOS", () => {
    const rows = artifactKeyRows("document", true, { "pane.next": ["Cmd+Alt+ArrowDown"] }).pane;
    expect(rows.find((row) => row.action.startsWith("Move the keyboard to the next pane"))?.keys).toBe("⌘⌥↓");
    expect(artifactKeyRows("document", false).pane.find((row) => row.action.startsWith("Move the keyboard to the next"))?.keys).toBe("Ctrl+Alt+→");
  });

  it("has no middle dot", () => {
    const { pane, editor } = artifactKeyRows("document", true);
    for (const row of [...pane, ...editor]) expect(`${row.keys}${row.action}`).not.toContain(String.fromCharCode(0xb7));
  });
});
