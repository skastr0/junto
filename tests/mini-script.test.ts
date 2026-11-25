import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// scripts/mini.sh against a fake ssh and scp: nothing here reaches the mini.
// The fake records every call's arguments and what it read on stdin.

const SIGNAL = "01M894EWCZCHFNCHT4G8BA85DG";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mini-script-test-"));
  const fake = join(dir, "ssh");
  writeFileSync(
    fake,
    `#!/bin/sh
echo "$*" >> "${dir}/calls"
cat >> "${dir}/stdin"
exit 0
`,
  );
  chmodSync(fake, 0o755);
  writeFileSync(join(dir, "scp"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(dir, "scp"), 0o755);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function mini(args: string[], env: Record<string, string> = {}) {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && k !== "MINI_GPU" && k !== "MINI_APPROVED" && k !== "VM_SEAT") clean[k] = v;
  }
  const r = spawnSync("bash", ["scripts/mini.sh", ...args], {
    cwd: process.cwd(),
    env: { ...clean, PATH: `${dir}:${process.env.PATH ?? ""}`, MINI: "fake-mini", ...env },
    input: "",
    encoding: "utf8",
  });
  const read = (name: string) => {
    try {
      return readFileSync(join(dir, name), "utf8");
    } catch {
      return "";
    }
  };
  return { status: r.status, stderr: r.stderr, calls: read("calls").split("\n").filter(Boolean), stdin: read("stdin") };
}

describe("scripts/mini.sh gate", () => {
  it("refuses a run that is neither GPU nor approved, and names both ways in", () => {
    const r = mini(["run", "/some/folder", "bun test"]);
    expect(r.status).toBe(2);
    expect(r.calls).toEqual([]);
    expect(r.stderr).toContain("--gpu");
    expect(r.stderr).toContain("MINI_GPU=1");
    expect(r.stderr).toContain("MINI_APPROVED=<signal id>");
    expect(r.stderr).toContain("approved this run by name in a signal");
  });

  it("passes a run set to a signal id, logging one line on the mini before the run", () => {
    const r = mini(["run", "/some/folder", "bun test"], { MINI_APPROVED: SIGNAL, VM_SEAT: "tech-ci" });
    expect(r.status).toBe(0);
    expect(r.calls).toHaveLength(2);
    expect(r.calls[0]).toContain("cat >> ~/junto-perf/book.log");
    expect(r.calls[1]).toContain("cd /some/folder && bun test");
    expect(r.stdin.trimEnd().split("\n")).toHaveLength(1);
    expect(r.stdin).toMatch(
      new RegExp(`^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z approved tech-ci ${SIGNAL} run /some/folder bun test\\n$`, "u"),
    );
  });

  it("passes at and put too, one logged line each", () => {
    const at = mini(["at", "tech-ci"], { MINI_APPROVED: SIGNAL, VM_SEAT: "tech-ci" });
    expect(at.status).toBe(0);
    expect(at.calls[0]).toContain("cat >> ~/junto-perf/book.log");
    expect(at.stdin).toContain(`approved tech-ci ${SIGNAL} at tech-ci\n`);
    const put = mini(["put", "/some/folder", "package.json"], { MINI_APPROVED: SIGNAL, VM_SEAT: "tech-ci" });
    expect(put.status).toBe(0);
    expect(put.calls[0]).toContain("cat >> ~/junto-perf/book.log");
    expect(put.stdin).toContain(`approved tech-ci ${SIGNAL} put /some/folder package.json\n`);
  });

  it("marks a missing VM_SEAT as unset and flattens a newline in the command", () => {
    const r = mini(["run", "/f", "a\nb"], { MINI_APPROVED: SIGNAL });
    expect(r.status).toBe(0);
    expect(r.stdin).toMatch(new RegExp(` approved unset ${SIGNAL} run /f a b\\n$`, "u"));
  });

  it.each([
    ["too short", "01M894EWCZCHFNCHT4G8BA85D"],
    ["too long", `${SIGNAL}X`],
    ["lowercase", SIGNAL.toLowerCase()],
    ["not a ULID letter", `01M894EWCZCHFNCHT4G8BA85D${"U"}`],
    ["wrong prefix", `02${SIGNAL.slice(2)}`],
    ["a word", "approved"],
  ])("refuses a malformed id (%s) and runs nothing", (_name, id) => {
    const r = mini(["run", "/some/folder", "bun test"], { MINI_APPROVED: id });
    expect(r.status).toBe(2);
    expect(r.calls).toEqual([]);
    expect(r.stderr).toContain("is not a signal id");
  });

  it("refuses a malformed id even on a GPU call", () => {
    const r = mini(["--gpu", "run", "/f", "x"], { MINI_APPROVED: "nope" });
    expect(r.status).toBe(2);
    expect(r.calls).toEqual([]);
  });

  it("lets a GPU call through without a signal and logs nothing", () => {
    const flag = mini(["--gpu", "run", "/f", "x"]);
    expect(flag.status).toBe(0);
    expect(flag.stdin).toBe("");
    expect(flag.calls).toHaveLength(1);
    const env = mini(["run", "/f", "x"], { MINI_GPU: "1" });
    expect(env.status).toBe(0);
    expect(env.stdin).toBe("");
  });

  it("does not log a GPU call that also carries a signal", () => {
    const r = mini(["--gpu", "run", "/f", "x"], { MINI_APPROVED: SIGNAL });
    expect(r.status).toBe(0);
    expect(r.stdin).toBe("");
    expect(r.calls).toHaveLength(1);
  });

  it("needs no mark for book and rm", () => {
    const book = mini(["book", "status"]);
    expect(book.status).toBe(0);
    expect(book.stdin).toBe("");
    const rm = mini(["rm", "/f"]);
    expect(rm.status).toBe(0);
    expect(rm.stdin).toBe("");
  });
});
