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
});
