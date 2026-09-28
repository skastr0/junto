/** How `junto offboard <notes>` reads its notes: markdown, JSON, or a file. */
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

describe("offboard input", () => {
  it("takes markdown as it is, the JSON object, or a file", async () => {
    const markdown = "# Parser shipped\n\n{braces} stay text";
    expect(await Effect.runPromise(loadOffboardArgs(markdown))).toEqual({ notes: markdown });
    expect(await Effect.runPromise(loadOffboardArgs('{"notes":"From JSON"}'))).toEqual({ notes: "From JSON" });

    const dir = await mkdtemp(join(tmpdir(), "junto-offboard-input-"));
    dirs.push(dir);
    const file = join(dir, "notes.md");
    await writeFile(file, "From a file\n");
    expect(await Effect.runPromise(loadOffboardArgs(`@${file}`))).toEqual({ notes: "From a file\n" });
  });

  it("refuses empty notes and a JSON object with other fields", async () => {
    expect(await Effect.runPromise(Effect.flip(loadOffboardArgs("  ")))).toMatchObject({ path: "input" });
    await expect(Effect.runPromise(loadOffboardArgs('{"notes":"x","seatId":"other"}'))).rejects.toBeDefined();
  });
});
