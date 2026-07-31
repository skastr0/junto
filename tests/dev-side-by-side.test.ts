import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  shouldPinUnpackagedElectronUserData,
  unpackagedElectronUserDataPath,
  usableVellumHome,
} from "../src/shared/vellum-home";

const main = readFileSync(
  new URL("../src/main/index.ts", import.meta.url),
  "utf8",
);
const devSh = readFileSync(
  new URL("../scripts/dev.sh", import.meta.url),
  "utf8",
);

describe("dev side-by-side with production install", () => {
  it("pins Electron userData only for unpackaged + VELLUM_HOME (never packaged or --user-data-dir)", () => {
    expect(
      shouldPinUnpackagedElectronUserData({
        packaged: false,
        vellumHomeEnv: "/Users/op/.vellum-dev",
        hasUserDataDirSwitch: false,
      }),
    ).toBe(true);
    expect(
      shouldPinUnpackagedElectronUserData({
        packaged: true,
        vellumHomeEnv: "/Users/op/.vellum-dev",
        hasUserDataDirSwitch: false,
      }),
    ).toBe(false);
    expect(
      shouldPinUnpackagedElectronUserData({
        packaged: false,
        vellumHomeEnv: undefined,
        hasUserDataDirSwitch: false,
      }),
    ).toBe(false);
    expect(
      shouldPinUnpackagedElectronUserData({
        packaged: false,
        vellumHomeEnv: "/Users/op/.vellum-dev",
        hasUserDataDirSwitch: true,
      }),
    ).toBe(false);
    expect(
      shouldPinUnpackagedElectronUserData({
        packaged: false,
        vellumHomeEnv: "relative-not-allowed",
        hasUserDataDirSwitch: false,
      }),
    ).toBe(false);
  });

  it("places unpackaged userData under isolated VELLUM_HOME (not Application Support)", () => {
    expect(unpackagedElectronUserDataPath("/Users/op/.vellum-dev")).toBe(
      join("/Users/op/.vellum-dev", ".vellum", "electron-user-data"),
    );
    expect(usableVellumHome("/Users/op/.vellum-dev")).toBe(
      "/Users/op/.vellum-dev",
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

  it("official bun run dev always sets VELLUM_HOME to ~/.vellum-dev", () => {
    expect(devSh).toContain('ISOLATED_HOME="${HOME}/.vellum-dev"');
    expect(devSh).toContain('export VELLUM_HOME="${ISOLATED_HOME}"');
    expect(devSh).toContain("electron-vite dev");
  });
});
