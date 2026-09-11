import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const readProfile = (): Promise<string> =>
  readFile(
    new URL("../scripts/linux-command-center.apparmor", import.meta.url),
    "utf8",
  );

const readDoc = (): Promise<string> =>
  readFile(
    new URL("../docs/linux-command-center-alpha.md", import.meta.url),
    "utf8",
  );

const shellBlocks = (input: string): string =>
  [...input.matchAll(/```sh\n([\s\S]*?)```/gu)]
    .map((match) => match[1])
    .join("\n");

const collapsed = (input: string): string => input.replace(/\s+/gu, " ");

const expectedProfile = `abi <abi/4.0>,
include <tunables/global>

profile vellum-command @{HOME}/.local/opt/vellum-command-alpha/*/vellum-command flags=(unconfined) {
  userns,
}
`;

describe("Linux Command Center Alpha AppArmor boundary", () => {
  it("keeps the reviewed profile exact and grants only user namespaces", async () => {
    const profile = await readProfile();

    expect(profile).toBe(expectedProfile);
    expect(profile).toContain("abi <abi/4.0>,");
    expect(profile).toContain("include <tunables/global>");
    expect(profile).toContain(
      "profile vellum-command @{HOME}/.local/opt/vellum-command-alpha/*/vellum-command flags=(unconfined) {",
    );

    const body = profile.match(/flags=\(unconfined\) \{\n([\s\S]*?)\n\}/u)?.[1];
    expect(body?.trim()).toBe("userns,");
    expect(profile.match(/^\s*userns,\s*$/gmu)).toHaveLength(1);
    expect(profile).not.toMatch(/include\s+if\s+exists|<local\//u);
  });

  it("states the external rootless Alpha and package-exclusion contract", async () => {
    const [doc, packageSource] = await Promise.all([
      readDoc(),
      readFile(new URL("../package.json", import.meta.url), "utf8"),
    ]);
    const text = collapsed(doc);
    const packageJson = JSON.parse(packageSource) as {
      build?: {
        files?: unknown;
        extraResources?: unknown;
        linux?: { files?: unknown; extraResources?: unknown };
      };
    };
    const packagedInputs = JSON.stringify({
      files: packageJson.build?.files,
      extraResources: packageJson.build?.extraResources,
      linuxFiles: packageJson.build?.linux?.files,
      linuxExtraResources: packageJson.build?.linux?.extraResources,
    });

    expect(text).toContain(
      "Linux desktop alpha targets Ubuntu 24.04 LTS x86-64 with glibc 2.39",
    );
    expect(text).toContain(
      "Fleet management and its headless Remote package remain experimental, unreleased and feature-gated",
    );
    expect(text).toContain(
      "Desktop qualification does not promote Fleet to Beta or either surface to production",
    );
    expect(text).toContain(
      "Ubuntu 24.04 restricts unprivileged user namespaces through AppArmor",
    );
    expect(text).toContain("This file is external host preparation only");
    expect(text).toContain(
      "intentionally excluded from the Vellum Command package, signed rootless payload, installer, updater, and runtime resources",
    );
    expect(text).toContain("Vellum Command never invokes `sudo`");
    expect(text).toContain(
      "An operator or host administrator separately reviews and installs the exact checked-in file",
    );
    expect(text).toContain("the application package remains rootless");
    expect(packagedInputs).not.toMatch(/linux-command-center\.apparmor|apparmor/iu);
    expect(packagedInputs).not.toContain("vellum-command-desktop-bootstrap-linux-x64");
  });

  it("documents separate Xorg and native Wayland tests without weakening", async () => {
    const doc = await readDoc();
    const commands = shellBlocks(doc);

    expect(doc).toContain("## Xorg launch and test");
    expect(doc).toContain("## Native Wayland launch and test");
    expect(commands).not.toMatch(/^\s*tar\s+-xzf\b/mu);
    expect(commands).not.toContain("desktop-install");
    expect(commands).not.toContain("resources/bin/vellum-command");
    expect(commands).toContain("gh attestation verify");
    expect(commands).toContain("vellum-command-desktop-bootstrap-linux-x64");
    expect(commands).toContain("--ozone-platform=x11");
    expect(commands).toContain("--ozone-platform=wayland");
    expect(commands).toContain('cat "/proc/$ALPHA_PID/attr/current"');
    expect(doc).toContain("`vellum-command (unconfined)`");

    expect(commands).not.toMatch(
      /--(?:no-sandbox|disable-setuid-sandbox)|\bsysctl\b|unprivileged_userns_clone|apparmor_restrict_unprivileged_userns|\baa-disable\b|systemctl[^\n]*(?:disable|stop)[^\n]*apparmor|apparmor=0/iu,
    );
    expect(commands).not.toMatch(
      /(?:chmod|install)\s+[^\n]*(?:[ug]\+s|[24][0-7]{3})|chrome-sandbox/iu,
    );
    expect(commands).not.toMatch(
      /sudo[^\n]*(?:\.local\/opt\/vellum-command-alpha|\$ALPHA_EXECUTABLE)/u,
    );
    expect(doc).toMatch(
      /Never add `--no-sandbox`[^.]+global\s+user-namespace sysctl[^.]+setuid Chromium sandbox/iu,
    );
  });
});
