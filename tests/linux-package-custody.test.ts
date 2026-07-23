import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const afterInstallPath = path.join(
  repositoryRoot,
  "build",
  "linux",
  "after-install.sh",
);
const afterRemovePath = path.join(
  repositoryRoot,
  "build",
  "linux",
  "after-remove.sh",
);

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

let fixtureRoot = "";
let harness = "";
let bridgeStageHarness = "";
let retirementHarness = "";

beforeAll(async () => {
  fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "vellum-custody-"));
  const source = await readFile(afterRemovePath, "utf8");
  const start = source.indexOf("remove_package_owned_root_file() {");
  const terminator = "\n}\n\n# Preserve journals";
  const end = source.indexOf(terminator, start);
  if (start < 0 || end < 0) {
    throw new Error("package custody function is missing");
  }
  let functionSource = source.slice(start, end + 2);
  if (!existsSync("/usr/bin/sha256sum")) {
    if (!existsSync("/sbin/sha256sum")) {
      throw new Error("sha256sum is unavailable for package custody test");
    }
    functionSource = functionSource.replaceAll(
      "/usr/bin/sha256sum",
      "/sbin/sha256sum",
    );
  }
  const fakeBin = path.join(fixtureRoot, "bin");
  await mkdir(fakeBin);
  const fakeStat = path.join(fakeBin, "stat");
  await writeFile(
    fakeStat,
    `#!/bin/sh
last=
for argument do last="$argument"; done
case "$last" in
  *.marker) printf '0:0:600:1\\n' ;;
  *stage-root) printf '0:0:1733\\n' ;;
  *) printf '0:0:%s:1\\n' "\${EXPECTED_MODE:?}" ;;
esac
`,
    { mode: 0o755 },
  );
  await chmod(fakeStat, 0o755);
  harness = path.join(fixtureRoot, "custody-harness.sh");
  await writeFile(
    harness,
    `#!/bin/sh
set -eu
set -f
${functionSource}
remove_package_owned_root_file "$1" "$2" "$3"
`,
    { mode: 0o755 },
  );
  await chmod(harness, 0o755);

  const bridgeStageStart = source.indexOf(
    "remove_package_owned_bridge_stage_root() {",
  );
  const bridgeStageTerminator = "\n}\n\nretire_legacy_sudoers_policy";
  const bridgeStageEnd = source.indexOf(
    bridgeStageTerminator,
    bridgeStageStart,
  );
  if (bridgeStageStart < 0 || bridgeStageEnd < 0) {
    throw new Error("package bridge stage-root custody function is missing");
  }
  const bridgeStageSource = source.slice(
    bridgeStageStart,
    bridgeStageEnd + 2,
  );
  bridgeStageHarness = path.join(
    fixtureRoot,
    "bridge-stage-custody-harness.sh",
  );
  await writeFile(
    bridgeStageHarness,
    `#!/bin/sh
set -eu
set -f
BRIDGE_STAGE_ROOT="$1"
BRIDGE_STAGE_MARKER="$2"
BRIDGE_STAGE_MARKER_VALUE="$3"
${bridgeStageSource}
remove_package_owned_bridge_stage_root
`,
    { mode: 0o755 },
  );
  await chmod(bridgeStageHarness, 0o755);

  const installSource = await readFile(afterInstallPath, "utf8");
  const retirementStart = installSource.indexOf(
    "retire_legacy_sudoers_policy() {",
  );
  const retirementTerminator = "\n}\n\nensure_root_directory";
  const retirementEnd = installSource.indexOf(
    retirementTerminator,
    retirementStart,
  );
  if (retirementStart < 0 || retirementEnd < 0) {
    throw new Error("legacy sudoers retirement function is missing");
  }
  const retirementSource = installSource.slice(
    retirementStart,
    retirementEnd + 2,
  );
  const sha256Binary = existsSync("/usr/bin/sha256sum")
    ? "/usr/bin/sha256sum"
    : "/sbin/sha256sum";
  retirementHarness = path.join(
    fixtureRoot,
    "legacy-sudoers-retirement-harness.sh",
  );
  await writeFile(
    retirementHarness,
    `#!/bin/sh
set -eu
set -f
sha256_file() {
  ${sha256Binary} "$1" | /usr/bin/awk '{ print $1 }'
}
${retirementSource}
retire_legacy_sudoers_policy "$1" "$2" "$3" "$4"
`,
    { mode: 0o755 },
  );
  await chmod(retirementHarness, 0o755);
});

afterAll(async () => {
  if (fixtureRoot !== "") {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

const runRemoval = (
  target: string,
  marker: string,
  mode: "440" | "755",
): void => {
  const result = spawnSync("/bin/sh", [harness, target, marker, mode], {
    encoding: "utf8",
    env: {
      ...process.env,
      EXPECTED_MODE: mode,
      PATH: `${path.join(fixtureRoot, "bin")}:/usr/bin:/bin:/sbin`,
    },
  });
  expect(result.status, result.stderr).toBe(0);
};

const runLegacyRetirement = (
  target: string,
  marker: string,
  expectedSha: string,
  action: "fail" | "preserve",
) =>
  spawnSync(
    "/bin/sh",
    [retirementHarness, target, marker, expectedSha, action],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        EXPECTED_MODE: "440",
        PATH: `${path.join(fixtureRoot, "bin")}:/usr/bin:/bin:/sbin`,
      },
    },
  );

const runBridgeStageRemoval = (
  root: string,
  marker: string,
  markerValue: string,
) =>
  spawnSync(
    "/bin/sh",
    [bridgeStageHarness, root, marker, markerValue],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        EXPECTED_MODE: "755",
        PATH: `${path.join(fixtureRoot, "bin")}:/usr/bin:/bin:/sbin`,
      },
    },
  );

const crashFixture = async (
  name: string,
  input: {
    readonly target?: string;
    readonly marker: string;
  },
): Promise<{ readonly target: string; readonly marker: string }> => {
  const directory = path.join(fixtureRoot, name);
  await mkdir(directory);
  const target = path.join(directory, "authority");
  const marker = path.join(directory, "custody.marker");
  if (input.target !== undefined) {
    await writeFile(target, input.target, { mode: 0o755 });
  }
  await writeFile(marker, `${input.marker}\n`, { mode: 0o600 });
  return { target, marker };
};

const exists = async (file: string): Promise<boolean> =>
  lstat(file).then(() => true, () => false);

describe("Linux package root-authority custody", () => {
  it("publishes root commands through same-directory atomic rename", async () => {
    const source = await readFile(afterInstallPath, "utf8");
    expect(source).toContain(
      'mktemp "$target_directory/.vellum-package.XXXXXXXX"',
    );
    expect(source).not.toContain(
      'mktemp "$INSTALLER_STATE/.package-file.XXXXXXXX"',
    );
    expect(source).toContain('/bin/sync -f "$target_directory"');
  });

  it.each(["old", "new"] as const)(
    "removes a package target at the %s side of a two-digest crash cut",
    async (side) => {
      const oldBody = "old package authority";
      const newBody = "new package authority";
      const fixture = await crashFixture(`transition-${side}`, {
        target: side === "old" ? oldBody : newBody,
        marker: `${sha256(oldBody)} ${sha256(newBody)}`,
      });
      runRemoval(fixture.target, fixture.marker, "755");
      expect(await exists(fixture.target)).toBe(false);
      expect(await exists(fixture.marker)).toBe(false);
    },
  );

  it("retires a pre-publication marker whose old state was absence", async () => {
    const fixture = await crashFixture("absent-transition", {
      marker: `none ${sha256("new package authority")}`,
    });
    runRemoval(fixture.target, fixture.marker, "755");
    expect(await exists(fixture.target)).toBe(false);
    expect(await exists(fixture.marker)).toBe(false);
  });

  it("removes a newly published target whose transition began absent", async () => {
    const body = "new package authority";
    const fixture = await crashFixture("new-from-absent", {
      target: body,
      marker: `none ${sha256(body)}`,
    });
    runRemoval(fixture.target, fixture.marker, "755");
    expect(await exists(fixture.target)).toBe(false);
    expect(await exists(fixture.marker)).toBe(false);
  });

  it("preserves modified authority and malformed transition evidence", async () => {
    const modified = await crashFixture("modified", {
      target: "locally modified",
      marker: `${sha256("old")} ${sha256("new")}`,
    });
    runRemoval(modified.target, modified.marker, "755");
    expect(await exists(modified.target)).toBe(true);
    expect(await exists(modified.marker)).toBe(true);

    const malformed = await crashFixture("malformed", {
      target: "new",
      marker: `${sha256("old")}  ${sha256("new")}`,
    });
    runRemoval(malformed.target, malformed.marker, "755");
    expect(await exists(malformed.target)).toBe(true);
    expect(await exists(malformed.marker)).toBe(true);
  });

  it("retires only the exact legacy sudoers policy and its admitted marker", async () => {
    const body = "exact historical passwordless policy";
    const fixture = await crashFixture("legacy-sudoers", {
      target: body,
      marker: `${sha256("prior")} ${sha256(body)}`,
    });
    const result = runLegacyRetirement(
      fixture.target,
      fixture.marker,
      sha256(body),
      "fail",
    );
    expect(result.status, result.stderr).toBe(0);
    expect(await exists(fixture.target)).toBe(false);
    expect(await exists(fixture.marker)).toBe(false);
  });

  it("fails closed without deleting a modified or foreign sudoers policy", async () => {
    const fixture = await crashFixture("foreign-sudoers", {
      target: "administrator policy",
      marker: sha256("historical policy"),
    });
    const result = runLegacyRetirement(
      fixture.target,
      fixture.marker,
      sha256("historical policy"),
      "fail",
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("preserving modified or foreign");
    expect(await exists(fixture.target)).toBe(true);
    expect(await exists(fixture.marker)).toBe(true);
  });

  it("preserves unknown custody evidence after removing exact legacy policy", async () => {
    const body = "exact historical passwordless policy";
    const fixture = await crashFixture("foreign-sudoers-marker", {
      target: body,
      marker: sha256("unrelated policy"),
    });
    const result = runLegacyRetirement(
      fixture.target,
      fixture.marker,
      sha256(body),
      "preserve",
    );
    expect(result.status, result.stderr).toBe(0);
    expect(await exists(fixture.target)).toBe(false);
    expect(await exists(fixture.marker)).toBe(true);
  });

  it("removes only an empty package-owned bridge stage root", async () => {
    const directory = path.join(fixtureRoot, "empty-stage");
    const root = path.join(directory, "stage-root");
    const marker = path.join(directory, "stage.marker");
    const markerValue = "vellum/linux-release-bridge-stage-root/v1";
    await mkdir(root, { recursive: true, mode: 0o700 });
    await chmod(root, 0o1733);
    await writeFile(marker, `${markerValue}\n`, { mode: 0o600 });

    const result = runBridgeStageRemoval(root, marker, markerValue);

    expect(result.status, result.stderr).toBe(0);
    expect(await exists(root)).toBe(false);
    expect(await exists(marker)).toBe(false);
  });

  it("preserves nonempty or unclaimed bridge stage roots", async () => {
    const directory = path.join(fixtureRoot, "retained-stage");
    const nonemptyRoot = path.join(directory, "stage-root");
    const nonemptyMarker = path.join(directory, "nonempty.marker");
    const markerValue = "vellum/linux-release-bridge-stage-root/v1";
    await mkdir(nonemptyRoot, { recursive: true, mode: 0o700 });
    await chmod(nonemptyRoot, 0o1733);
    await writeFile(path.join(nonemptyRoot, "foreign"), "preserve");
    await writeFile(nonemptyMarker, `${markerValue}\n`, { mode: 0o600 });

    const nonempty = runBridgeStageRemoval(
      nonemptyRoot,
      nonemptyMarker,
      markerValue,
    );
    expect(nonempty.status, nonempty.stderr).toBe(0);
    expect(nonempty.stderr).toContain("preserving a nonempty");
    expect(await exists(nonemptyRoot)).toBe(true);
    expect(await exists(nonemptyMarker)).toBe(true);

    const unclaimedRoot = path.join(directory, "unclaimed-stage-root");
    const missingMarker = path.join(directory, "missing.marker");
    await mkdir(unclaimedRoot, { mode: 0o700 });
    await chmod(unclaimedRoot, 0o1733);
    const unclaimed = runBridgeStageRemoval(
      unclaimedRoot,
      missingMarker,
      markerValue,
    );
    expect(unclaimed.status, unclaimed.stderr).toBe(0);
    expect(await exists(unclaimedRoot)).toBe(true);
    expect(await exists(missingMarker)).toBe(false);
  });

  it("preserves a bridge stage root with foreign custody evidence", async () => {
    const directory = path.join(fixtureRoot, "foreign-stage");
    const root = path.join(directory, "stage-root");
    const marker = path.join(directory, "foreign.marker");
    const markerValue = "vellum/linux-release-bridge-stage-root/v1";
    await mkdir(root, { recursive: true, mode: 0o700 });
    await chmod(root, 0o1733);
    await writeFile(marker, "administrator-owned\n", { mode: 0o600 });

    const result = runBridgeStageRemoval(root, marker, markerValue);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("preserving a foreign");
    expect(await exists(root)).toBe(true);
    expect(await exists(marker)).toBe(true);
  });
});
