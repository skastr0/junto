import { describe, expect, it } from "vitest";
import {
  E2E_ENV,
  E2E_SANDBOX_PATH_ENV,
  SEAT_VARIABLE_KEYS,
  bootRefusal,
  e2eHarnessRefusal,
  e2eSandboxRefusal,
  juntoPathEnvKeys,
  realHarnessOptInEnv,
  seatVariableRefusal,
  underOrEqual,
} from "../src/shared/e2e-sandbox";

const REAL_HOME = "/Users/operator";
const REAL_JUNTO = `${REAL_HOME}/.junto`;
const SANDBOX = "/tmp/junto-e2e-abcd12";
const SANDBOX_HOME = `${SANDBOX}/home`;
const SANDBOX_BIN = `${SANDBOX_HOME}/.local/bin`;
const FAKES_BIN = "/repo/e2e/fakes/bin";

const e2eEnv = (extra: Record<string, string | undefined> = {}): Record<string, string | undefined> => ({
  [E2E_ENV]: "1",
  HOME: SANDBOX_HOME,
  TMPDIR: SANDBOX,
  TMP: SANDBOX,
  TEMP: SANDBOX,
  PATH: `${SANDBOX_BIN}:${FAKES_BIN}:/usr/bin:/bin`,
  [E2E_SANDBOX_PATH_ENV]: `${SANDBOX_BIN}:${FAKES_BIN}`,
  ...extra,
});

describe("the E2E boot tripwire", () => {
  it("passes a launch that lives entirely in its sandbox", () => {
    expect(e2eSandboxRefusal({ env: e2eEnv(), realHome: REAL_HOME, userData: `${SANDBOX}/user-data`, juntoHome: SANDBOX_HOME })).toBeUndefined();
  });

  it("does nothing outside an E2E run, whatever the environment holds", () => {
    expect(
      e2eSandboxRefusal({
        env: { HOME: REAL_HOME, JUNTO_HOME: REAL_HOME, JUNTO_WORK_TOKEN: "junto-seat-live" },
        realHome: REAL_HOME,
      }),
    ).toBeUndefined();
  });

  // (a) every path the app would open stays out of the operator's ~/.junto.
  it("refuses a Junto home that resolves to the operator's real home", () => {
    const refusal = e2eSandboxRefusal({
      env: e2eEnv({ JUNTO_HOME: REAL_HOME }),
      realHome: REAL_HOME,
      userData: `${SANDBOX}/user-data`,
    });
    expect(refusal?.check).toBe("junto-home");
    expect(refusal?.reason).toContain(REAL_HOME);
    expect(refusal?.reason).toContain(REAL_JUNTO);
  });

  it("refuses a work home inside it, even when only HOME pointed there", () => {
    const refusal = e2eSandboxRefusal({
      env: e2eEnv({ HOME: REAL_HOME }),
      realHome: REAL_HOME,
      userData: `${SANDBOX}/user-data`,
    });
    expect(refusal?.check).toBe("junto-home");
  });

  it("refuses JUNTO_WORK_HOME at the operator's live work home", () => {
    const refusal = e2eSandboxRefusal({
      env: e2eEnv({ JUNTO_WORK_HOME: `${REAL_JUNTO}/work` }),
      realHome: REAL_HOME,
      userData: `${SANDBOX}/user-data`,
    });
    expect(refusal?.check).toBe("path");
    expect(refusal?.path).toBe(`${REAL_JUNTO}/work`);
    expect(refusal?.reason).toContain("JUNTO_WORK_HOME");
  });

  it("refuses any JUNTO_*_HOME or JUNTO_*SOCKET that reaches the real tree", () => {
    for (const [key, path] of [
      ["JUNTO_BROWSER_HOME", REAL_JUNTO],
      ["JUNTO_TERM_HOME", `${REAL_JUNTO}/term`],
      ["JUNTO_WORK_SOCKET", `${REAL_JUNTO}/work/control.sock`],
      ["JUNTO_SOCKET", `${REAL_JUNTO}/operator/control.sock`],
      ["JUNTO_BROWSER_SOCKET", `${REAL_JUNTO}/browser/control.sock`],
    ] as const) {
      const refusal = e2eSandboxRefusal({
        env: e2eEnv({ [key]: path }),
        realHome: REAL_HOME,
        userData: `${SANDBOX}/user-data`,
      });
      expect(refusal?.check, key).toBe("path");
      expect(refusal?.path, key).toBe(path);
    }
  });

  it("refuses a user-data dir inside the real tree", () => {
    const refusal = e2eSandboxRefusal({
      env: e2eEnv(),
      realHome: REAL_HOME,
      userData: `${REAL_JUNTO}/electron-user-data`,
      juntoHome: SANDBOX_HOME,
    });
    expect(refusal?.check).toBe("path");
    expect(refusal?.path).toBe(`${REAL_JUNTO}/electron-user-data`);
  });

  it("is not fooled by a sibling directory that only shares the prefix", () => {
    expect(
      e2eSandboxRefusal({
        env: e2eEnv({ JUNTO_WORK_HOME: `${REAL_HOME}/.junto-dev/work` }),
        realHome: REAL_HOME,
        userData: `${SANDBOX}/user-data`,
      }),
    ).toBeUndefined();
  });

});

// (b) the seat rule is unconditional: no E2E marker needed, and none of the
// six variables is tolerated. A second app launched from a seat's shell is the
// case a test-only guard would miss.
describe("the seat inheritance rule", () => {
  it("refuses every seat variable, with no E2E marker at all", () => {
    for (const key of SEAT_VARIABLE_KEYS) {
      const refusal = seatVariableRefusal({ HOME: REAL_HOME, [key]: key.endsWith("TOKEN") || key === "JUNTO_SEAT" || key === "JUNTO_NODE_REF" ? "value" : "/Users/operator/.junto/work/control.sock" });
      expect(refusal?.check, key).toBe("seat");
      expect(refusal?.reason, key).toContain(key);
      expect(refusal?.reason, key).toContain("refuses to start");
    }
  });

  it("passes an ordinary launch's environment", () => {
    expect(seatVariableRefusal({ HOME: REAL_HOME, PATH: "/usr/bin:/bin", JUNTO_HOME: `${REAL_HOME}/.junto-dev` })).toBeUndefined();
  });

  it("treats a blank value as absent", () => {
    expect(seatVariableRefusal({ JUNTO_WORK_TOKEN: "   ", JUNTO_NODE_REF: "" })).toBeUndefined();
  });

  it("is asked before the E2E path rules, so a real launch from a seat is refused", () => {
    const refusal = bootRefusal({
      env: { HOME: REAL_HOME, JUNTO_WORK_TOKEN: "junto-seat-value", JUNTO_SEAT: "x" },
      realHome: REAL_HOME,
    });
    expect(refusal?.check).toBe("seat");
    expect(refusal?.reason).toContain("JUNTO_WORK_TOKEN");
  });

  it("leaves a clean launch of the real home to the ordinary boot", () => {
    expect(bootRefusal({ env: { HOME: REAL_HOME }, realHome: REAL_HOME })).toBeUndefined();
  });
});

describe("the E2E harness tripwire", () => {
  const launch = (file: string, harness = "claude", extra: Record<string, string | undefined> = {}) =>
    e2eHarnessRefusal({ env: e2eEnv(extra), harness, file, realHome: REAL_HOME });

  // (c) a seat runs only a harness the sandbox holds.
  it("allows a harness seeded in the sandbox home", () => {
    expect(launch(`${SANDBOX_HOME}/.local/bin/claude`)).toBeUndefined();
  });

  it("allows the fake binaries the harness itself ships", () => {
    expect(launch(`${FAKES_BIN}/hermes`, "hermes")).toBeUndefined();
  });

  it("refuses a real install outside the sandbox", () => {
    for (const file of [`${REAL_HOME}/.local/bin/claude`, "/opt/homebrew/bin/codex", "/usr/local/bin/amp"]) {
      const refusal = launch(file, "claude");
      expect(refusal?.check).toBe("harness");
      expect(refusal?.path).toBe(file);
      expect(refusal?.reason).toContain(realHarnessOptInEnv("claude"));
    }
  });

  it("lets a spec opt in to the real binary by name, for that harness only", () => {
    expect(launch("/opt/homebrew/bin/codex", "codex", { JUNTO_REAL_CODEX_SOCKET: "1" })).toBeUndefined();
    expect(launch("/opt/homebrew/bin/codex", "codex", { JUNTO_REAL_CLAUDE_SOCKET: "1" })?.check).toBe("harness");
  });

  it("does nothing outside an E2E run", () => {
    expect(
      e2eHarnessRefusal({ env: { [E2E_ENV]: "0", HOME: SANDBOX_HOME }, harness: "claude", file: "/opt/homebrew/bin/claude", realHome: REAL_HOME }),
    ).toBeUndefined();
  });

  it("refuses a real harness even when HOME is the operator's own", () => {
    // Two opt-in specs point HOME at the real home so a real harness finds its
    // login. HOME alone must not turn that into a sandbox.
    const refusal = launch(`${REAL_HOME}/.local/bin/claude`, "claude", { HOME: REAL_HOME });
    expect(refusal?.check).toBe("harness");
    expect(launch(`${REAL_HOME}/.local/bin/claude`, "claude", { HOME: REAL_HOME, JUNTO_REAL_CLAUDE_SOCKET: "1" })).toBeUndefined();
  });

  it("leaves an unresolved bare name to the missing-binary refusal", () => {
    expect(launch("claude")).toBeUndefined();
  });
});

describe("the path rules themselves", () => {
  it("match at a separator boundary, not on a string prefix", () => {
    expect(underOrEqual(`${REAL_JUNTO}/work`, REAL_JUNTO)).toBe(true);
    expect(underOrEqual(REAL_JUNTO, REAL_JUNTO)).toBe(true);
    expect(underOrEqual(`${REAL_JUNTO}dev`, REAL_JUNTO)).toBe(false);
    expect(underOrEqual(REAL_HOME, REAL_JUNTO)).toBe(false);
  });

  it("name the family by shape, so a new home or socket is covered the day it lands", () => {
    expect(
      juntoPathEnvKeys({
        JUNTO_HOME: "/a",
        JUNTO_WORK_HOME: "/b",
        JUNTO_SOMETHING_SOCKET: "/c",
        JUNTO_SOCKET: "/d",
        JUNTO_E2E_SANDBOX_PATH: "/e/f",
        JUNTO_WORK_TOKEN: "secret",
        JUNTO_HOME_EMPTY: " ",
      }),
    ).toEqual(["JUNTO_HOME", "JUNTO_SOCKET", "JUNTO_SOMETHING_SOCKET", "JUNTO_WORK_HOME"]);
  });
});
