import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveCandidateRuntimeRootFromRemoteBinary,
  resolveReleaseDirectoryFromRemoteBinary,
} from "../src/main/junto/supervision/install-user-service";
import { renderUserlandLinuxService } from "../src/main/junto/supervision/systemd-user";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

const makeGenerationTree = (home: string, generation: string): string => {
  const release = join(home, ".junto", "runtime", "releases", generation);
  const bin = join(release, "resources", "bin");
  mkdirSync(bin, { recursive: true, mode: 0o700 });
  const remote = join(bin, "junto-remote");
  writeFileSync(remote, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  chmodSync(remote, 0o755);
  return remote;
};

describe("install-user-service path resolution", () => {
  it("admits only canonical releases/ generations for install", () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "vellum-install-svc-")));
    roots.push(home);
    const generation = `1.2.3-${"a".repeat(64)}`;
    const remote = makeGenerationTree(home, generation);
    const release = resolveReleaseDirectoryFromRemoteBinary(remote);
    expect(release).toBe(join(home, ".junto", "runtime", "releases", generation));
    expect(() =>
      renderUserlandLinuxService({ releaseDirectory: release }),
    ).not.toThrow();
  });

  it("admits staging extract roots for candidate preflight only", () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "vellum-install-stage-")));
    roots.push(home);
    const stage = join(
      home,
      ".junto",
      "runtime",
      "staging",
      `1.2.3-${"b".repeat(64)}-12345`,
      "junto-runtime-1.2.3-linux-x64",
    );
    const bin = join(stage, "resources", "bin");
    mkdirSync(bin, { recursive: true, mode: 0o700 });
    const remote = join(bin, "junto-remote");
    writeFileSync(remote, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    chmodSync(remote, 0o755);

    expect(resolveCandidateRuntimeRootFromRemoteBinary(remote)).toBe(stage);
    expect(() => resolveReleaseDirectoryFromRemoteBinary(remote)).toThrow(
      /canonical immutable|userland runtime layout/u,
    );

    const entryDir = join(stage, "resources", "app-remote");
    mkdirSync(entryDir, { recursive: true, mode: 0o700 });
    const entry = join(entryDir, "junto-remote.js");
    writeFileSync(entry, "export {};\n", { mode: 0o644 });
    expect(resolveCandidateRuntimeRootFromRemoteBinary(entry)).toBe(stage);
  });

  it("rejects free-form paths outside userland runtime", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "vellum-install-reject-")));
    roots.push(root);
    const bin = join(root, "resources", "bin");
    mkdirSync(bin, { recursive: true });
    const remote = join(bin, "junto-remote");
    writeFileSync(remote, "#!/bin/sh\n", { mode: 0o755 });
    chmodSync(remote, 0o755);
    expect(() => resolveReleaseDirectoryFromRemoteBinary(remote)).toThrow();
    expect(() => resolveCandidateRuntimeRootFromRemoteBinary(remote)).toThrow();
  });
});
