import { expect, it } from "vitest";
import { makeCopyProgress } from "../src/main/junto/hosts/copy-progress";
import type { MachineCopyProgress } from "../src/shared/machine-progress";

it("reports bounded byte progress, a 30-second stall, resumption and completion", () => {
  const seen: MachineCopyProgress[] = [];
  const progress = makeCopyProgress(100, 1000, event => seen.push(event));
  progress.advance(10, 1100);
  progress.advance(15, 1300);
  expect(seen.map(event => event.copiedBytes)).toEqual([0, 25]);
  progress.check(31_299);
  expect(seen.at(-1)?.state).toBe("copying");
  progress.check(31_300);
  progress.check(40_000);
  expect(seen.at(-1)).toMatchObject({ state: "stalled", copiedBytes: 25 });
  expect(seen).toHaveLength(3);
  progress.advance(10, 40_001);
  expect(seen.at(-1)).toMatchObject({ state: "copying", copiedBytes: 35 });
  progress.advance(65, 40_002);
  progress.check(100_000);
  expect(seen.at(-1)).toMatchObject({ state: "copied", copiedBytes: 100, totalBytes: 100 });
  expect(seen).toHaveLength(5);
});

it("does not let a detached observer interrupt copying", () => {
  const progress = makeCopyProgress(100, 0, () => { throw new Error("closed window"); });
  expect(() => { progress.check(30_000); progress.advance(100, 30_001); }).not.toThrow();
});
