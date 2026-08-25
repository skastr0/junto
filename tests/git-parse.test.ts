import { describe, expect, it } from "vitest";
import {
  isGitSha,
  parseGitLog,
  parsePorcelainV2Branch,
  parseShortstat,
} from "../src/shared/git";

describe("git parsers", () => {
  it("accepts abbreviated and full shas, rejects paths", () => {
    expect(isGitSha("abc1234")).toBe(true);
    expect(isGitSha("0123456789abcdef0123456789abcdef01234567")).toBe(true);
    expect(isGitSha("../etc/passwd")).toBe(false);
    expect(isGitSha("-HEAD")).toBe(false);
    expect(isGitSha("HEAD")).toBe(false);
  });

  it("parses shortstat lines", () => {
    expect(parseShortstat(" 2 files changed, 40 insertions(+), 5 deletions(-)")).toEqual({
      files: 2,
      additions: 40,
      deletions: 5,
    });
    expect(parseShortstat(" 1 file changed, 1 insertion(+)")).toEqual({
      files: 1,
      additions: 1,
      deletions: 0,
    });
    expect(parseShortstat(" 1 file changed, 3 deletions(-)")).toEqual({
      files: 1,
      additions: 0,
      deletions: 3,
    });
  });

  it("parses porcelain v2 branch header", () => {
    const parsed = parsePorcelainV2Branch(
      [
        "# branch.oid 0123456789abcdef0123456789abcdef01234567",
        "# branch.head main",
        "# branch.upstream origin/main",
        "# branch.ab +3 -1",
        "1 .M N... 100644 100644 100644 abc def file.ts",
      ].join("\n"),
    );
    expect(parsed).toEqual({
      oid: "0123456789abcdef0123456789abcdef01234567",
      head: "main",
      detached: false,
      upstream: "origin/main",
      ahead: 3,
      behind: 1,
    });
  });

  it("marks detached HEAD", () => {
    const parsed = parsePorcelainV2Branch(
      ["# branch.oid abc", "# branch.head (detached)"].join("\n"),
    );
    expect(parsed.detached).toBe(true);
    expect(parsed.head).toBe("HEAD");
  });

  it("parses git log records with shortstat", () => {
    const rebuilt = [
      `\x1e0123456789abcdef0123456789abcdef01234567\x00fix glance\x00Ada\x002026-08-01T12:00:00+00:00`,
      ``,
      ` 2 files changed, 40 insertions(+), 5 deletions(-)`,
      `\x1efedcba9876543210fedcba9876543210fedcba98\x00empty merge\x00Bob\x002026-08-02T12:00:00+00:00`,
      ``,
    ].join("\n");
    const commits = parseGitLog(rebuilt);
    expect(commits).toHaveLength(2);
    expect(commits[0]).toMatchObject({
      sha: "0123456789abcdef0123456789abcdef01234567",
      subject: "fix glance",
      author: "Ada",
      stats: { files: 2, additions: 40, deletions: 5 },
    });
    expect(commits[1]?.stats).toBeUndefined();
  });
});
