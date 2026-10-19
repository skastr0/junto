import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// A Preview once quit with no signal and no row saying why. Every quit the app
// asks for itself now names its source in the [quit] log, so an unnamed one
// can only have come from outside: the menu, Cmd+Q, the Dock, an Apple Event
// or a logout.
describe("quit request source wiring", () => {
  const source = readFileSync(join(import.meta.dirname, "..", "src/main/index.ts"), "utf8");
  const quitFor = source.slice(
    source.indexOf("const quitFor = "),
    source.indexOf("const takeQuitRequestSource = "),
  );

  it("routes every in-app app.quit() through quitFor", () => {
    const outside = source.replace(quitFor, "").split("\n")
      .filter((line) => !/^\s*(\/\/|\*)/.test(line) && /\bapp\.quit\(\)/.test(line));
    expect(quitFor).toContain("app.quit()");
    expect(outside).toEqual([]);
  });

  it("names the signal as the source before the signal path asks to quit", () => {
    expect(source).toMatch(/quitPhases\.mark\(`signal \$\{signal\}`\);\s*quitRequestSource \?\?= `signal \$\{signal\}`;/);
  });

  it("logs the source on every before-quit and a row for the quit event", () => {
    const start = source.indexOf('app.on("before-quit"');
    const block = source.slice(start, source.indexOf("if (runtimeDisposed) return;", start));
    expect(block).toContain("takeQuitRequestSource()");
    expect(block).toContain("before-quit, asked by ${quitSource}");
    expect(source).toMatch(/app\.on\("quit", \(_event, exitCode\) => \{\s*quitPhases\.mark\(`quit, exit code \$\{exitCode\}`\);/);
  });
});
