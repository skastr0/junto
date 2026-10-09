import { expect, it } from "vitest";
import { makeDownloadProgress } from "../src/main/junto/hosts/download-progress";
import type { MachineDownloadProgress } from "../src/shared/machine-progress";

it("reports byte movement, a stall and recovery, but waits for admission before completion", () => {
  const seen: MachineDownloadProgress[] = [];
  const progress = makeDownloadProgress(100, 1000, event => seen.push(event));
  progress.advance(25, 1300); progress.check(31_299);
  expect(seen.at(-1)).toMatchObject({ state: "downloading", downloadedBytes: 25 });
  progress.check(31_300); progress.check(40_000);
  expect(seen.at(-1)).toMatchObject({ state: "stalled", downloadedBytes: 25 });
  expect(seen).toHaveLength(3);
  progress.advance(35, 40_001);
  expect(seen.at(-1)).toMatchObject({ state: "downloading", downloadedBytes: 35 });
  progress.finish(40_002); expect(seen.at(-1)?.state).toBe("downloading");
  progress.advance(100, 40_003); progress.check(100_000);
  expect(seen.at(-1)).toMatchObject({ state: "downloading", downloadedBytes: 100 });
  progress.finish(100_001); progress.finish(100_002);
  expect(seen.at(-1)).toMatchObject({ state: "downloaded", downloadedBytes: 100 });
  expect(seen).toHaveLength(6);
});

it("keeps a detached progress observer from interrupting acquisition", () => {
  const progress = makeDownloadProgress(100, 0, () => { throw new Error("closed"); });
  expect(() => { progress.check(30_000); progress.advance(100, 30_001); progress.finish(30_002); }).not.toThrow();
});
