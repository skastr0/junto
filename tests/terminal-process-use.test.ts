import { afterEach, describe, expect, it } from "vitest";
import { terminalProcess, useTerminalProcess } from "../src/main/terminal-process/use";

/**
 * The PTY slot's law: an unfilled client means this process spawns live, and
 * that is only true off Electron main. Main holding no client must fail
 * loudly, not spawn a PTY on its own thread.
 */
const asElectronMain = (main: boolean): void => {
  Object.defineProperty(process, "type", {
    value: main ? "browser" : undefined,
    configurable: true,
    writable: true,
  });
};

afterEach(() => {
  useTerminalProcess(undefined);
  asElectronMain(false);
});

describe("the terminal process slot", () => {
  it("spawns in this process under node, the terminal process and the windowless core", () => {
    expect(process.type).toBeUndefined();
    expect(terminalProcess()).toBeUndefined();
  });

  it("fails loudly on Electron main when nothing installed a terminal client", () => {
    asElectronMain(true);
    expect(() => terminalProcess()).toThrow(/never on main/u);
  });

  it("answers the installed client even on Electron main", () => {
    asElectronMain(true);
    const client = { spawn: () => undefined } as unknown as Parameters<typeof useTerminalProcess>[0];
    useTerminalProcess(client);
    expect(terminalProcess()).toBe(client);
  });
});
