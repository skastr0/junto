import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  OPERATOR_CONTROL_SWITCH,
  operatorControlEnabledFromInitialArgv,
} from "../src/main/junto/operator-control";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  join(import.meta.dirname, "..", "src/main/index.ts"),
  "utf8",
);

describe("operator control main lifecycle", () => {
  it("enables only from the frozen initial argv", () => {
    expect(
      operatorControlEnabledFromInitialArgv(
        ["junto", OPERATOR_CONTROL_SWITCH],
      ),
    ).toBe(true);
    expect(operatorControlEnabledFromInitialArgv(["junto"])).toBe(false);

    const freeze = source.indexOf("const operatorControlEnabledAtLaunch =");
    const singleton = source.indexOf("app.requestSingleInstanceLock()");
    expect(freeze).toBeGreaterThanOrEqual(0);
    expect(freeze).toBeLessThan(singleton);
    const secondInstanceStart = source.indexOf('app.on("second-instance"');
    const secondInstanceEnd = source.indexOf(
      'app.on("activate"',
      secondInstanceStart,
    );
    const secondInstance = source.slice(secondInstanceStart, secondInstanceEnd);
    expect(secondInstance).not.toContain("operatorControl");
    expect(secondInstance).not.toContain(OPERATOR_CONTROL_SWITCH);
  });

  // The operator listener's admission cut and its drain receipt are behaviour,
  // proved against the server itself in operator-control-server.test.ts: the
  // core opens that socket now (operator.ensureListening), so main has no
  // listener to cut. What is left in the shell is its own runtime.

  it("disposes the shell's one runtime after the drains", () => {
    const disposeStart = source.indexOf("const disposeRuntime =");
    const disposeEnd = source.indexOf(
      "const disposeRuntimeFailClosed",
      disposeStart,
    );
    expect(source.slice(disposeStart, disposeEnd)).toContain(
      ".then(() => AppRuntime.dispose())",
    );
  });
});
