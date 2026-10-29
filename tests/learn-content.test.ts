/**
 * content/learn: the scenes and quizzes the tour, the docs and the landing
 * page teach from (src/shared/learn.ts). Every file decodes, is named by its
 * id, and every quiz receipt names lines that exist in that file at the
 * commit it was read, a commit this branch contains.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { RECEIPT_PATTERN, decodeQuiz, decodeScene } from "../src/shared/learn";

const root = resolve(__dirname, "..");
const dir = (kind: "scenes" | "quizzes"): string => resolve(root, "content/learn", kind);
const files = (kind: "scenes" | "quizzes"): ReadonlyArray<string> =>
  readdirSync(dir(kind)).filter((name) => name.endsWith(".json"));
const read = (kind: "scenes" | "quizzes", name: string): unknown =>
  JSON.parse(readFileSync(resolve(dir(kind), name), "utf8"));

const git = (...args: ReadonlyArray<string>): string =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

/** Why a receipt does not hold, or undefined when it does. */
const receiptFault = (receipt: string): string | undefined => {
  const [, path, from, to, sha] = RECEIPT_PATTERN.exec(receipt)!;
  try {
    git("merge-base", "--is-ancestor", sha!, "HEAD");
  } catch {
    return `${receipt}: ${sha} is not a commit on this branch`;
  }
  let text: string;
  try {
    text = git("show", `${sha}:${path}`);
  } catch {
    return `${receipt}: ${path} does not exist at ${sha}`;
  }
  const lines = text.split("\n").length;
  const last = Number(to ?? from);
  if (Number(from) < 1 || last < Number(from) || last > lines) return `${receipt}: ${path} has ${String(lines)} lines at ${sha}`;
  return undefined;
};

describe("content/learn", () => {
  it("has lessons", () => {
    expect(files("scenes").length).toBeGreaterThan(0);
    expect(files("quizzes").length).toBeGreaterThan(0);
  });

  it.each(files("scenes"))("scene %s decodes and is named by its id", (name) => {
    expect(decodeScene(read("scenes", name)).id).toBe(basename(name, ".json"));
  });

  it.each(files("quizzes"))("quiz %s decodes, is named by its id, and its receipts hold", (name) => {
    const quiz = decodeQuiz(read("quizzes", name));
    expect(quiz.id).toBe(basename(name, ".json"));
    const faults = quiz.questions.flatMap((question) => question.receipts.map(receiptFault)).filter((fault) => fault !== undefined);
    expect(faults).toEqual([]);
  });

  it("refuses a scene beat that names a seat the scene does not have", () => {
    const scene = read("scenes", files("scenes")[0]!) as { beats: unknown[] };
    expect(() => decodeScene({ ...scene, beats: [{ at: 0, seat: { id: "nobody" } }] })).toThrow(/nobody/);
  });

  it("refuses a question with two correct answers", () => {
    const quiz = read("quizzes", files("quizzes")[0]!) as { questions: Array<{ choices: Array<Record<string, unknown>> }> };
    const [first, ...rest] = quiz.questions;
    const both = { ...first, choices: first!.choices.map((choice) => ({ ...choice, correct: true })) };
    expect(() => decodeQuiz({ ...quiz, questions: [both, ...rest] })).toThrow(/exactly one/);
  });
});
