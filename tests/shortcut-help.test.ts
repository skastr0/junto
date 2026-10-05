import { describe, expect, it } from "vitest";
import { shortcutHelpRows } from "../src/renderer/components/help/CanvasInteractionMap";
import { KEY_TABLE } from "../src/shared/key-table";

describe("the help's keys come from the key table", () => {
  it("shows every changeable shortcut that has a key, in the table's words", () => {
    const rows = shortcutHelpRows(true);
    for (const def of KEY_TABLE) {
      const shown = rows.some((row) => row.action === def.does);
      expect(shown, def.id).toBe(def.fixed === undefined && def.mac.length > 0);
    }
    expect(rows.find((row) => row.action.startsWith("Open search, or close"))?.keys).toBe("⌘K");
    expect(rows.find((row) => row.action.startsWith("Go to the next agent that raised"))?.keys).toBe("Space - `");
  });

  it("never names Control on macOS, and has no middle dot", () => {
    for (const row of shortcutHelpRows(true)) {
      expect(row.keys).not.toMatch(/Ctrl|⌃/);
      expect(`${row.keys}${row.action}`).not.toContain("\u00b7");
    }
  });

  it("shows the chord the operator chose, and drops a shortcut left with no key", () => {
    const rows = shortcutHelpRows(true, { "feed.open": ["Cmd+J"], "git.review": [] });
    expect(rows.find((row) => row.action.startsWith("Open the needs-you feed"))?.keys).toBe("⌘J");
    expect(rows.some((row) => row.action.startsWith("Open the git review"))).toBe(false);
  });

  it("writes the keys in words off macOS", () => {
    expect(shortcutHelpRows(false).find((row) => row.action.startsWith("Open search, or close"))?.keys).toBe("Ctrl+K");
  });

  it("gives every row its own identity for the list", () => {
    const ids = shortcutHelpRows(true).map((row) => `${row.keys} ${row.action}`);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
