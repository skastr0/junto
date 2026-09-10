import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("public orb resume", () => {
  it.each([false, true])(
    "resumes without private services when optional private configuration is present: %s",
    (withPrivateConfiguration) => {
      const home = mkdtempSync(join(tmpdir(), "vellum-orb-resume-"));
      const bin = join(home, ".local/bin");
      mkdirSync(bin, { recursive: true });
      for (const command of ["sudo", "systemctl", "amp", "tailscale", "curl", "quasar"]) {
        writeFileSync(
          join(bin, command),
          "#!/bin/sh\necho 'unexpected private service invocation' >&2\nexit 83\n",
          { mode: 0o755 },
        );
      }
      try {
        const result = spawnSync("/bin/bash", ["-x", resolve(".agents/resume")], {
          env: {
            HOME: home,
            PATH: `${bin}:/usr/bin:/bin`,
            AMP_DIRECT_DESKTOP: "1",
            ...(withPrivateConfiguration ? {
              TAILSCALE_CLIENT_ID: "private-client-fixture",
              TAILSCALE_AUDIENCE: "private-audience-fixture",
              QUASAR_SERVER_URL: "https://private-service.example.test",
            } : {}),
          },
          encoding: "utf8",
          timeout: 5_000,
        });
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain("Amp Desktop supported");
        expect(result.stdout).toContain("No runtime services or authentication need reconnecting");
        expect(result.stdout + result.stderr).not.toContain("unexpected private service");
        expect(result.stdout + result.stderr).not.toContain("private-client-fixture");
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
  );
});
