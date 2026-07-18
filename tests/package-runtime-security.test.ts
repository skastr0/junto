import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import rawRuntimePolicy from "../scripts/macos-runtime-policy.json";
import {
  EXPECTED_JIT_MACHO_PATHS,
  MACOS_RUNTIME_POLICY,
  isMachOMagic,
  parseMachOMinimumSystemVersions,
  validateEntitlementProfile,
  validateMacOSRuntimePolicy,
  validateMachOInventory,
  validateMachOMinimumSystemVersions,
} from "../scripts/audit-packaged-app";
import { signingProfileForPath } from "../scripts/electron-builder-sign.mjs";

const manifestPaths = MACOS_RUNTIME_POLICY.machO.map((entry) => entry.path);

describe("macOS packaged runtime policy", () => {
  it("pins 18 Mach-O objects and only the four exact Electron JIT roles", () => {
    expect(MACOS_RUNTIME_POLICY.machO).toHaveLength(18);
    expect(
      MACOS_RUNTIME_POLICY.machO
        .filter((entry) => entry.profile === "jit")
        .map((entry) => entry.path)
        .sort(),
    ).toEqual([...EXPECTED_JIT_MACHO_PATHS].sort());
    expect(
      MACOS_RUNTIME_POLICY.machO.find(
        (entry) => entry.path === "Contents/Resources/bin/vellum-browser",
      ),
    ).toMatchObject({ identifier: "vellum-browser", profile: "none" });
    expect(MACOS_RUNTIME_POLICY.profiles).toEqual({
      none: {},
      jit: { "com.apple.security.cs.allow-jit": true },
    });
  });

  it("rejects profile expansion, CLI JIT, missing entries, and duplicate paths", () => {
    const expanded = structuredClone(rawRuntimePolicy) as Record<string, unknown>;
    (
      (expanded.profiles as Record<string, unknown>).jit as Record<string, unknown>
    )["com.apple.security.cs.disable-library-validation"] = true;
    expect(() => validateMacOSRuntimePolicy(expanded)).toThrow(/only empty and allow-jit/u);

    const cliJit = structuredClone(rawRuntimePolicy);
    const cli = cliJit.machO.find(
      (entry) => entry.path === "Contents/Resources/bin/vellum-browser",
    );
    if (cli === undefined) throw new Error("test fixture is missing vellum-browser");
    cli.profile = "jit";
    expect(() => validateMacOSRuntimePolicy(cliJit)).toThrow(/JIT roles mismatch/u);

    const missing = structuredClone(rawRuntimePolicy);
    missing.machO.pop();
    expect(() => validateMacOSRuntimePolicy(missing)).toThrow(/exactly 18/u);

    const duplicate = structuredClone(rawRuntimePolicy);
    duplicate.machO[1].path = duplicate.machO[0].path;
    expect(() => validateMacOSRuntimePolicy(duplicate)).toThrow(/duplicate Mach-O entry/u);
  });

  it("requires the exact inventory without missing, extra, or duplicate paths", () => {
    expect(() => validateMachOInventory(manifestPaths)).not.toThrow();
    expect(() => validateMachOInventory(manifestPaths.slice(1))).toThrow(/missing=/u);
    expect(() =>
      validateMachOInventory([...manifestPaths, "Contents/MacOS/Unexpected"]),
    ).toThrow(/extra=/u);
    expect(() => validateMachOInventory([...manifestPaths, manifestPaths[0]])).toThrow(
      /inventory mismatch/u,
    );
  });

  it("accepts only exact entitlement keys and true values", () => {
    expect(() => validateEntitlementProfile({}, "none")).not.toThrow();
    expect(() =>
      validateEntitlementProfile({ "com.apple.security.cs.allow-jit": true }, "jit"),
    ).not.toThrow();
    expect(() =>
      validateEntitlementProfile(
        { "com.apple.security.cs.allow-unsigned-executable-memory": true },
        "none",
      ),
    ).toThrow(/keys mismatch/u);
    expect(() =>
      validateEntitlementProfile({ "com.apple.security.cs.allow-jit": false }, "jit"),
    ).toThrow(/wrong value/u);
  });

  it("recognizes every thin and fat Mach-O byte order without classifying text", () => {
    for (const magic of [
      "feedface",
      "cefaedfe",
      "feedfacf",
      "cffaedfe",
      "cafebabe",
      "bebafeca",
      "cafebabf",
      "bfbafeca",
    ]) {
      expect(isMachOMagic(Buffer.from(magic, "hex"))).toBe(true);
    }
    expect(isMachOMagic(Buffer.from("7b226f6b", "hex"))).toBe(false);
    expect(isMachOMagic(Buffer.alloc(3))).toBe(false);
  });

  it("parses modern and legacy minimum versions from multi-slice otool output", () => {
    const output = `
/tmp/Vellum Helper (Renderer) (architecture arm64):
Load command 9
      cmd LC_BUILD_VERSION
  cmdsize 32
 platform 1
    minos 12.10
      sdk 15.2
/tmp/Vellum Helper (Renderer) (architecture x86_64):
Load command 8
      cmd LC_VERSION_MIN_MACOSX
  cmdsize 16
  version 13.0
      sdk 15.2
`;
    expect(parseMachOMinimumSystemVersions(output)).toEqual(["12.10", "13.0"]);
    expect(
      validateMachOMinimumSystemVersions(
        parseMachOMinimumSystemVersions(output),
        "13.0",
        "Contents/Frameworks/Vellum Helper (Renderer).app/Contents/MacOS/Vellum Helper (Renderer)",
      ),
    ).toBe("13.0");
  });

  it("rejects any Mach-O slice newer than the declared app minimum", () => {
    expect(() =>
      validateMachOMinimumSystemVersions(
        ["12.6", "13.0.1"],
        "13.0",
        "Contents/Resources/bin/vellum-browser",
      ),
    ).toThrow(/minos=13\.0\.1 declared=13\.0/u);
    expect(() => parseMachOMinimumSystemVersions("no load commands")).toThrow(
      /missing a macOS minimum system version/u,
    );
  });
});

describe("electron-builder role-specific signing", () => {
  const appPath = "/tmp/release/Vellum.app";

  it("selects JIT for exact main/helper bundles and executables only", () => {
    expect(signingProfileForPath(appPath, appPath, MACOS_RUNTIME_POLICY)).toBe("jit");
    for (const relativePath of EXPECTED_JIT_MACHO_PATHS) {
      expect(
        signingProfileForPath(appPath, path.join(appPath, relativePath), MACOS_RUNTIME_POLICY),
      ).toBe("jit");
      if (relativePath.includes(".app/Contents/MacOS/")) {
        const helperBundle = relativePath.slice(0, relativePath.indexOf("/Contents/MacOS/"));
        expect(
          signingProfileForPath(appPath, path.join(appPath, helperBundle), MACOS_RUNTIME_POLICY),
        ).toBe("jit");
      }
    }
    expect(
      signingProfileForPath(
        appPath,
        path.join(appPath, "Contents/Resources/bin/vellum-browser"),
        MACOS_RUNTIME_POLICY,
      ),
    ).toBe("none");
    expect(
      signingProfileForPath(
        appPath,
        path.join(
          appPath,
          "Contents/Frameworks/Vellum Helper (Plugin).app/Contents/MacOS/Vellum Helper (Plugin)",
        ),
        MACOS_RUNTIME_POLICY,
      ),
    ).toBe("none");
    expect(() =>
      signingProfileForPath(appPath, "/tmp/outside", MACOS_RUNTIME_POLICY),
    ).toThrow(/outside Vellum\.app/u);
  });

  it("wires the custom signer, explicit profiles, audit, and verify-only smoke", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as {
      build: { mac: Record<string, unknown> };
      devDependencies: Record<string, string>;
    };
    expect(packageJson.devDependencies["@electron/osx-sign"]).toBe("1.3.3");
    expect(packageJson.build.mac).toMatchObject({
      minimumSystemVersion: "13.0",
      sign: "./scripts/electron-builder-sign.mjs",
      entitlements: "build/entitlements.mac.plist",
      entitlementsInherit: "build/entitlements.mac.inherit.plist",
      preAutoEntitlements: false,
      hardenedRuntime: true,
      strictVerify: true,
    });

    const [jitPlist, emptyPlist, signer, buildScript] = await Promise.all([
      readFile(new URL("../build/entitlements.mac.plist", import.meta.url), "utf8"),
      readFile(
        new URL("../build/entitlements.mac.inherit.plist", import.meta.url),
        "utf8",
      ),
      readFile(new URL("../scripts/electron-builder-sign.mjs", import.meta.url), "utf8"),
      readFile(new URL("../scripts/build-app.sh", import.meta.url), "utf8"),
    ]);
    expect(jitPlist).toContain("com.apple.security.cs.allow-jit");
    expect(emptyPlist).toContain("<dict/>");
    for (const forbidden of [
      "com.apple.security.cs.allow-unsigned-executable-memory",
      "com.apple.security.cs.disable-library-validation",
    ]) {
      expect(`${jitPlist}\n${emptyPlist}\n${signer}`).not.toContain(forbidden);
    }
    expect(buildScript).toContain('bun "$SCRIPT_DIR/audit-packaged-app.ts" "$APP_SRC"');
    expect(buildScript).toContain('if [[ "$VERIFY" -eq 1 ]]');
    expect(buildScript).toContain(
      'bun "$SCRIPT_DIR/packaged-runtime-smoke.ts" "$APP_SRC"',
    );
  });
});
