import { beforeEach, expect, it } from "vitest";
import { applyMachineProgress, machines$ } from "../src/renderer/lib/machines-actions";

beforeEach(() => { machines$.copies.set({
  mini: { kind: "running", op: "update", id: "copy-mini", steps: [] },
  linux: { kind: "running", op: "send", id: "copy-linux", steps: [] },
}); });

it("keeps monotonic copy counts on the matching command and permits stall resumption", () => {
  const event = { event: "machine-copy" as const, copiedBytes: 25, totalBytes: 69, state: "copying" as const };
  applyMachineProgress({ id: "unknown", event });
  expect(machines$.copies.mini.peek()?.transfer).toBeUndefined();
  applyMachineProgress({ id: "copy-mini", event });
  applyMachineProgress({ id: "copy-mini", event: { ...event, copiedBytes: 10 } });
  applyMachineProgress({ id: "copy-mini", event: { ...event, totalBytes: 100 } });
  expect(machines$.copies.mini.peek()?.transfer).toEqual(event);
  expect(machines$.copies.linux.peek()?.transfer).toBeUndefined();
  applyMachineProgress({ id: "copy-mini", event: { ...event, state: "stalled" } });
  applyMachineProgress({ id: "copy-mini", event: { ...event, copiedBytes: 26 } });
  expect(machines$.copies.mini.peek()?.transfer).toMatchObject({ copiedBytes: 26, state: "copying" });
});

it("does not reopen copying after installation starts", () => {
  applyMachineProgress({ id: "copy-mini", event: { event: "machine-install", juntoHome: "/home/op", installRoot: "/home/op/install", step: "verified" } });
  applyMachineProgress({ id: "copy-mini", event: { event: "machine-copy", copiedBytes: 25, totalBytes: 69, state: "stalled" } });
  expect(machines$.copies.mini.peek()?.transfer).toBeUndefined();
});
