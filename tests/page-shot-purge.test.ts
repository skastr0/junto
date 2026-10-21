/**
 * The operator's purge of a page box comment's shot (B7, remote-security's
 * condition 1): one way in, the trusted renderer's IPC under its own
 * authoring label, and nothing on the work socket, a seat, an overseer or an
 * automation reaches it. The purge itself is tests/shot-purge.test.ts.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { MAIN_AUTHORING_LABELS } from "../src/main/junto/main-authoring-gate";
import { WorkAuthorityError, WorkRepository } from "../src/main/junto/work/repository";
import { purgeOperatorPageShot } from "../src/main/junto/work/page-shot-purge";
import { WorkOpName } from "../src/shared/work-control";

const REQUEST = { canvasName: "factory", nodeId: "page-1", messageId: "01M5F8P0000000000000000003" };

const purge = (answer: Effect.Effect<{ readonly comment: typeof REQUEST; readonly released: number; readonly written: boolean }, unknown>) => {
  const asked: unknown[] = [];
  const run = purgeOperatorPageShot(REQUEST).pipe(
    Effect.provideService(WorkRepository, {
      purgeShot: (input: unknown) => {
        asked.push(input);
        return answer;
      },
    } as never),
  );
  return Effect.runPromise(run).then((result) => ({ result, asked }));
};

const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sources(path) : /\.tsx?$/u.test(name) ? [path] : [];
  });

describe("the operator's purge of a page box comment's shot", () => {
  it("names the comment, answers removed or already removed, and words refusals for the operator", async () => {
    const comment = { ...REQUEST, messageId: "01M5F8P0000000000000000001" };
    expect(await purge(Effect.succeed({ comment, released: 2, written: true }))).toEqual({
      result: { ok: true, messageId: comment.messageId, already: false },
      asked: [REQUEST],
    });
    expect((await purge(Effect.succeed({ comment, released: 0, written: false }))).result).toEqual({ ok: true, messageId: comment.messageId, already: true });
    const refused = async (reason: "authority-mismatch" | "missing-entity" | "causal-conflict") =>
      (await purge(Effect.fail(WorkAuthorityError.make({ reason, message: "store words" })))).result;
    expect(await refused("authority-mismatch")).toEqual({ ok: false, message: "Only the machine that edits this canvas can remove a screenshot." });
    expect(await refused("missing-entity")).toEqual({ ok: false, message: "That comment has no screenshot." });
    expect(await refused("causal-conflict")).toEqual({ ok: false, message: "The screenshot could not be removed." });
  });

  it("is reached only from the trusted renderer's IPC, under its own label", () => {
    const src = join(__dirname, "../src");
    const files = sources(src).map((path) => ({ path: relative(src, path), text: readFileSync(path, "utf8") }));
    const calling = (pattern: RegExp) => files.filter(({ text }) => pattern.test(text)).map(({ path }) => path).sort();
    expect(calling(/\.purgeShot\(/u)).toEqual(["main/junto/work/page-shot-purge.ts"]);
    expect(calling(/\bpurgeOperatorPageShot\b/u)).toEqual(["main/junto/ipc.ts", "main/junto/work/page-shot-purge.ts"]);
    const ipc = files.find(({ path }) => path === "main/junto/ipc.ts")!.text;
    expect(ipc).toMatch(/privilegedIpc\.handle\(IPC_CHANNELS\.pageShotPurge,/u);
    expect(ipc).toMatch(/runMainAuthoring\("ipc\.page-shot\.purge"/u);
    expect(MAIN_AUTHORING_LABELS).toContain("ipc.page-shot.purge");
    // The work socket, seats, overseers and automations speak work ops: none purges.
    expect(WorkOpName.literals.filter((op) => /purge/iu.test(op))).toEqual([]);
  });
});
