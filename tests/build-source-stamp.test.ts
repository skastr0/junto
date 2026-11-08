/**
 * out/build-source.json records the commit and the feature profile the build
 * was made with, so an e2e spec reads which build it runs against: all-on when
 * JUNTO_FEATURE_PROFILE says so, ship when it is unset.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BUILD_SOURCE_STAMP, writeBuildSourceStamp } from "../scripts/build-source-stamp";

let root: string;
let saved: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "junto-build-stamp-"));
  const git = (...args: ReadonlyArray<string>): string =>
    execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { encoding: "utf8" });
  git("init", "-q");
  git("commit", "-q", "--allow-empty", "-m", "stamp fixture");
  saved = process.env.JUNTO_FEATURE_PROFILE;
});

afterEach(() => {
  if (saved === undefined) delete process.env.JUNTO_FEATURE_PROFILE;
  else process.env.JUNTO_FEATURE_PROFILE = saved;
  rmSync(root, { recursive: true, force: true });
});

const stampWritten = (): { sourceCommit: string; featureProfile: string } => {
  const plugin = writeBuildSourceStamp(root);
  (plugin.writeBundle as () => void).call({});
  return JSON.parse(readFileSync(join(root, BUILD_SOURCE_STAMP), "utf8"));
};

describe("the build source stamp", () => {
  it("says all-on when the build was made all-on", () => {
    process.env.JUNTO_FEATURE_PROFILE = "all-on";
    expect(stampWritten().featureProfile).toBe("all-on");
  });

  it("says ship when the profile is unset or ship, and names the commit", () => {
    delete process.env.JUNTO_FEATURE_PROFILE;
    const stamp = stampWritten();
    expect(stamp.featureProfile).toBe("ship");
    expect(stamp.sourceCommit).toMatch(/^[0-9a-f]{40}$/u);
    process.env.JUNTO_FEATURE_PROFILE = "ship";
    expect(stampWritten().featureProfile).toBe("ship");
  });
});
