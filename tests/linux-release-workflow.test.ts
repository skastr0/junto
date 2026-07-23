import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { LINUX_CI_REQUIRED_GATES } from "../scripts/linux-ci-evidence";

const workflow = await readFile(
  new URL("../.github/workflows/linux-release.yml", import.meta.url),
  "utf8",
);

describe("authoritative Linux release workflow", () => {
  it("pins the exact native Ubuntu x64 clean-room toolchain", () => {
    expect(workflow).toContain("runs-on: ubuntu-24.04");
    expect(workflow).not.toContain("ubuntu-latest");
    expect(workflow).toContain("BUN_VERSION: 1.3.13");
    expect(workflow).toContain("NODE_VERSION: 22.23.1");
    expect(workflow).toContain("--frozen-lockfile");
    expect(workflow).toContain("--no-cache");
    expect(workflow).toContain("--force");
    expect(workflow).toContain("--backend=copyfile");
    expect(workflow).toContain("--cache-dir \"$BUN_INSTALL_CACHE_DIR\"");
    expect(workflow).not.toContain("actions/cache");
    expect(workflow).not.toMatch(/\n\s+cache:/u);
    expect(workflow).toContain(
      "printf 'CLEAN_HOME=%s\\n' \"$clean_home\" >> \"$GITHUB_ENV\"",
    );
    expect(workflow).toContain("SOURCE_DATE_EPOCH=");
    expect(workflow).not.toMatch(/\.\.\/(?:prism|tower|quasar|booth)/u);
  });

  it("pins every third-party action to a full commit", () => {
    const uses = [...workflow.matchAll(/^\s+uses:\s+([^#\s]+)(?:\s+#.*)?$/gmu)]
      .map((match) => match[1]);
    expect(uses.length).toBeGreaterThan(0);
    expect(uses.every((value) => /@[0-9a-f]{40}$/u.test(value))).toBe(true);
    expect(workflow).toContain(
      "actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683",
    );
    expect(workflow).toContain(
      "oven-sh/setup-bun@735343b667d3e6f658f44d0eca948eb6282f2b76",
    );
    expect(workflow).toContain(
      "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
    );
    expect(workflow).toContain(
      "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
    );
  });

  it("runs every compile, native, package, audit, install, and smoke gate", () => {
    for (const command of [
      "bun run typecheck",
      "bun run test",
      "scripts/build-app.sh --target linux --compile-only",
      "scripts/package-app-linux.sh --verify",
      "scripts/audit-linux-package.ts",
      "apt-get install -y \"$LINUX_DEB\"",
      "scripts/linux-packaged-pty-smoke.ts",
      "scripts/linux-ci-packaged-smoke.ts",
      "xvfb-run -a",
    ]) {
      expect(workflow).toContain(command);
    }
    for (const gate of LINUX_CI_REQUIRED_GATES) {
      expect(workflow).toContain(`--gate ${gate}`);
    }
    expect(workflow).not.toContain("continue-on-error");
  });

  it("uploads only target-specific deb, diagnostic, manifest, hashes, receipts, and safe logs", () => {
    expect(workflow).toContain(
      "name: vellum-ubuntu-24.04-x64-${{ github.sha }}",
    );
    expect(workflow).toContain("release/*-x64-linux.deb");
    expect(workflow).toContain("ci-evidence/ubuntu-24.04-x64/**");
    expect(workflow).toContain("manifest.json");
    expect(workflow).toContain("SHA256SUMS");
    expect(workflow).toContain("package-audit.json");
    expect(workflow).toContain("packaged-pty-smoke.json");
    expect(workflow).toContain("packaged-runtime-smoke.json");
    expect(workflow).toContain("test-receipt.json");
    expect(workflow).toContain("sanitize-log");
    expect(workflow).not.toMatch(
      /(?:arm64|aarch64|musl|appimage|flatpak|\.rpm|\.snap)/iu,
    );
    expect(workflow).not.toContain("name: vellum-linux-");
  });

  it("keeps macOS independent and makes promotion depend on both platforms", () => {
    expect(workflow).toContain("macos-verification:");
    expect(workflow).toContain("runs-on: macos-14");
    expect(workflow).toContain("linux-package-qualification:");
    expect(workflow).toContain("release-promotion-gate:");
    expect(workflow).toContain("- macos-verification");
    expect(workflow).toContain("- linux-package-qualification");
    expect(workflow).toContain(
      "needs.macos-verification.result == 'success'",
    );
    expect(workflow).toContain(
      "needs.linux-package-qualification.result == 'success'",
    );
    expect(workflow).toContain("github.event_name != 'pull_request'");
    expect(workflow).not.toMatch(
      /(?:softprops\/action-gh-release|gh\s+release\s+(?:create|upload))/u,
    );
  });
});
