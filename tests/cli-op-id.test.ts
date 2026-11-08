import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import { opIdInArgs, opIdOf } from "../src/cli/core/op-id";
import { isOpId } from "../src/shared/work-ids";

describe("the CLI-minted opId", () => {
  it("mints a bare ULID when --op-id is absent", async () => {
    const opId = await Effect.runPromise(opIdOf(Option.none()));
    expect(isOpId(opId)).toBe(true);
    expect(opId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("takes the opId --op-id names, and refuses anything else", async () => {
    const given = "01M5EW2K9M5CN3Z3VP1J5EFB0Y";
    expect(await Effect.runPromise(opIdOf(Option.some(` ${given} `)))).toBe(given);
    for (const bad of ["", "op-01M5EW2K9M5CN3Z3VP1J5EFB0Y", "01M5EW2K9M5CN3Z3VP1J5EFB0", "not-a-ulid"]) {
      const result = await Effect.runPromise(opIdOf(Option.some(bad)).pipe(Effect.result));
      expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "InputError", path: "--op-id" } });
    }
  });

  it("reads the opId a write carries, and nothing from args without one", () => {
    expect(opIdInArgs({ opId: "01M5EW2K9M5CN3Z3VP1J5EFB0Y", task: "#4" })).toBe("01M5EW2K9M5CN3Z3VP1J5EFB0Y");
    for (const args of [undefined, null, "x", { target: "peer" }, { opId: "nope" }, { opId: 7 }]) {
      expect(opIdInArgs(args)).toBeUndefined();
    }
  });
});
