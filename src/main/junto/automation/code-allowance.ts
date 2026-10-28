/**
 * Whether this machine runs code steps for a canvas (plan 0.11/05, Code
 * steps; docs/security-doctrine.md, Code steps, check 4). The allowance is
 * this machine's owner's choice: a file in this Junto home, never a row,
 * never synced, never set over a link, the same as a secret
 * (docs/machines.md Rule 9). It binds the canvas, the ruling installations
 * it trusts for that canvas (the editing machine, and standby rulers when
 * they come), and who may have authored the code. It is read before every
 * run, so a withdrawal stops the next run; one in flight ends at its timeout.
 */
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";

/** Who may have authored code this machine runs: the operator alone, or overseer seats too. */
export const CodeAllowanceScope = Schema.Literals(["operator", "operator-and-overseers"]);
export type CodeAllowanceScope = typeof CodeAllowanceScope.Type;

/** The operator's decision (05): allowed means operator and overseers unless narrowed. */
export const DEFAULT_CODE_ALLOWANCE_SCOPE: CodeAllowanceScope = "operator-and-overseers";

const Name = Schema.String.pipe(Schema.check(Schema.isMinLength(1)), Schema.check(Schema.isMaxLength(256)));

export const CodeAllowance = Schema.Struct({
  scope: CodeAllowanceScope,
  /** The installations whose rulings this machine runs code from, for this canvas. */
  installations: Schema.Array(Name).pipe(Schema.check(Schema.isMinLength(1))),
});
export type CodeAllowance = typeof CodeAllowance.Type;

const CodeAllowanceFile = Schema.Struct({
  version: Schema.Literal(1),
  canvases: Schema.Record(Name, CodeAllowance),
});
type CodeAllowanceFile = typeof CodeAllowanceFile.Type;

const decodeFile = Schema.decodeUnknownSync(CodeAllowanceFile, { onExcessProperty: "error" });

export const codeAllowancePath = (home: string): string => join(home, "machine-code-allowance.json");

/** Who authored the code a step runs: the actor of the ruling that last set its code ref. */
export type CodeAuthor = "operator" | "overseer";

/** Why an allowance does not admit a run, or undefined when it does. */
export type CodeAllowanceRefusal = "canvas" | "installation" | "author";

export const allowanceRefusal = (
  allowance: CodeAllowance | undefined,
  rulingInstallation: string,
  author: CodeAuthor,
): CodeAllowanceRefusal | undefined => {
  if (allowance === undefined) return "canvas";
  if (!allowance.installations.includes(rulingInstallation)) return "installation";
  if (author === "overseer" && allowance.scope !== "operator-and-overseers") return "author";
  return undefined;
};

/**
 * Every canvas this machine allows. A missing file allows none. A file that
 * does not decode allows none as well: an unreadable allowance never runs code.
 */
export const readCodeAllowances = async (home: string): Promise<Readonly<Record<string, CodeAllowance>>> => {
  let text: string;
  try {
    text = await readFile(codeAllowancePath(home), "utf8");
  } catch {
    return {};
  }
  try {
    return decodeFile(JSON.parse(text)).canvases;
  } catch {
    return {};
  }
};

export const readCodeAllowance = async (home: string, canvasName: string): Promise<CodeAllowance | undefined> => {
  const canvases = await readCodeAllowances(home);
  return Object.hasOwn(canvases, canvasName) ? canvases[canvasName] : undefined;
};

/** Allow (with an allowance) or deny (undefined) one canvas; written owner-only, replaced whole. */
export const writeCodeAllowance = async (
  home: string,
  canvasName: string,
  allowance: CodeAllowance | undefined,
): Promise<Readonly<Record<string, CodeAllowance>>> => {
  // Entries, not assignment: a canvas named __proto__ is a name, never the prototype.
  const kept = Object.entries(await readCodeAllowances(home)).filter(([name]) => name !== canvasName);
  const canvases: Readonly<Record<string, CodeAllowance>> =
    Object.fromEntries(allowance === undefined ? kept : [...kept, [canvasName, allowance]]);
  const file: CodeAllowanceFile = { version: 1, canvases };
  await mkdir(home, { recursive: true, mode: 0o700 });
  const path = codeAllowancePath(home);
  const next = `${path}.${process.pid}.tmp`;
  await writeFile(next, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  await chmod(next, 0o600);
  await rename(next, path);
  return canvases;
};
