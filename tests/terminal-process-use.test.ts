import { afterEach, describe, expect, it } from "vitest";
import type { TerminalClient } from "../src/node/terminals/client";
import { placeTerminals, terminalPlace, terminalProcessClient } from "../src/node/terminals/use";

/**
 * Where a process's PTYs run is its boot's choice, never inferred from which
 * process it is. A process whose boot chose nothing (Electron main) holds no
 * terminals, so a spawn there throws instead of running on its thread.
 */
afterEach(() => {
  // The unit tests' own place (vitest-setup-one-process.ts).
  placeTerminals({ kind: "here" });
});

describe("where this process's terminals run", () => {
  it("runs them here when the boot says here, with no terminal process client", () => {
    placeTerminals({ kind: "here" });
    expect(terminalPlace()).toEqual({ kind: "here" });
    expect(terminalProcessClient()).toBeUndefined();
  });

  it("runs them in the terminal process when the boot hands it the client", () => {
    const client = { spawn: () => undefined } as unknown as TerminalClient;
    placeTerminals({ kind: "process", client });
    expect(terminalProcessClient()).toBe(client);
  });

  it("decides by no process identity: the module reads neither process.type nor parentPort", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("src/node/terminals/use.ts", "utf8");
    expect(source).not.toMatch(/process\.type|parentPort|\(process as/u);
    expect(readFileSync("src/core/core.ts", "utf8")).not.toMatch(/\(process as unknown as \{ parentPort/u);
  });
});
