import { readFile } from "node:fs/promises";
import {
  FuseState,
  FuseV1Options,
  FuseVersion,
  type FuseConfig,
} from "@electron/fuses";
import { describe, expect, it } from "vitest";
import {
  FUSE_NAMES,
  PACKAGED_STATE_UPDATE_PREFLIGHT_MAIN_ENTRY,
  PACKAGED_STATE_UPDATE_PREFLIGHT_PROTOCOL,
  PACKAGED_STATE_UPDATE_PREFLIGHT_SWITCH,
  PACKAGE_SECURITY_POLICY,
  hashAsarHeaderString,
  parseCodesignMetadata,
  validatePackagedStateUpdatePreflightMain,
  validateCodesignMetadata,
  validateFuseWire,
  validateInfoPlist,
  validatePackageSecurityPolicy,
} from "../scripts/audit-packaged-app";

const developerIdCodesign = `
Executable=/tmp/Vellum Command.app/Contents/MacOS/Vellum Command
Identifier=skastr0.vellumcommand
Format=app bundle with Mach-O thin (arm64)
CodeDirectory v=20500 size=431 flags=0x10000(runtime) hashes=3+7 location=embedded
Signature size=9055
Authority=Developer ID Application: Example Maintainer (EXAMP12345)
Authority=Developer ID Certification Authority
Authority=Apple Root CA
TeamIdentifier=EXAMP12345
Runtime Version=26.4.0
`;

const exactFuseWire = (): FuseConfig<FuseState> => {
  const wire: Record<string | number, string | FuseState> = {
    version: FuseVersion.V1,
  };
  for (const name of FUSE_NAMES) {
    wire[FuseV1Options[name]] = PACKAGE_SECURITY_POLICY.fuses[name]
      ? FuseState.ENABLE
      : FuseState.DISABLE;
  }
  return wire as unknown as FuseConfig<FuseState>;
};

describe("packaged app security policy", () => {
  it("pins every Electron 43 fuse with file protocol privileges disabled", () => {
    expect(FUSE_NAMES).toHaveLength(9);
    expect(PACKAGE_SECURITY_POLICY.fuses).toEqual({
      RunAsNode: false,
      EnableCookieEncryption: true,
      EnableNodeOptionsEnvironmentVariable: false,
      EnableNodeCliInspectArguments: false,
      EnableEmbeddedAsarIntegrityValidation: true,
      OnlyLoadAppFromAsar: true,
      LoadBrowserProcessSpecificV8Snapshot: false,
      GrantFileProtocolExtraPrivileges: false,
      WasmTrapHandlers: true,
    });
  });

  it("rejects an incomplete or extended fuse policy", () => {
    const missing = structuredClone(PACKAGE_SECURITY_POLICY) as unknown as Record<
      string,
      unknown
    >;
    delete (missing.fuses as Record<string, unknown>).WasmTrapHandlers;
    expect(() => validatePackageSecurityPolicy(missing)).toThrow(
      /every Electron fuse exactly once/u,
    );

    const extended = structuredClone(PACKAGE_SECURITY_POLICY) as unknown as Record<
      string,
      unknown
    >;
    (extended.fuses as Record<string, unknown>).UnknownFutureFuse = true;
    expect(() => validatePackageSecurityPolicy(extended)).toThrow(
      /every Electron fuse exactly once/u,
    );
  });
});

describe("codesign metadata audit", () => {
  it("accepts the exact Developer ID team and hardened runtime", () => {
    expect(() =>
      validateCodesignMetadata(parseCodesignMetadata(developerIdCodesign)),
    ).not.toThrow();
  });

  it.each([
    [
      "ad-hoc",
      developerIdCodesign.replace(
        "flags=0x10000(runtime)",
        "flags=0x10002(adhoc,runtime)",
      ),
    ],
    [
      "wrong team",
      developerIdCodesign.replace(
        "TeamIdentifier=EXAMP12345",
        "TeamIdentifier=WRONG",
      ),
    ],
    [
      "wrong identifier",
      developerIdCodesign.replace(
        "Identifier=skastr0.vellumcommand",
        "Identifier=evil.vellum",
      ),
    ],
    [
      "missing runtime",
      developerIdCodesign.replace("flags=0x10000(runtime)", "flags=0x0()"),
    ],
    [
      "wrong authority",
      developerIdCodesign.replace(
        "Developer ID Application: Example Maintainer (EXAMP12345)",
        "Developer ID Application: Other (0000000000)",
      ),
    ],
  ])("rejects %s signing metadata", (_caseName, output) => {
    expect(() => validateCodesignMetadata(parseCodesignMetadata(output))).toThrow();
  });

  it("rejects ambiguous duplicate security-critical fields", () => {
    expect(() =>
      parseCodesignMetadata(
        `${developerIdCodesign}\nTeamIdentifier=EXAMP12345\n`,
      ),
    ).toThrow(/exactly one non-empty TeamIdentifier/u);
  });
});

describe("Electron fuse audit", () => {
  it("accepts the exact nine-fuse wire", () => {
    expect(validateFuseWire(exactFuseWire())).toEqual({
      RunAsNode: "Disabled",
      EnableCookieEncryption: "Enabled",
      EnableNodeOptionsEnvironmentVariable: "Disabled",
      EnableNodeCliInspectArguments: "Disabled",
      EnableEmbeddedAsarIntegrityValidation: "Enabled",
      OnlyLoadAppFromAsar: "Enabled",
      LoadBrowserProcessSpecificV8Snapshot: "Disabled",
      GrantFileProtocolExtraPrivileges: "Disabled",
      WasmTrapHandlers: "Enabled",
    });
  });

  it("rejects a wrong, missing, or unknown fuse state", () => {
    const wrong = exactFuseWire() as Record<number, FuseState>;
    wrong[FuseV1Options.RunAsNode] = FuseState.ENABLE;
    expect(() =>
      validateFuseWire(wrong as unknown as FuseConfig<FuseState>),
    ).toThrow(/RunAsNode mismatch/u);

    const missing = exactFuseWire() as Record<number, FuseState>;
    delete missing[FuseV1Options.WasmTrapHandlers];
    expect(() =>
      validateFuseWire(missing as unknown as FuseConfig<FuseState>),
    ).toThrow(/not the exact known set/u);

    const extended = exactFuseWire() as Record<number, FuseState>;
    extended[9] = FuseState.ENABLE;
    expect(() =>
      validateFuseWire(extended as unknown as FuseConfig<FuseState>),
    ).toThrow(/not the exact known set/u);
  });
});

describe("ASAR integrity audit", () => {
  const hash = "a".repeat(64);
  const plist = {
    CFBundleIdentifier: "skastr0.vellumcommand",
    CFBundleExecutable: "Vellum Command",
    LSMinimumSystemVersion: "13.0",
    ElectronAsarIntegrity: {
      "Resources/app.asar": {
        algorithm: "SHA256",
        hash,
      },
    },
  };

  it("accepts the exact embedded app.asar hash", () => {
    expect(validateInfoPlist(plist, hash)).toEqual({
      algorithm: "SHA256",
      hash,
    });
  });

  it("requires Info.plist to declare the policy minimum system version", () => {
    expect(() =>
      validateInfoPlist(
        { ...plist, LSMinimumSystemVersion: "12.0" },
        hash,
      ),
    ).toThrow(/minimum system version mismatch/u);
    expect(() =>
      validateInfoPlist(
        { ...plist, LSMinimumSystemVersion: undefined },
        hash,
      ),
    ).toThrow(/minimum system version mismatch/u);
  });

  it("hashes the raw ASAR header string rather than whole archive bytes", () => {
    expect(hashAsarHeaderString('{"files":{}}')).toBe(
      "aae5a71db7cd42382ef749f87ca847684d9d4a517cc8235f53ea31bd492c3577",
    );
    expect(hashAsarHeaderString("whole archive bytes")).toBe(
      "782aa9949af8ef700b355937f1acde24e0f2e6cd37983bd804d551c3372a4eb5",
    );
    expect(hashAsarHeaderString('{"files":{}}')).not.toBe(
      hashAsarHeaderString("whole archive bytes"),
    );
  });

  it("rejects missing, malformed, or mismatched integrity metadata", () => {
    expect(() => validateInfoPlist({}, hash)).toThrow(/bundle identifier/u);
    expect(() =>
      validateInfoPlist(
        {
          ...plist,
          ElectronAsarIntegrity: {
            "Resources/app.asar": { algorithm: "SHA1", hash },
          },
        },
        hash,
      ),
    ).toThrow(/invalid app\.asar integrity metadata/u);
    expect(() => validateInfoPlist(plist, "b".repeat(64))).toThrow(
      /does not match app\.asar/u,
    );
  });
});

describe("packaged state update preflight audit", () => {
  const markers = [
    PACKAGED_STATE_UPDATE_PREFLIGHT_SWITCH,
    PACKAGED_STATE_UPDATE_PREFLIGHT_PROTOCOL,
    "[state-preflight] packaged candidate execution is required",
    "state-update-preflight-unpackaged",
    "state-update-preflight-complete",
    "state-update-preflight-failure",
  ] as const;

  it("proves one packaged-only main-process mode without enabling RunAsNode", () => {
    const source = Buffer.from(markers.join("\n"));
    expect(
      validatePackagedStateUpdatePreflightMain(source),
    ).toEqual({
      entry: PACKAGED_STATE_UPDATE_PREFLIGHT_MAIN_ENTRY,
      switch: PACKAGED_STATE_UPDATE_PREFLIGHT_SWITCH,
      protocol: PACKAGED_STATE_UPDATE_PREFLIGHT_PROTOCOL,
      packagedOnly: true,
      bytes: source.byteLength,
    });
    expect(PACKAGE_SECURITY_POLICY.fuses.RunAsNode).toBe(false);
  });

  it.each(markers)(
    "rejects a main bundle missing or duplicating %s",
    (marker) => {
      expect(() =>
        validatePackagedStateUpdatePreflightMain(
          Buffer.from(
            markers.filter((candidate) => candidate !== marker).join("\n"),
          ),
        ),
      ).toThrow(/requires exactly one/u);
      expect(() =>
        validatePackagedStateUpdatePreflightMain(
          Buffer.from([...markers, marker].join("\n")),
        ),
      ).toThrow(/requires exactly one/u);
    },
  );
});

describe("electron-builder fitness", () => {
  it("fails closed on the exact identity and canonical package audit", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as {
      build: {
        afterPack: string;
        files: string[];
        mac: {
          identity: string;
          minimumSystemVersion: string;
          hardenedRuntime: boolean;
          strictVerify: boolean;
          forceCodeSigning: boolean;
        };
      };
    };
    expect(packageJson.build).toMatchObject({
      afterPack: "./scripts/electron-builder-after-pack.mjs",
      mac: {
        forceCodeSigning: true,
        identity: PACKAGE_SECURITY_POLICY.builderIdentity,
        minimumSystemVersion: PACKAGE_SECURITY_POLICY.minimumSystemVersion,
        hardenedRuntime: true,
        strictVerify: true,
      },
    });
    expect(
      packageJson.build.files.filter((entry) =>
        entry.includes("node_modules/@parcel/watcher"),
      ),
    ).toEqual([
      "!node_modules/@parcel/watcher{,/**/*}",
      "!node_modules/@parcel/watcher-*{,/**/*}",
    ]);

    const sshFileSystemLayer = await readFile(
      new URL("../src/main/vellum/ssh/live.ts", import.meta.url),
      "utf8",
    );
    expect(sshFileSystemLayer).toContain(
      'from "@effect/platform-node/NodeFileSystem"',
    );
    expect(sshFileSystemLayer).not.toMatch(
      /NodeFileSystem\/ParcelWatcher|@parcel\/watcher/u,
    );

    const buildScript = await readFile(
      new URL("../scripts/package-app-macos.sh", import.meta.url),
      "utf8",
    );
    expect(buildScript).toContain(
      'bun "$SCRIPT_DIR/audit-packaged-app.ts" "$APP_SRC"',
    );
  });
});
