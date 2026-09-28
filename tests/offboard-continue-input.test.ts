/** How `junto offboard <notes> --continue <note>` reads the continuation. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { loadOffboardArgs } from "../src/cli/core/offboard-input";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("offboard --continue input", () => {
  it("takes the continuation inline, from a file, or in the JSON object", async () => {
    expect(await Effect.runPromise(loadOffboardArgs("Notes", "Pick up the retry"))).toEqual({
      notes: "Notes",
      continuation: "Pick up the retry",
    });
    const dir = await mkdtemp(join(tmpdir(), "junto-offboard-continue-"));
    dirs.push(dir);
    const file = join(dir, "next.md");
    await writeFile(file, "From a file\n");
    expect(await Effect.runPromise(loadOffboardArgs("Notes", `@${file}`))).toEqual({
      notes: "Notes",
      continuation: "From a file\n",
    });
    expect(
      await Effect.runPromise(loadOffboardArgs('{"notes":"Notes","continuation":"Pick up the retry"}')),
    ).toEqual({ notes: "Notes", continuation: "Pick up the retry" });
  });

  it("without --continue there is no continuation", async () => {
    expect(await Effect.runPromise(loadOffboardArgs("Notes"))).toEqual({ notes: "Notes" });
  });

  it("refuses an empty continuation, stdin for both, and a continuation given twice", async () => {
    expect(await Effect.runPromise(Effect.flip(loadOffboardArgs("Notes", "  ")))).toMatchObject({ path: "continue" });
    expect(await Effect.runPromise(Effect.flip(loadOffboardArgs("-", "-")))).toMatchObject({ path: "continue" });
    expect(
      await Effect.runPromise(Effect.flip(loadOffboardArgs('{"notes":"n","continuation":"a"}', "b"))),
    ).toMatchObject({ path: "continue" });
  });
});
