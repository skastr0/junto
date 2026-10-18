import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { startCore } from "../src/main/junto/core";
import { KernelService } from "../src/main/junto/kernel/service";
import { setOperatorOffboard, type OperatorOffboard } from "../src/main/junto/seat-sessions/operator-offboard";

it("a wake that keeps its session is not cut first; any other wake asks for the cut", async () => {
  const home = await mkdtemp(join(tmpdir(), "junto-core-wake-"));
  let core: Awaited<ReturnType<typeof startCore>> | undefined;
  try {
    core = await startCore({ home, build: "b".repeat(64), bundles: {} });
    const asked: string[] = [];
    // Only the wake cut is asked here.
    setOperatorOffboard({
      beforeWake: async (seat: { readonly seatId: string }) => {
        asked.push(seat.seatId);
        return false;
      },
    } as unknown as OperatorOffboard);
    const wake = (options?: { readonly keepSession?: boolean }) =>
      core!.runtime.runPromise(Effect.flatMap(KernelService, (kernel) =>
        Effect.promise(() => kernel.wakeManagedSeat("rest", "no-seat", options))));
    // No such seat: the wake refuses after the cut is asked, and starts nothing.
    expect(await wake({ keepSession: true })).toBe(false);
    expect(asked).toEqual([]);
    expect(await wake()).toBe(false);
    expect(asked).toEqual(["no-seat"]);
  } finally {
    setOperatorOffboard(undefined);
    await core?.close();
    await rm(home, { recursive: true, force: true });
  }
});
