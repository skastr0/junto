/**
 * The release gate's zoom ladder, judged (operator row: the GPU canvas plan,
 * item 1). `scripts/release-zoom-ladder.sh` drives the Mac mini and brings the
 * artifacts back; this reads them and decides, so the decision is one function
 * with tests instead of a shell condition nobody ran.
 *
 * What it refuses, each with its own sentence: an arm the rig did not record, an
 * arm that failed, a proof the run did not write or that cannot be read as a
 * proof, an arm that did not draw at the scale it claims, a run that never
 * evicted (so the atlas was never asked to reclaim), and a contact sheet with no
 * index. The sheet is `<arm>/index.html`, the page the spec writes, with its
 * screenshots under `<arm>/contact/`: adding a directory to the path would refuse
 * every honest run. The scale check is the load-bearing one: JUNTO_GPU_PROOF_WINDOW falls
 * back to the operator display on a value the harness does not know, so a gate
 * that only set the variable would call a 2x arm green that drew at 1x.
 *
 * Three verbs: judge (after a run), `--record-read <seat>` (the seat that read
 * the sheets), and `--check` (the cut's last gate: the ladder passed, the sheets
 * are here, and a seat is named as having read them).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type ArmName = "mini" | "mini-2x";

/** The scale each arm must have drawn at: the mini's own screen is 1x, mini-2x forces the operator's 2. */
export const ARM_SCALE: Readonly<Record<ArmName, number>> = { mini: 1, "mini-2x": 2 };

export const ARMS: ReadonlyArray<ArmName> = ["mini", "mini-2x"];

export type ArmRecord = {
  readonly name: ArmName;
  readonly status: number;
  readonly devicePixelRatio: number;
  readonly shot: { readonly width: number; readonly height: number } | undefined;
  readonly evictions: number;
  /** The spec's own failure lines for this arm, so a refusal says what failed, not only that something did. */
  readonly failures: ReadonlyArray<string>;
  readonly proof: string;
  readonly sheet: string;
};

export type Judgement = {
  readonly ok: boolean;
  /** One sentence per fault, in the order they were found. Empty when ok. */
  readonly faults: ReadonlyArray<string>;
  readonly commit: string;
  readonly boardSha256: string;
  readonly arms: ReadonlyArray<ArmRecord>;
};

const readJson = (path: string): unknown => {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A proof is an array of records, an object holding them under a known name, or JSON lines. */
export const proofRecords = (text: string): ReadonlyArray<Readonly<Record<string, unknown>>> | undefined => {
  const whole = ((): unknown => {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return undefined;
    }
  })();
  const list = Array.isArray(whole)
    ? whole
    : isRecord(whole)
      ? (["proof", "stops", "lines", "records"] as const)
          .map((key) => whole[key])
          .find((value): value is ReadonlyArray<unknown> => Array.isArray(value))
      : undefined;
  const gathered: ReadonlyArray<unknown> =
    list ??
    text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("{"))
      .map((line): unknown => {
        try {
          return JSON.parse(line) as unknown;
        } catch {
          return undefined;
        }
      });
  const records = gathered.filter(isRecord);
  return records.length === 0 ? undefined : records;
};

/** The spec's `failures` array: what it found wrong, in its own words. */
export const proofFailures = (text: string): ReadonlyArray<string> => {
  const whole = ((): unknown => {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return undefined;
    }
  })();
  const failures = isRecord(whole) && Array.isArray(whole["failures"]) ? whole["failures"] : [];
  return failures.filter((failure): failure is string => typeof failure === "string");
};

/** The `display` line the spec logs at every stop: the scale that run drew at. */
const displayOf = (records: ReadonlyArray<Readonly<Record<string, unknown>>>) =>
  records
    .filter((record) => record["line"] === "display")
    .map((record) => ({
      devicePixelRatio: typeof record["devicePixelRatio"] === "number" ? (record["devicePixelRatio"] as number) : undefined,
      shot: isRecord(record["shot"]) && typeof record["shot"]["width"] === "number" && typeof record["shot"]["height"] === "number"
        ? { width: record["shot"]["width"] as number, height: record["shot"]["height"] as number }
        : undefined,
    }));

/** The greatest `evictions` any record (or the spec's summary) reports. */
const evictionsOf = (records: ReadonlyArray<Readonly<Record<string, unknown>>>): number | undefined => {
  let greatest: number | undefined;
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!isRecord(value)) return;
    for (const [key, inner] of Object.entries(value)) {
      if (key === "evictions" && typeof inner === "number" && Number.isFinite(inner)) {
        greatest = greatest === undefined ? inner : Math.max(greatest, inner);
      }
      visit(inner);
    }
  };
  visit(records);
  return greatest;
};

/** What the arm's own console said it evicted, when the proof does not name it. */
const evictionsInLog = (log: string): number | undefined => {
  let greatest: number | undefined;
  for (const match of log.matchAll(/"evictions"\s*:\s*(\d+)|evictions[:=\s]+(\d+)/gu)) {
    const value = Number(match[1] ?? match[2]);
    if (!Number.isFinite(value)) continue;
    greatest = greatest === undefined ? value : Math.max(greatest, value);
  }
  return greatest;
};

/**
 * Judge one run's artifacts. `out` holds summary.json and one directory per arm,
 * as scripts/zoom-ladder-gate.sh wrote them on the mini.
 */
export const judgeArms = (out: string): Judgement => {
  const faults: string[] = [];
  const summary = readJson(join(out, "summary.json"));
  const commit = isRecord(summary) && typeof summary["commit"] === "string" ? summary["commit"] : "";
  const boardSha256 = isRecord(summary) && typeof summary["boardSha256"] === "string" ? summary["boardSha256"] : "";
  if (!isRecord(summary)) faults.push(`the rig wrote no readable summary.json in ${out}, so nothing says which commit or board this run was on`);
  if (isRecord(summary) && commit === "") faults.push("summary.json names no commit");
  if (isRecord(summary) && boardSha256 === "") faults.push("summary.json names no board sha256, so the cut cannot say which board the canvas was proved on");
  const recorded = isRecord(summary) && Array.isArray(summary["arms"]) ? summary["arms"] : [];

  const arms: ArmRecord[] = [];
  for (const name of ARMS) {
    const armOut = join(out, name);
    const entry = recorded.find((candidate): candidate is Readonly<Record<string, unknown>> => isRecord(candidate) && candidate["name"] === name);
    const statusFile = join(armOut, "status");
    const status = entry !== undefined && typeof entry["status"] === "number"
      ? (entry["status"] as number)
      : existsSync(statusFile) && /^\d+$/u.test(readFileSync(statusFile, "utf8").trim())
        ? Number(readFileSync(statusFile, "utf8").trim())
        : undefined;
    if (status === undefined) {
      faults.push(`the ${name} arm has no recorded status: the rig did not run it, so there is no sheet to read for that scale`);
      continue;
    }
    const proofPath = join(armOut, "proof.json");
    const proofText = existsSync(proofPath) ? readFileSync(proofPath, "utf8") : "";
    const failures = proofText === "" ? [] : proofFailures(proofText);
    if (status !== 0) {
      const said = failures.length === 0
        ? "its proof names no failure line"
        : `${String(failures.length)} failure(s): ${failures.join(" | ")}`;
      faults.push(`the ${name} arm failed (exit ${String(status)}), ${said}; its screenshots, references, diffs and run.log are in ${armOut}`);
    }
    if (!existsSync(proofPath)) {
      faults.push(`the ${name} arm wrote no proof.json, so its stops cannot be checked`);
    }
    const records = proofText === "" ? undefined : proofRecords(proofText);
    if (existsSync(proofPath) && records === undefined) faults.push(`the ${name} arm's proof.json cannot be read as a proof: no record in it parses`);
    const displays = records === undefined ? [] : displayOf(records);
    if (records !== undefined && displays.length === 0) faults.push(`the ${name} arm's proof names no display line, so nothing says what scale it drew at`);
    const wrongScale = displays.filter((display) => display.devicePixelRatio !== ARM_SCALE[name]);
    if (wrongScale.length > 0) {
      const seen = [...new Set(wrongScale.map((display) => String(display.devicePixelRatio)))].join(", ");
      faults.push(`the ${name} arm drew at devicePixelRatio ${seen}, not ${String(ARM_SCALE[name])}: JUNTO_GPU_PROOF_WINDOW falls back to the operator display on a value the harness does not know, so this arm is not the scale it claims`);
    }
    const logPath = join(armOut, "run.log");
    const evictions = (records === undefined ? undefined : evictionsOf(records)) ?? (existsSync(logPath) ? evictionsInLog(readFileSync(logPath, "utf8")) : undefined);
    if (evictions === undefined) {
      faults.push(`the ${name} arm names no evictions in its proof or its run.log, so the gate cannot tell whether the atlas was ever asked to reclaim`);
    } else if (evictions === 0) {
      faults.push(`the ${name} arm evicted nothing, so the ladder never exercised eviction`);
    }
    const sheet = join(armOut, "index.html");
    const strips = join(armOut, "contact");
    if (!existsSync(sheet)) {
      faults.push(`the ${name} arm has no contact sheet at ${sheet}, so nobody can see what it drew`);
    } else if (!existsSync(strips)) {
      faults.push(`the ${name} arm wrote a contact sheet with no contact/ beside it, so its screenshots are missing`);
    }
    arms.push({
      name,
      status,
      devicePixelRatio: displays[0]?.devicePixelRatio ?? 0,
      shot: displays.find((display) => display.shot !== undefined)?.shot,
      evictions: evictions ?? 0,
      failures,
      proof: join(name, "proof.json"),
      sheet: join(name, "index.html"),
    });
  }
  return { ok: faults.length === 0, faults, commit, boardSha256, arms };
};

/** The one bullet the cut note carries, built from the judgement so a path cannot go missing from it. */
export const receiptBullet = (judgement: Judgement, readBy: string | undefined): string => {
  const arms = judgement.arms
    .map((arm) => `${arm.name} drew at ${String(arm.devicePixelRatio)}x (${arm.shot === undefined ? "no shot size recorded" : `${String(arm.shot.width)}x${String(arm.shot.height)}`}), ${String(arm.evictions)} evictions`)
    .join("; ");
  const sheets = judgement.arms.map((arm) => arm.sheet).join(", ");
  return `- GPU canvas zoom ladder at ${judgement.commit}: 1x and 2x on board shapes sha256 ${judgement.boardSha256}. ${arms}. Every stop equal to its fresh-launch reference, audit clean, texels whole, no GPU error. Sheets: ${sheets}. Read by ${readBy ?? "(a seat must read them before the cut)"}.`;
};

type Receipt = {
  readonly commit: string;
  readonly boardSha256: string;
  readonly ok: boolean;
  readonly faults: ReadonlyArray<string>;
  readonly arms: ReadonlyArray<ArmRecord>;
  readonly readBy: string | null;
  readonly bullet: string;
};

const usage = `usage:
  scripts/release-zoom-ladder.sh --board <shapes.json> [--commit <ref>] [--seat <name>] [--out <dir>]
  scripts/release-zoom-ladder.sh --record-read <seat> [--out <dir>]
  scripts/release-zoom-ladder.sh --check [--out <dir>]

The judge runs after the mini brought the artifacts back; --record-read names the
seat that read the sheets; --check is the cut's last gate.`;

const flag = (argv: ReadonlyArray<string>, name: string): string | undefined => {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
};

const main = (argv: ReadonlyArray<string>): number => {
  const out = resolve(flag(argv, "--out") ?? join(process.cwd(), "release-zoom-ladder"));
  const receiptPath = join(out, "release-zoom-ladder.json");

  if (argv.includes("--record-read")) {
    const seat = flag(argv, "--record-read") ?? "";
    if (seat.trim() === "") {
      console.error(usage);
      return 2;
    }
    const receipt = readJson(receiptPath);
    if (!isRecord(receipt)) {
      console.error(`release-zoom-ladder: no receipt at ${receiptPath}: run the ladder first`);
      return 1;
    }
    const judgement: Judgement = {
      ok: receipt["ok"] === true,
      faults: Array.isArray(receipt["faults"]) ? (receipt["faults"] as ReadonlyArray<string>) : [],
      commit: typeof receipt["commit"] === "string" ? receipt["commit"] : "",
      boardSha256: typeof receipt["boardSha256"] === "string" ? receipt["boardSha256"] : "",
      arms: Array.isArray(receipt["arms"]) ? (receipt["arms"] as ReadonlyArray<ArmRecord>) : [],
    };
    const next: Receipt = { ...judgement, readBy: seat.trim(), bullet: receiptBullet(judgement, seat.trim()) };
    writeFileSync(receiptPath, `${JSON.stringify(next, null, 2)}\n`);
    console.log(next.bullet);
    return judgement.ok ? 0 : 1;
  }

  if (argv.includes("--check")) {
    const receipt = readJson(receiptPath);
    if (!isRecord(receipt)) {
      console.error(`release-zoom-ladder: the cut has no ladder receipt at ${receiptPath}`);
      return 1;
    }
    const faults: string[] = [];
    if (receipt["ok"] !== true) faults.push("the ladder did not pass");
    const readBy = typeof receipt["readBy"] === "string" ? receipt["readBy"].trim() : "";
    if (readBy === "") faults.push("no seat is named as having read the contact sheets");
    const arms = Array.isArray(receipt["arms"]) ? (receipt["arms"] as ReadonlyArray<ArmRecord>) : [];
    if (arms.length !== ARMS.length) faults.push(`the receipt holds ${String(arms.length)} arms, not ${String(ARMS.length)}: one scale is unproved`);
    for (const arm of arms) {
      if (!existsSync(join(out, arm.sheet))) faults.push(`the ${arm.name} contact sheet is not at ${join(out, arm.sheet)} any more`);
    }
    if (faults.length > 0) {
      for (const fault of faults) console.error(`release-zoom-ladder: ${fault}`);
      return 1;
    }
    console.log(`release-zoom-ladder: ${String(readBy)} read the sheets for ${String(receipt["commit"])}; the cut may carry ${receiptPath}`);
    return 0;
  }

  const judgement = judgeArms(out);
  const receipt: Receipt = { ...judgement, readBy: null, bullet: receiptBullet(judgement, undefined) };
  mkdirSync(dirname(receiptPath), { recursive: true });
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  for (const fault of judgement.faults) console.error(`release-zoom-ladder: ${fault}`);
  if (!judgement.ok) {
    console.error(`release-zoom-ladder: the ladder FAILED for ${judgement.commit === "" ? "an unnamed commit" : judgement.commit}; receipt ${receiptPath}`);
    return 1;
  }
  console.log(receipt.bullet);
  console.log(`release-zoom-ladder: passed for ${judgement.commit}; receipt ${receiptPath}`);
  console.log(`release-zoom-ladder: next, a seat reads ${judgement.arms.map((arm) => join(out, arm.sheet)).join(" and ")}, then scripts/release-zoom-ladder.sh --record-read <seat>, then --check before the cut`);
  return 0;
};

if (import.meta.main) process.exit(main(process.argv.slice(2)));
