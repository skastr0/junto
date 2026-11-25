/**
 * The release gate's judge, on fixtures: every fault the zoom ladder's gate
 * must refuse, and the one shape it must accept. The rig itself cannot run
 * here (it needs the Mac mini's GPU), so this is what is checkable on a VM: the
 * decision, not the pixels.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ARM_SCALE, receiptBullet, judgeArms, proofRecords } from "../scripts/release-zoom-ladder";

const roots: string[] = [];

const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "zoom-ladder-judge-"));
  roots.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** One arm's artifacts as the rig writes them: status, proof, sheet, log. */
const arm = (
  out: string,
  name: "mini" | "mini-2x",
  options: {
    readonly status?: number;
    readonly devicePixelRatio?: number;
    readonly evictions?: number;
    readonly proof?: string | undefined;
    readonly failures?: ReadonlyArray<string>;
    readonly sheet?: boolean;
    readonly strips?: boolean;
    readonly log?: string;
  } = {},
): void => {
  const dir = join(out, name);
  mkdirSync(join(dir, "contact"), { recursive: true });
  writeFileSync(join(dir, "status"), String(options.status ?? 0));
  if (options.proof !== undefined) writeFileSync(join(dir, "proof.json"), options.proof);
  if (options.proof === undefined && options.failures !== undefined) {
    writeFileSync(join(dir, "proof.json"), JSON.stringify({ failures: options.failures, proof: [{ line: "display", devicePixelRatio: ARM_SCALE[name], shot: { width: 1440, height: 900 } }, { line: "atlas", evictions: 42 }] }, null, 2));
  }
  if (options.proof === undefined && options.failures === undefined) {
    const records = [
      { line: "display", devicePixelRatio: options.devicePixelRatio ?? ARM_SCALE[name], shot: { width: 1440 * (options.devicePixelRatio ?? ARM_SCALE[name]), height: 900 * (options.devicePixelRatio ?? ARM_SCALE[name]) }, window: name },
      { line: "stop", camera: { zoom: 0.15 }, sheet: "stop-00.png" },
      { line: "atlas", evictions: options.evictions ?? 42, failedCells: 0 },
    ];
    writeFileSync(join(dir, "proof.json"), JSON.stringify(records, null, 2));
  }
  // The spec's own shape: the sheet is <arm>/index.html, its screenshots live in <arm>/contact/.
  if (options.sheet === false) rmSync(join(dir, "index.html"), { force: true });
  else writeFileSync(join(dir, "index.html"), "<html>sheet</html>");
  if (options.strips === false) rmSync(join(dir, "contact"), { recursive: true, force: true });
  else writeFileSync(join(dir, "contact", "000-stop.png"), "png");
  writeFileSync(join(dir, "run.log"), options.log ?? "");
};

const summary = (out: string, arms: ReadonlyArray<{ readonly name: string; readonly status: number }>): void => {
  writeFileSync(
    join(out, "summary.json"),
    JSON.stringify({ commit: "abc1234", boardSha256: "d00dfeed", arms }, null, 2),
  );
};

/** A run that must pass, so each test can break exactly one thing. */
const passing = (): string => {
  const out = scratch();
  arm(out, "mini", { devicePixelRatio: 1 });
  arm(out, "mini-2x", { devicePixelRatio: 2 });
  summary(out, [
    { name: "mini", status: 0 },
    { name: "mini-2x", status: 0 },
  ]);
  return out;
};

describe("the zoom ladder's judge", () => {
  it("accepts two arms that drew at their own scale, evicted, and left a sheet each", () => {
    const judgement = judgeArms(passing());
    expect(judgement.faults).toEqual([]);
    expect(judgement.ok).toBe(true);
    expect(judgement.commit).toBe("abc1234");
    expect(judgement.boardSha256).toBe("d00dfeed");
    expect(judgement.arms.map((arm) => [arm.name, arm.devicePixelRatio, arm.evictions])).toEqual([
      ["mini", 1, 42],
      ["mini-2x", 2, 42],
    ]);
  });

  it("refuses an arm that drew at 1x and calls itself the 2x arm", () => {
    // The fault that matters: JUNTO_GPU_PROOF_WINDOW falls back to the operator
    // display on a value the harness does not know, so a pass here would ship a
    // 2x claim nobody measured.
    const out = passing();
    arm(out, "mini-2x", { devicePixelRatio: 1 });
    const faulted = judgeArms(out);
    expect(faulted.ok).toBe(false);
    expect(faulted.faults.join(" ")).toContain("drew at devicePixelRatio 1, not 2");
  });

  it("refuses an arm that failed, naming where its screenshots are", () => {
    const out = passing();
    arm(out, "mini-2x", { devicePixelRatio: 2, status: 1 });
    summary(out, [
      { name: "mini", status: 0 },
      { name: "mini-2x", status: 1 },
    ]);
    const faulted = judgeArms(out);
    expect(faulted.ok).toBe(false);
    expect(faulted.faults.join(" ")).toContain("the mini-2x arm failed (exit 1)");
  });

  it("says what failed in the spec's own words, not only that an arm did", () => {
    const out = passing();
    arm(out, "mini", { devicePixelRatio: 1, failures: ["c0-region-edge-in-0.26: 1 landed sprite cell(s) hold another drawing", "c0-image-notes-in-1: 58 blocks differ"] });
    writeFileSync(join(out, "mini", "status"), "1");
    summary(out, [
      { name: "mini", status: 1 },
      { name: "mini-2x", status: 0 },
    ]);
    const faulted = judgeArms(out);
    expect(faulted.ok).toBe(false);
    expect(faulted.faults.join(" ")).toContain("2 failure(s)");
    expect(faulted.faults.join(" ")).toContain("1 landed sprite cell(s) hold another drawing");
    expect(faulted.arms[0]?.failures).toHaveLength(2);
  });

  it("refuses a sheet whose screenshots are missing", () => {
    const out = passing();
    arm(out, "mini", { devicePixelRatio: 1, strips: false });
    summary(out, [
      { name: "mini", status: 0 },
      { name: "mini-2x", status: 0 },
    ]);
    const faulted = judgeArms(out);
    expect(faulted.ok).toBe(false);
    expect(faulted.faults.join(" ")).toContain("screenshots are missing");
  });

  it("quotes the arm's own evictions, not a count nested in what a stop measured", () => {
    const out = passing();
    const records = [
      { line: "display", devicePixelRatio: 1, shot: { width: 1440, height: 900 } },
      { line: "stop", evictions: 311, texels: { compared: 104, evictions: 9000 } },
      { line: "stop", evictions: 837, thrash: { count: 4 } },
    ];
    writeFileSync(join(out, "mini", "proof.json"), JSON.stringify(records, null, 2));
    const judged = judgeArms(out);
    expect(judged.arms[0]?.evictions).toBe(837);
  });

  it("refuses a run that never evicted", () => {
    const out = passing();
    arm(out, "mini", { devicePixelRatio: 1, evictions: 0 });
    const faulted = judgeArms(out);
    expect(faulted.ok).toBe(false);
    expect(faulted.faults.join(" ")).toContain("evicted nothing");
  });

  it("takes evictions from the console when the proof does not carry them", () => {
    const out = scratch();
    arm(out, "mini", { proof: JSON.stringify([{ line: "display", devicePixelRatio: 1, shot: { width: 1440, height: 900 } }]), log: 'stop 3 {"evictions":17,"failedCells":0}\n' });
    arm(out, "mini-2x", { devicePixelRatio: 2 });
    summary(out, [
      { name: "mini", status: 0 },
      { name: "mini-2x", status: 0 },
    ]);
    const judgement = judgeArms(out);
    expect(judgement.faults).toEqual([]);
    expect(judgement.arms[0]?.evictions).toBe(17);
  });

  it("refuses a proof it cannot read, and one with no display line", () => {
    const unreadable = passing();
    arm(unreadable, "mini", { devicePixelRatio: 1, proof: "not json at all\nand no records" });
    expect(judgeArms(unreadable).faults.join(" ")).toContain("cannot be read as a proof");

    const noDisplay = passing();
    arm(noDisplay, "mini", { devicePixelRatio: 1, proof: JSON.stringify([{ line: "stop", camera: { zoom: 1 } }]) });
    expect(judgeArms(noDisplay).faults.join(" ")).toContain("names no display line");
  });

  it("refuses a missing proof, a missing sheet, and an arm the rig never recorded", () => {
    const noProof = passing();
    rmSync(join(noProof, "mini", "proof.json"));
    expect(judgeArms(noProof).faults.join(" ")).toContain("wrote no proof.json");

    const noSheet = passing();
    arm(noSheet, "mini-2x", { devicePixelRatio: 2, sheet: false });
    expect(judgeArms(noSheet).faults.join(" ")).toContain("no contact sheet");

    const noArm = scratch();
    arm(noArm, "mini", { devicePixelRatio: 1 });
    summary(noArm, [{ name: "mini", status: 0 }]);
    expect(judgeArms(noArm).faults.join(" ")).toContain("the mini-2x arm has no recorded status");
  });

  it("refuses a run with no summary at all", () => {
    const out = scratch();
    arm(out, "mini", { devicePixelRatio: 1 });
    arm(out, "mini-2x", { devicePixelRatio: 2 });
    expect(judgeArms(out).faults.join(" ")).toContain("no readable summary.json");
  });

  it("reads a proof written as JSON, as an object holding stops, or as JSON lines", () => {
    const one = [{ line: "display", devicePixelRatio: 2, shot: { width: 2880, height: 1800 } }];
    expect(proofRecords(JSON.stringify(one))?.length).toBe(1);
    expect(proofRecords(JSON.stringify({ stops: one }))?.length).toBe(1);
    expect(proofRecords(one.map((record) => JSON.stringify(record)).join("\n"))?.length).toBe(1);
    expect(proofRecords("")).toBeUndefined();
  });

  it("marks the run as a GPU one before it touches the mini, or the mini refuses it", () => {
    // scripts/mini.sh at, put and run refuse unless the call says it needs the
    // real GPU (MINI_GPU=1 or --gpu first). The gate is the one caller that
    // always does, and it must say so before its first call, not after.
    const source = readFileSync(fileURLToPath(new URL("../scripts/release-zoom-ladder.sh", import.meta.url)), "utf8");
    // Executed lines only: the header names the calls it makes, and a mention in
    // a comment is not a call.
    const script = source
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");
    const marked = script.indexOf("export MINI_GPU=1");
    expect(marked).toBeGreaterThan(-1);
    const firstCall = script.indexOf("scripts/mini.sh");
    const firstRun = script.indexOf("scripts/mini.sh run");
    expect(firstCall).toBeGreaterThan(-1);
    expect(marked).toBeLessThan(firstCall);
    expect(marked).toBeLessThan(firstRun);
  });

  it("writes a bullet with both sheets, and says a seat has not read them yet", () => {
    const judgement = judgeArms(passing());
    const bullet = receiptBullet(judgement, undefined);
    expect(bullet).toContain("mini/index.html");
    expect(bullet).toContain("mini-2x/index.html");
    expect(bullet).toContain("d00dfeed");
    expect(bullet).toContain("a seat must read them");
    expect(receiptBullet(judgement, "canvas-verifier")).toContain("Read by canvas-verifier");
  });
});
