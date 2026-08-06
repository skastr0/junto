import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  resolveControlHome,
  usableControlHome,
} from "../src/main/vellum/control-home";

const ELECTRON_HOME = "/Users/operator";
const USER_DATA = "/tmp/vellum-command-e2e-xyz/user-data";
const SANDBOX_HOME = "/tmp/vellum-command-e2e-xyz/home";
const EXPLICIT = "/tmp/probe/control-root";

const base = {
  electronHome: ELECTRON_HOME,
  userData: USER_DATA,
} as const;

describe("usableControlHome", () => {
  it("accepts absolute paths and resolves them", () => {
    expect(usableControlHome("/tmp/home")).toBe(resolve("/tmp/home"));
    expect(usableControlHome("  /tmp/home  ")).toBe(resolve("/tmp/home"));
  });

  it("rejects empty, relative, oversized, and control-character paths", () => {
    expect(usableControlHome(undefined)).toBeUndefined();
    expect(usableControlHome("")).toBeUndefined();
    expect(usableControlHome("   ")).toBeUndefined();
    expect(usableControlHome("relative/home")).toBeUndefined();
    expect(usableControlHome("home")).toBeUndefined();
    expect(usableControlHome(`/${"a".repeat(5_000)}`)).toBeUndefined();
    // Embedded control chars (not trailing whitespace that trim() would drop).
    expect(usableControlHome("/tmp/ho\nme")).toBeUndefined();
    expect(usableControlHome("/tmp/ho\u0000me")).toBeUndefined();
  });
});

describe("resolveControlHome", () => {
  it("uses production electronHome when no sandbox signals are present", () => {
    expect(
      resolveControlHome({
        ...base,
        packaged: true,
      }),
    ).toBe(resolve(ELECTRON_HOME));
  });

  it("prefers absolute env HOME over electronHome (E2E / container sandboxes)", () => {
    expect(
      resolveControlHome({
        ...base,
        envHome: SANDBOX_HOME,
        electronHome: ELECTRON_HOME,
        e2e: true,
        headless: false,
        packaged: false,
      }),
    ).toBe(resolve(SANDBOX_HOME));
  });

  it("honors absolute explicitHome above env HOME", () => {
    expect(
      resolveControlHome({
        ...base,
        envHome: SANDBOX_HOME,
        explicitHome: EXPLICIT,
        e2e: true,
      }),
    ).toBe(resolve(EXPLICIT));
  });

  it("ignores unusable explicitHome and falls through to env HOME", () => {
    expect(
      resolveControlHome({
        ...base,
        envHome: SANDBOX_HOME,
        explicitHome: "relative",
      }),
    ).toBe(resolve(SANDBOX_HOME));
  });

  it("ignores unusable env HOME and continues the chain", () => {
    expect(
      resolveControlHome({
        ...base,
        envHome: "not-absolute",
        headless: true,
        packaged: false,
      }),
    ).toBe(resolve(USER_DATA));
  });

  it("uses userData for headless unpackaged when HOME is unset (probe isolation)", () => {
    expect(
      resolveControlHome({
        ...base,
        headless: true,
        packaged: false,
      }),
    ).toBe(resolve(USER_DATA));
  });

  it("does not force userData for headless packaged when HOME is unset", () => {
    expect(
      resolveControlHome({
        ...base,
        headless: true,
        packaged: true,
      }),
    ).toBe(resolve(ELECTRON_HOME));
  });

  it("fail-closes e2e to userData when HOME is missing (never electronHome)", () => {
    expect(
      resolveControlHome({
        ...base,
        e2e: true,
        headless: false,
        packaged: false,
      }),
    ).toBe(resolve(USER_DATA));
  });

  it("never returns electronHome under e2e when only electronHome would match", () => {
    const home = resolveControlHome({
      ...base,
      envHome: undefined,
      e2e: true,
    });
    expect(home).not.toBe(resolve(ELECTRON_HOME));
    expect(home).toBe(resolve(USER_DATA));
  });

  it("prefers env HOME even when it equals electronHome (production HOME set)", () => {
    // Same path string shape — both resolve to operator home. Preferring HOME
    // keeps browser/term aligned with work control + os.homedir().
    expect(
      resolveControlHome({
        ...base,
        envHome: ELECTRON_HOME,
        electronHome: ELECTRON_HOME,
        packaged: true,
      }),
    ).toBe(resolve(ELECTRON_HOME));
  });

  it("matches the e2e harness contract: HOME sandbox + VELLUM_COMMAND_E2E non-headless", () => {
    // e2e/harness/launch.ts sets HOME=sandbox.homeDir, VELLUM_COMMAND_E2E=1,
    // --user-data-dir=sandbox.userDataDir; browser-control-client expects
    // sockets under sandbox.homeDir (not userData).
    const home = resolveControlHome({
      envHome: SANDBOX_HOME,
      electronHome: ELECTRON_HOME,
      userData: USER_DATA,
      e2e: true,
      headless: false,
      packaged: false,
    });
    expect(home).toBe(resolve(SANDBOX_HOME));
    expect(home).not.toBe(resolve(ELECTRON_HOME));
    expect(home).not.toBe(resolve(USER_DATA));
  });

  it("matches headless probe isolation: no HOME, userData + optional VELLUM_COMMAND_BROWSER_HOME", () => {
    const withoutExplicit = resolveControlHome({
      ...base,
      headless: true,
      packaged: false,
    });
    expect(withoutExplicit).toBe(resolve(USER_DATA));

    const withBrowserHome = resolveControlHome({
      ...base,
      headless: true,
      packaged: false,
      explicitHome: USER_DATA,
    });
    expect(withBrowserHome).toBe(resolve(USER_DATA));
  });

  it("treats empty-string env/explicit as unset", () => {
    expect(
      resolveControlHome({
        ...base,
        envHome: "",
        explicitHome: "  ",
        e2e: true,
      }),
    ).toBe(resolve(USER_DATA));
  });

  it("resolves relative userData/electronHome roots (caller may pass raw getPath)", () => {
    // resolve() normalizes; callers always pass absolute Electron paths in
    // production, but the helper still returns a resolved string.
    expect(
      resolveControlHome({
        electronHome: ELECTRON_HOME,
        userData: USER_DATA,
      }),
    ).toBe(resolve(ELECTRON_HOME));
  });
});
