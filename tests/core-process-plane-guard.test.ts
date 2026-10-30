import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { splitPlaneRefusal } from "../src/main/core-process/plane-guard";

// A core out of main with the PTYs still in main is a split terminal plane.
it("refuses only a core process without the terminal process, and boot refuses it before either starts", () => {
  expect(splitPlaneRefusal({ core: true, terminal: false })).toMatch(/will not start/u);
  expect(splitPlaneRefusal({ core: true, terminal: true })).toBeUndefined();
  expect(splitPlaneRefusal({ core: false, terminal: false })).toBeUndefined();
  expect(splitPlaneRefusal({ core: false, terminal: true })).toBeUndefined();
  const index = readFileSync("src/main/index.ts", "utf8");
  const guard = index.indexOf("splitPlaneRefusal({ core: CORE_PROCESS_ENABLED, terminal: TERMINAL_PROCESS_ENABLED })");
  expect(guard).toBeGreaterThan(-1);
  expect(guard).toBeLessThan(index.indexOf("terminalProcess = startTerminalProcess()"));
  expect(guard).toBeLessThan(index.indexOf("startCoreProcessForMain({"));
  // No fallback: a refusal throws in dev and quits a packaged app.
  expect(index.slice(guard, guard + 600)).toMatch(/throw new Error\(refusal\)/u);
  expect(index.slice(guard, guard + 600)).toMatch(/app\.exit\(1\)/u);
});
