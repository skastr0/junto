import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import rawRuntimePolicy from "../scripts/macos-runtime-policy.json";
import {
  EXPECTED_JIT_MACHO_PATHS,
  MACOS_RUNTIME_POLICY,
  isMachOMagic,
  parseMachOArchitectures,
  parseMachOSliceMinimumSystemVersion,
  readMachOMinimumSystemVersions,
  validateEntitlementProfile,
  validateMacOSRuntimePolicy,
  validateMachOInventory,
  validateMachOMinimumSystemVersions,
} from "../scripts/audit-packaged-app";
import { signingProfileForPath } from "../scripts/electron-builder-sign.mjs";

const manifestPaths = MACOS_RUNTIME_POLICY.machO.map((entry) => entry.path);

describe("macOS packaged runtime policy", () => {
  it("pins 26 Mach-O objects and only the four exact Electron JIT roles", () => {
    expect(MACOS_RUNTIME_POLICY.machO).toHaveLength(26);
    expect(
      MACOS_RUNTIME_POLICY.machO
        .filter((entry) => entry.profile === "jit")
        .map((entry) => entry.path)
        .sort(),
    ).toEqual([...EXPECTED_JIT_MACHO_PATHS].sort());
    expect(
      MACOS_RUNTIME_POLICY.machO.find(
        (entry) => entry.path === "Contents/Resources/bin/vellum",
      ),
    ).toMatchObject({ identifier: "vellum", profile: "none" });
    expect(
      MACOS_RUNTIME_POLICY.machO.find(
        (entry) => entry.path === "Contents/Resources/bin/vellum-browser",
      ),
    ).toMatchObject({ identifier: "vellum-browser", profile: "none" });
    expect(
      MACOS_RUNTIME_POLICY.machO.find(
        (entry) =>
          entry.path ===
          "Contents/Resources/app.asar.unpacked/node_modules/node-pty/bin/darwin-arm64-148/node-pty.node",
      ),
    ).toMatchObject({ identifier: "node-pty", profile: "none" });
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
    expect(() => validateMacOSRuntimePolicy(missing)).toThrow(/exactly 26/u);

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

  it("parses exactly one macOS deployment declaration per Mach-O slice", () => {
    const modern = `
Load command 9
      cmd LC_BUILD_VERSION
  cmdsize 32
 platform 1
    minos 12.10
      sdk 15.2
`;
    const legacy = `
Load command 8
      cmd LC_VERSION_MIN_MACOSX
  cmdsize 16
  version 13.0
      sdk 15.2
`;
    expect(parseMachOArchitectures("arm64 x86_64\n")).toEqual([
      "arm64",
      "x86_64",
    ]);
    expect(parseMachOSliceMinimumSystemVersion(modern, "arm64")).toBe("12.10");
    expect(parseMachOSliceMinimumSystemVersion(legacy, "x86_64")).toBe("13.0");
    expect(
      validateMachOMinimumSystemVersions(
        [
          parseMachOSliceMinimumSystemVersion(modern, "arm64"),
          parseMachOSliceMinimumSystemVersion(legacy, "x86_64"),
        ],
        "13.0",
        "Contents/Frameworks/Vellum Helper (Renderer).app/Contents/MacOS/Vellum Helper (Renderer)",
      ),
    ).toBe("13.0");
  });

  it("rejects non-macOS, duplicate, missing, and too-new slice declarations", () => {
    const ios = `
Load command 9
      cmd LC_BUILD_VERSION
  cmdsize 32
 platform 2
    minos 13.0
      sdk 15.2
`;
    const duplicate = `
Load command 8
      cmd LC_VERSION_MIN_MACOSX
  cmdsize 16
  version 12.0
      sdk 15.2
Load command 9
      cmd LC_BUILD_VERSION
  cmdsize 32
 platform 1
    minos 13.0
      sdk 15.2
`;
    expect(() => parseMachOSliceMinimumSystemVersion(ios, "arm64")).toThrow(
      /must target macOS platform 1/u,
    );
    expect(() => parseMachOSliceMinimumSystemVersion(duplicate, "arm64")).toThrow(
      /exactly one macOS deployment declaration/u,
    );
    expect(() =>
      parseMachOSliceMinimumSystemVersion(
        "Load command 0\n      cmd LC_SEGMENT_64\n",
        "arm64",
      ),
    ).toThrow(/exactly one macOS deployment declaration/u);
    expect(() =>
      validateMachOMinimumSystemVersions(
        ["12.6", "13.0.1"],
        "13.0",
        "Contents/Resources/bin/vellum-browser",
      ),
    ).toThrow(/minos=13\.0\.1 declared=13\.0/u);
    expect(() => parseMachOArchitectures("arm64 arm64")).toThrow(
      /invalid or duplicate/u,
    );
  });

  it("queries every fat slice independently using fixed lipo and otool argv", () => {
    const helperPath =
      "/tmp/Vellum.app/Contents/Frameworks/Vellum Helper (Renderer).app/Contents/MacOS/Vellum Helper (Renderer)";
    const calls: Array<{
      readonly executable: string;
      readonly args: ReadonlyArray<string>;
    }> = [];
    const modern = `
Load command 9
      cmd LC_BUILD_VERSION
  cmdsize 32
 platform 1
    minos 13.0
`;
    const runCommand = (
      executable: string,
      args: ReadonlyArray<string>,
    ): string => {
      calls.push({ executable, args });
      if (executable === "/usr/bin/lipo") return "arm64 x86_64\n";
      if (args[1] === "arm64") return modern;
      return "Load command 0\n      cmd LC_SEGMENT_64\n";
    };

    expect(() =>
      readMachOMinimumSystemVersions(helperPath, runCommand),
    ).toThrow(/architecture x86_64 must contain exactly one/u);
    expect(calls).toEqual([
      { executable: "/usr/bin/lipo", args: ["-archs", helperPath] },
      {
        executable: "/usr/bin/otool",
        args: ["-arch", "arm64", "-m", "-l", helperPath],
      },
      {
        executable: "/usr/bin/otool",
        args: ["-arch", "x86_64", "-m", "-l", helperPath],
      },
    ]);
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
        path.join(appPath, "Contents/Resources/bin/vellum"),
        MACOS_RUNTIME_POLICY,
      ),
    ).toBe("none");
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
    ).toThrow(/outside (?:Vellum\.app|the app bundle)/u);
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
      readFile(new URL("../scripts/package-app-macos.sh", import.meta.url), "utf8"),
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
