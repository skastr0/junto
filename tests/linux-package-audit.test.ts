import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  EXPECTED_APPARMOR_PROFILE,
  LINUX_DEB_DEPENDENCIES,
  LINUX_SYSTEMD_UNSET_ENVIRONMENT,
  parseDebArchiveListing,
  parseDebControl,
  parseDesktopEntry,
  validateAppArmorProfile,
  validateDebArchive,
  validateDebControl,
  validateDesktopEntry,
  validateElfX64,
  validateLinuxPackageArtifactNames,
  validateLinuxRemoteLauncher,
  validateNoFileCapabilities,
  validateSystemdUserUnit,
} from "../scripts/audit-linux-package";

const debControl = (overrides: Record<string, string> = {}): string => {
  const fields = {
    Package: "vellum",
    Version: "0.1.0",
    Architecture: "amd64",
    Depends: LINUX_DEB_DEPENDENCIES.join(", "),
    Description: "Vellum Command",
    ...overrides,
  };
  return Object.entries(fields)
    .map(([name, value]) => `${name}: ${value}`)
    .join("\n");
};

const archiveListing = (extra = ""): string => `
drwxr-xr-x root/root 0 2026-07-22 00:00 ./
drwxr-xr-x root/root 0 2026-07-22 00:00 ./opt/
drwxr-xr-x root/root 0 2026-07-22 00:00 ./opt/Vellum Command/
drwxr-xr-x root/root 0 2026-07-22 00:00 ./usr/
drwxr-xr-x root/root 0 2026-07-22 00:00 ./usr/share/
drwxr-xr-x root/root 0 2026-07-22 00:00 ./usr/share/doc/
drwxr-xr-x root/root 0 2026-07-22 00:00 ./usr/share/doc/vellum/
-rw-r--r-- root/root 1 2026-07-22 00:00 ./usr/share/doc/vellum/changelog.gz
drwxr-xr-x root/root 0 2026-07-22 00:00 ./usr/share/applications/
-rw-r--r-- root/root 1 2026-07-22 00:00 ./usr/share/applications/vellum.desktop
drwxr-xr-x root/root 0 2026-07-22 00:00 ./usr/share/icons/
drwxr-xr-x root/root 0 2026-07-22 00:00 ./usr/share/icons/hicolor/
drwxr-xr-x root/root 0 2026-07-22 00:00 ./usr/share/icons/hicolor/1024x1024/
drwxr-xr-x root/root 0 2026-07-22 00:00 ./usr/share/icons/hicolor/1024x1024/apps/
-rw-r--r-- root/root 1 2026-07-22 00:00 ./usr/share/icons/hicolor/1024x1024/apps/vellum.png
-rwxr-xr-x root/root 1 2026-07-22 00:00 ./opt/Vellum Command/vellum
-rwxr-xr-x root/root 1 2026-07-22 00:00 ./opt/Vellum Command/chrome-sandbox
drwxr-xr-x root/root 0 2026-07-22 00:00 ./opt/Vellum Command/resources/
drwxr-xr-x root/root 0 2026-07-22 00:00 ./opt/Vellum Command/resources/bin/
-rwxr-xr-x root/root 1 2026-07-22 00:00 ./opt/Vellum Command/resources/bin/vellum
-rwxr-xr-x root/root 1 2026-07-22 00:00 ./opt/Vellum Command/resources/bin/vellum-browser
-rwxr-xr-x root/root 1 2026-07-22 00:00 ./opt/Vellum Command/resources/bin/vellum-release-installer
-rwxr-xr-x root/root 1 2026-07-22 00:00 ./opt/Vellum Command/resources/bin/vellum-release-bridge
-rwxr-xr-x root/root 1 2026-07-22 00:00 ./opt/Vellum Command/resources/bin/unix-peer-pid.py
drwxr-xr-x root/root 0 2026-07-22 00:00 ./opt/Vellum Command/resources/policy/
-rw-r--r-- root/root 1 2026-07-22 00:00 ./opt/Vellum Command/resources/apparmor-profile
${extra}`.trimStart();

const desktopEntry = `
[Desktop Entry]
Name=Vellum Command
Comment=Spatial command station for multi-agent fleets
Exec="/opt/Vellum Command/vellum" %U
Terminal=false
Type=Application
Icon=vellum
StartupWMClass=Vellum Command
Categories=Development;
MimeType=x-scheme-handler/vellum;
`;

const systemdUserUnit = async (): Promise<string> =>
  readFile(
    new URL("../build/linux/vellum-remote.service", import.meta.url),
    "utf8",
  );

const linuxRemoteLauncher = async (): Promise<string> =>
  readFile(
    new URL("../build/linux/vellum-remote-launch-v1", import.meta.url),
    "utf8",
  );

describe("Ubuntu deb control policy", () => {
  it("accepts only the Ubuntu 24.04 x64 runtime inventory", () => {
    expect(validateDebControl(debControl(), "0.1.0")).toMatchObject({
      package: "vellum",
      version: "0.1.0",
      architecture: "amd64",
      depends: [...LINUX_DEB_DEPENDENCIES].sort(),
    });
    expect(parseDebControl("Field: first\n second").get("Field")).toBe("first\nsecond");
  });

  it("rejects architecture drift, missing deps, development tools, and duplicate fields", () => {
    expect(() => validateDebControl(debControl({ Architecture: "arm64" }), "0.1.0")).toThrow(
      /identity, version, architecture/u,
    );
    expect(() => validateDebControl(debControl({ Depends: "python3" }), "0.1.0")).toThrow(
      /dependency inventory/u,
    );
    expect(() =>
      validateDebControl(
        debControl({ Depends: `${LINUX_DEB_DEPENDENCIES.join(", ")}, build-essential` }),
        "0.1.0",
      ),
    ).toThrow(/dependency inventory/u);
    expect(() => parseDebControl("Package: vellum\nPackage: other")).toThrow(/duplicate/u);
  });
});

describe("Linux package artifact naming boundary", () => {
  const identity = {
    productName: "Vellum Command",
    version: "0.1.0",
  } as const;

  it("accepts only the exact builder and canonical artifact pairs", () => {
    expect(validateLinuxPackageArtifactNames({
      ...identity,
      unpackedName: "linux-unpacked",
      debName: "Vellum Command-0.1.0-amd64-linux.deb",
    })).toBe("builder");
    expect(validateLinuxPackageArtifactNames({
      ...identity,
      unpackedName: "Vellum Command-0.1.0-x64-linux.unpacked",
      debName: "Vellum Command-0.1.0-x64-linux.deb",
    })).toBe("canonical");
  });

  it.each([
    ["linux-unpacked", "Vellum Command-0.1.0-x64-linux.deb"],
    ["Vellum Command-0.1.0-x64-linux.unpacked", "Vellum Command-0.1.0-amd64-linux.deb"],
    ["linux-unpacked", "Vellum Command-0.1.0-x86_64-linux.deb"],
    ["other", "Vellum Command-0.1.0-amd64-linux.deb"],
  ])("rejects mixed or approximate names: %s / %s", (unpackedName, debName) => {
    expect(() => validateLinuxPackageArtifactNames({
      ...identity,
      unpackedName,
      debName,
    })).toThrow(/layout mismatch/u);
  });
});

describe("deb payload authority and modes", () => {
  it("normalizes numeric dpkg root ownership into the root-owned contract", () => {
    const numericOwnerEntries = parseDebArchiveListing(
      archiveListing().replaceAll("root/root", "0/0"),
    );
    expect(numericOwnerEntries[0]?.owner).toBe("root/root");
    expect(validateDebArchive(numericOwnerEntries).length).toBeGreaterThan(0);
  });

  it("requires a root-owned immutable install tree and inert setuid helper", () => {
    const entries = parseDebArchiveListing(
      archiveListing(
        "lrwxrwxrwx root/root 0 2026-07-22 00:00 ./opt/Vellum Command/resources/internal -> bin/vellum",
      ),
    );
    expect(validateDebArchive(entries).length).toBeGreaterThan(0);
  });

  it.each([
    ["undeclared destination", archiveListing("-rw-r--r-- root/root 1 2026-07-22 00:00 ./etc/evil")],
    ["non-root owner", archiveListing("-rw-r--r-- user/user 1 2026-07-22 00:00 ./other")],
    ["writable payload", archiveListing("-rw-rw-r-- root/root 1 2026-07-22 00:00 ./other")],
    ["setuid payload", archiveListing("-rwsr-xr-x root/root 1 2026-07-22 00:00 ./other")],
    [
      "escaping link",
      archiveListing("lrwxrwxrwx root/root 0 2026-07-22 00:00 ./opt/Vellum Command/resources/escape -> ../../../etc/shadow"),
    ],
  ])("rejects %s", (_name, listing) => {
    expect(() => validateDebArchive(parseDebArchiveListing(listing))).toThrow();
  });

  it("rejects a setuid chrome-sandbox even when the rest of the archive is safe", () => {
    const listing = archiveListing().replace(
      "-rwxr-xr-x root/root 1 2026-07-22 00:00 ./opt/Vellum Command/chrome-sandbox",
      "-rwsr-xr-x root/root 1 2026-07-22 00:00 ./opt/Vellum Command/chrome-sandbox",
    );
    expect(() => validateDebArchive(parseDebArchiveListing(listing))).toThrow(/elevated mode/u);
  });

  it("rejects the retired passwordless installer policy from the package tree", () => {
    const listing = archiveListing(
      "-r--r----- root/root 1 2026-07-22 00:00 ./opt/Vellum Command/resources/policy/vellum-release-installer.sudoers",
    );
    expect(() => validateDebArchive(parseDebArchiveListing(listing))).toThrow(
      /must not package the legacy passwordless/u,
    );
  });

  it("rejects every packaged sudoers policy, not only the retired filename", () => {
    const listing = archiveListing(
      "-r--r----- root/root 1 2026-07-22 00:00 ./opt/Vellum Command/resources/policy/alternate.sudoers",
    );
    expect(() => validateDebArchive(parseDebArchiveListing(listing))).toThrow(
      /must not package any sudoers/u,
    );
  });

  it.each([
    [
      "./usr/share/applications/vellum.desktop",
      "-rw-r--r-- root/root 1 2026-07-22 00:00 ./usr/share/applications/vellum.desktop",
      "lrwxrwxrwx root/root 0 2026-07-22 00:00 ./usr/share/applications/vellum.desktop -> /tmp/vellum.desktop",
    ],
    [
      "./usr/share/icons/hicolor/1024x1024/apps/vellum.png",
      "-rw-r--r-- root/root 1 2026-07-22 00:00 ./usr/share/icons/hicolor/1024x1024/apps/vellum.png",
      "lrwxrwxrwx root/root 0 2026-07-22 00:00 ./usr/share/icons/hicolor/1024x1024/apps/vellum.png -> /tmp/vellum.png",
    ],
  ])("rejects a mutable system-surface symlink at %s", (_path, original, replacement) => {
    const listing = archiveListing().replace(original, replacement);
    expect(() => validateDebArchive(parseDebArchiveListing(listing))).toThrow(
      /type or mode mismatch/u,
    );
  });
});

describe("Linux desktop and sandbox policy", () => {
  it("rejects file capabilities independently of archive mode bits", () => {
    expect(() => validateNoFileCapabilities("")).not.toThrow();
    expect(() =>
      validateNoFileCapabilities(
        "/opt/Vellum Command/resources/bin/vellum-release-bridge cap_setuid=ep\n",
      ),
    ).toThrow(/file capabilities/u);
  });

  it("pins the userns-only AppArmor profile", () => {
    expect(() => validateAppArmorProfile(EXPECTED_APPARMOR_PROFILE)).not.toThrow();
    expect(() =>
      validateAppArmorProfile(EXPECTED_APPARMOR_PROFILE.replace("userns,", "network,")),
    ).toThrow(/userns-only/u);
  });

  it("pins the installed executable, icon, category, and protocol handler", () => {
    expect(() => validateDesktopEntry(desktopEntry)).not.toThrow();
    expect(parseDesktopEntry(desktopEntry).get("Exec")).toBe(
      '"/opt/Vellum Command/vellum" %U',
    );
    expect(() => validateDesktopEntry(desktopEntry.replace("Development;", "Utility;"))).toThrow(
      /Categories/u,
    );
  });

  it("accepts only little-endian x86-64 ELF objects", () => {
    const header = new Uint8Array(20);
    header.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
    header[18] = 0x3e;
    expect(() => validateElfX64(header, "binary")).not.toThrow();
    header[18] = 0xb7;
    expect(() => validateElfX64(header, "binary")).toThrow(/x86-64/u);
  });
});

describe("Linux systemd service environment boundary", () => {
  it("pins the launcher bootstrap to one clean self-exec", async () => {
    const launcher = await linuxRemoteLauncher();
    expect(() => validateLinuxRemoteLauncher(launcher)).not.toThrow();
    expect(() =>
      validateLinuxRemoteLauncher(
        launcher.replace("    PWD=\"$CLEAN_HOME\" \\\n", ""),
      ),
    ).toThrow(/clean-environment boundary/u);
    expect(() =>
      validateLinuxRemoteLauncher(
        launcher.replace(
          "    \"$CLEAN_SELF\" --clean",
          "    EXTRA_AUTHORITY=1 \\\n    \"$CLEAN_SELF\" --clean",
        ),
      ),
    ).toThrow(/clean-environment boundary/u);
    expect(() =>
      validateLinuxRemoteLauncher(
        `printf 'ran before scrub\\n'\n${launcher}`,
      ),
    ).toThrow(/clean-environment boundary/u);
  });

  it("pins the package-owned unit and audit to the qualified denylist", async () => {
    const unit = await systemdUserUnit();
    expect(() => validateSystemdUserUnit(unit)).not.toThrow();
    expect(unit).toContain("WorkingDirectory=%h\n");
    expect(unit).toContain(
      `UnsetEnvironment=${LINUX_SYSTEMD_UNSET_ENVIRONMENT.join(" ")}\n`,
    );
  });

  it("pins the clean shell working directory and rejects cwd authority", async () => {
    const unit = await systemdUserUnit();
    expect(() =>
      validateSystemdUserUnit(
        unit.replace("WorkingDirectory=%h", "WorkingDirectory=/tmp"),
      ),
    ).toThrow(/WorkingDirectory/u);
    expect(() =>
      validateSystemdUserUnit(
        unit.replace(
          "WorkingDirectory=%h",
          "WorkingDirectory=%h\nWorkingDirectory=%h",
        ),
      ),
    ).toThrow(/WorkingDirectory/u);
  });

  it("rejects an omitted, additional, reset, or duplicate denylist entry", async () => {
    const unit = await systemdUserUnit();
    const exact = LINUX_SYSTEMD_UNSET_ENVIRONMENT.join(" ");
    const withoutNodeOptions = exact
      .split(" ")
      .filter((name) => name !== "NODE_OPTIONS")
      .join(" ");
    expect(() =>
      validateSystemdUserUnit(
        unit.replace(
          `UnsetEnvironment=${exact}`,
          `UnsetEnvironment=${withoutNodeOptions}`,
        ),
      ),
    ).toThrow(/qualified denylist/u);
    expect(() =>
      validateSystemdUserUnit(
        unit.replace(
          `UnsetEnvironment=${exact}`,
          `UnsetEnvironment=${exact} EXTRA_AUTHORITY`,
        ),
      ),
    ).toThrow(/qualified denylist/u);
    expect(() =>
      validateSystemdUserUnit(
        unit.replace(
          `UnsetEnvironment=${exact}`,
          `UnsetEnvironment=\nUnsetEnvironment=${exact}`,
        ),
      ),
    ).toThrow(/qualified denylist/u);
    expect(() =>
      validateSystemdUserUnit(
        unit.replace(
          `UnsetEnvironment=${exact}`,
          `UnsetEnvironment=${exact}\nUnsetEnvironment=${exact}`,
        ),
      ),
    ).toThrow(/qualified denylist/u);
  });

  it.each([
    "EnvironmentFile=/tmp/attacker-controlled-environment",
    "PassEnvironment=NODE_OPTIONS",
    "Environment=NODE_OPTIONS=--require=/tmp/attacker.js",
    "Environment=EXTRA_AUTHORITY=1",
  ])(
    "rejects additional environment authority through %s",
    async (directive) => {
      const unit = await systemdUserUnit();
      expect(() =>
        validateSystemdUserUnit(
          unit.replace(
            "StandardOutput=null",
            `${directive}\nStandardOutput=null`,
          ),
        ),
      ).toThrow(/environment authority|Environment differs/u);
    },
  );
});
