import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { TerminalSessionSummary } from "../src/shared/terminal";
import {
  sessionChromeUnchanged,
  shouldRefreshSessionFromTerminalEvent,
} from "../src/renderer/lib/terminal-session-refresh";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const summary = (
  over: Partial<TerminalSessionSummary> = {},
): TerminalSessionSummary => ({
  bindingId: "b1",
  epoch: "e1",
  hostId: "local",
  status: "running",
  detached: false,
  createdAt: 1,
  ...over,
});

describe("shouldRefreshSessionFromTerminalEvent", () => {
  it("ignores PTY output — that path already paints the open xterm", () => {
    expect(
      shouldRefreshSessionFromTerminalEvent({
        type: "output",
        bindingId: "b1",
        data: "chunk",
      }),
    ).toBe(false);
  });

  it("ignores resize and unknown payloads", () => {
    expect(
      shouldRefreshSessionFromTerminalEvent({ type: "resize", cols: 80, rows: 24 }),
    ).toBe(false);
    expect(shouldRefreshSessionFromTerminalEvent(undefined)).toBe(false);
    expect(shouldRefreshSessionFromTerminalEvent("output")).toBe(false);
  });

  it("refreshes only on session and exit", () => {
    expect(shouldRefreshSessionFromTerminalEvent({ type: "session" })).toBe(true);
    expect(shouldRefreshSessionFromTerminalEvent({ type: "exit" })).toBe(true);
  });
});

describe("sessionChromeUnchanged", () => {
  it("treats OSC title and processName as non-chrome", () => {
    expect(
      sessionChromeUnchanged(
        summary({ title: "✶ working", processName: "claude" }),
        summary({ title: "✶ thinking", processName: "claude · turn" }),
      ),
    ).toBe(true);
  });

  it("detects lifecycle edges the card must paint", () => {
    expect(
      sessionChromeUnchanged(summary({ status: "running" }), summary({ status: "exited" })),
    ).toBe(false);
    expect(sessionChromeUnchanged(summary({ pid: 1 }), summary({ pid: 2 }))).toBe(false);
    expect(sessionChromeUnchanged(summary({ epoch: "e1" }), summary({ epoch: "e2" }))).toBe(
      false,
    );
    expect(sessionChromeUnchanged(undefined, summary())).toBe(false);
    expect(sessionChromeUnchanged(summary(), summary())).toBe(true);
  });
});

describe("card wiring", () => {
  const files = [
    "src/renderer/components/terminal/TerminalCard.tsx",
    "src/renderer/components/nodes/TextNode.tsx",
  ] as const;

  it("gates terminalGet on session/exit, not output", () => {
    for (const file of files) {
      const src = readFileSync(join(root, file), "utf8");
      expect(src).toContain("shouldRefreshSessionFromTerminalEvent");
      expect(src).toContain("sessionChromeUnchanged");
      expect(src).toMatch(/if \(!shouldRefreshSessionFromTerminalEvent\(raw\)\) return;/u);
    }
  });
});
