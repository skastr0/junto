import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("orb resume", () => {
  let home: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "junto-orb-resume-"));
    const bin = join(home, ".local/bin");
    mkdirSync(bin, { recursive: true });
    // Explicit exits: on macOS bash 3.2 a failing [[ ]] does not trip set -e.
    const stub = `#!/usr/bin/env bash
set -euo pipefail
name="$(basename "$0")"
printf '%s %s\\n' "$name" "$*" >> "$HOME/calls"
case "$name" in
  sudo) exec "$@" ;;
  systemctl) [[ "$*" == 'enable --now tailscaled' ]] || exit 1 ;;
  amp)
    [[ "$*" == 'orb id-token --audience test-audience --subject-scope project' ]] || exit 1
    [[ "\${FAIL_AT:-}" != mint ]] || exit 1
    printf 'test-oidc-token'
    ;;
  tailscale)
    [[ "$(cat)" == test-oidc-token ]] || exit 1
    [[ "\${FAIL_AT:-}" != join ]] || exit 1
    ;;
  curl)
    [[ "\${FAIL_AT:-}" != health ]] || exit 1
    printf '{"ok":true}'
    ;;
esac
`;
    for (const name of ["sudo", "systemctl", "amp", "tailscale", "curl"]) {
      writeFileSync(join(bin, name), stub, { mode: 0o755 });
    }
    env = {
      HOME: home,
      PATH: "/usr/bin:/bin",
      AMP_DIRECT_DESKTOP: "1",
      TAILSCALE_CLIENT_ID: "test-client",
      TAILSCALE_AUDIENCE: "test-audience",
      QUASAR_SERVER_URL: "https://quasar.example/",
    };
    writeFileSync(join(home, "calls"), "");
  });

  afterEach(() => rmSync(home, { recursive: true, force: true }));

  function resume() {
    return spawnSync("/bin/bash", ["-x", resolve(".agents/resume")], {
      env,
      encoding: "utf8",
      timeout: 5000,
    });
  }

  it("resumes without any private service when no tailnet configuration is present", () => {
    delete env.TAILSCALE_CLIENT_ID;
    delete env.TAILSCALE_AUDIENCE;
    delete env.QUASAR_SERVER_URL;
    const result = resume();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Amp Desktop supported");
    expect(result.stdout).toContain("skipping Tailscale enrollment");
    expect(readFileSync(join(home, "calls"), "utf8")).toBe("");
  });

  it("mints on every resume without restarting or logging the token", () => {
    for (let i = 0; i < 2; i++) {
      const result = resume();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("Amp Desktop supported");
      expect(result.stdout + result.stderr).not.toContain("test-oidc-token");
    }
    const calls = readFileSync(join(home, "calls"), "utf8");
    expect(calls.match(/^amp /gm)).toHaveLength(2);
    expect(calls).not.toContain("restart");
    expect(calls).not.toContain("test-oidc-token");
    expect(calls).toContain("--client-id=test-client?ephemeral=true&preauthorized=true");
    expect(calls).toContain("--id-token=file:/dev/stdin --advertise-tags=tag:amp-orb");
    expect(calls).toContain("--proto =https --max-time 60 https://quasar.example/health");
  });

  it.each(["TAILSCALE_CLIENT_ID", "TAILSCALE_AUDIENCE", "QUASAR_SERVER_URL"])(
    "fails before authentication when only %s is missing",
    (name) => {
      delete env[name];
      expect(resume().status).not.toBe(0);
      expect(readFileSync(join(home, "calls"), "utf8")).toBe("");
    },
  );

  it("rejects plaintext health URLs before authentication", () => {
    env.QUASAR_SERVER_URL = "http://quasar.example";
    expect(resume().status).not.toBe(0);
    expect(readFileSync(join(home, "calls"), "utf8")).toBe("");
  });

  it.each(["mint", "join", "health"])("propagates %s failures", (stage) => {
    env.FAIL_AT = stage;
    const result = resume();
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("Quasar reachable");
    expect(result.stdout + result.stderr).not.toContain("test-oidc-token");
    if (stage !== "health") {
      expect(readFileSync(join(home, "calls"), "utf8")).not.toMatch(/^curl /m);
    }
  });
});
