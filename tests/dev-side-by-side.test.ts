import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  shouldPinUnpackagedElectronUserData,
  unpackagedElectronUserDataPath,
  usableJuntoHome,
} from "../src/shared/junto-home";

const main = readFileSync(
  new URL("../src/main/index.ts", import.meta.url),
  "utf8",
);
const devSh = readFileSync(
  new URL("../scripts/dev.sh", import.meta.url),
  "utf8",
);

describe("dev side-by-side with production install", () => {
  it("pins Electron userData only for unpackaged + JUNTO_HOME (never packaged or --user-data-dir)", () => {
    expect(
      shouldPinUnpackagedElectronUserData({
        packaged: false,
        juntoHomeEnv: "/Users/op/.junto-dev",
        hasUserDataDirSwitch: false,
      }),
    ).toBe(true);
    expect(
      shouldPinUnpackagedElectronUserData({
        packaged: true,
        juntoHomeEnv: "/Users/op/.junto-dev",
        hasUserDataDirSwitch: false,
      }),
    ).toBe(false);
    expect(
      shouldPinUnpackagedElectronUserData({
        packaged: false,
        juntoHomeEnv: undefined,
        hasUserDataDirSwitch: false,
      }),
    ).toBe(false);
    expect(
      shouldPinUnpackagedElectronUserData({
        packaged: false,
        juntoHomeEnv: "/Users/op/.junto-dev",
        hasUserDataDirSwitch: true,
      }),
    ).toBe(false);
    expect(
      shouldPinUnpackagedElectronUserData({
        packaged: false,
        juntoHomeEnv: "relative-not-allowed",
        hasUserDataDirSwitch: false,
      }),
    ).toBe(false);
  });

  it("places unpackaged userData under isolated JUNTO_HOME (not Application Support)", () => {
    expect(unpackagedElectronUserDataPath("/Users/op/.junto-dev")).toBe(
      join("/Users/op/.junto-dev", ".junto", "electron-user-data"),
    );
    expect(usableJuntoHome("/Users/op/.junto-dev")).toBe(
      "/Users/op/.junto-dev",
    );
  });

  it("sets userData before requestSingleInstanceLock in main", () => {
    const pin = main.indexOf("shouldPinUnpackagedElectronUserData");
    const setPath = main.indexOf('app.setPath("userData"');
    const lock = main.indexOf("app.requestSingleInstanceLock()");
    expect(pin).toBeGreaterThan(0);
    expect(setPath).toBeGreaterThan(pin);
    expect(lock).toBeGreaterThan(setPath);
  });

  it("official bun run dev always sets JUNTO_HOME to ~/.junto-dev", () => {
    expect(devSh).toContain('ISOLATED_HOME="${HOME}/.junto-dev"');
    expect(devSh).toContain('export JUNTO_HOME="${ISOLATED_HOME}"');
    expect(devSh).toContain("electron-vite dev");
  });
});
