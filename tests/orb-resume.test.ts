import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Hermetic: the resume hook runs from a scratch checkout, and the shared orb
// runtime it delegates to is a stub sibling. The runtime's own tailnet
// behavior belongs to orb-setup and is not exercised here.
describe("orb resume", () => {
  let root: string;
  let script: string;
  let calls: string;
  let env: NodeJS.ProcessEnv;

  const installRuntime = (relative: string, exitCode = 0): void => {
    const bin = join(root, relative, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(bin, "resume.sh"),
      `#!/usr/bin/env bash
printf 'resume.sh %s\\n' "$(basename "$(cd "$(dirname "$0")/.." && pwd)")" >> "${calls}"
printf '[orb-setup] stub resumed\\n'
exit ${exitCode}
`,
      { mode: 0o755 },
    );
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "junto-orb-resume-"));
    const agents = join(root, "junto", ".agents");
    mkdirSync(agents, { recursive: true });
    script = join(agents, "resume");
    copyFileSync(resolve(".agents/resume"), script);
    calls = join(root, "calls");
    writeFileSync(calls, "");
    env = {
      HOME: join(root, "home"),
      PATH: "/usr/bin:/bin",
      AMP_DIRECT_DESKTOP: "1",
      TAILSCALE_CLIENT_ID: "test-client",
      TAILSCALE_AUDIENCE: "test-audience",
      QUASAR_SERVER_URL: "https://quasar.example/",
    };
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const resume = () =>
    spawnSync("/bin/bash", ["-x", script], {
      env,
      encoding: "utf8",
      timeout: 5000,
    });

  it("resumes without any private runtime when no tailnet configuration is present", () => {
    delete env.TAILSCALE_CLIENT_ID;
    delete env.TAILSCALE_AUDIENCE;
    delete env.QUASAR_SERVER_URL;
    installRuntime("orb-setup");
    const result = resume();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Amp Desktop supported");
    expect(result.stdout).toContain("skipping Tailscale enrollment");
    expect(readFileSync(calls, "utf8")).toBe("");
  });

  it.each(["repos/orb-setup", "repos/skastr0/orb-setup", "orb-setup"])(
    "delegates to the shared runtime at ../%s",
    (relative) => {
      installRuntime(relative);
      const result = resume();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("Amp Desktop supported");
      expect(result.stdout).toContain("[orb-setup] stub resumed");
      expect(readFileSync(calls, "utf8")).toBe("resume.sh orb-setup\n");
    },
  );

  it("prefers the first candidate when several checkouts exist", () => {
    installRuntime("orb-setup");
    installRuntime("repos/orb-setup");
    expect(resume().status).toBe(0);
    expect(readFileSync(calls, "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("treats partial tailnet configuration as a join request", () => {
    delete env.TAILSCALE_AUDIENCE;
    delete env.QUASAR_SERVER_URL;
    installRuntime("orb-setup");
    expect(resume().status).toBe(0);
    expect(readFileSync(calls, "utf8")).toBe("resume.sh orb-setup\n");
  });

  it("fails clearly when tailnet configuration is present but the runtime is missing", () => {
    const result = resume();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("orb-setup checkout not found");
  });

  it("propagates a runtime failure", () => {
    installRuntime("orb-setup", 7);
    expect(resume().status).toBe(7);
  });

  it("never traces itself even under bash -x", () => {
    installRuntime("orb-setup");
    const result = resume();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("+ set +x\n");
  });
});
