import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { RELEASE_CAPABILITIES } from "../src/shared/release-capabilities";
import { makeBoxFleetService } from "../src/main/vellum/box/service";

/**
 * Unmocked production freeze: Box fleet mutations never touch the provider CLI.
 */
describe("production Box fleet freeze (unmocked RELEASE_CAPABILITIES)", () => {
  it("keeps boxFleet off in production defaults", () => {
    expect(RELEASE_CAPABILITIES.boxFleet).toBe(false);
  });

  it("availability is synthetic and create never calls CLI", async () => {
    const create = vi.fn(() =>
      Effect.die(new Error("cli create must not run")),
    );
    let availabilityReads = 0;
    const cli = {
      get availability() {
        availabilityReads += 1;
        return Effect.succeed({
          available: true,
          authenticated: true,
          healthy: true,
          detail: "should not be read",
        });
      },
      create,
    } as never;
    const ownership = {
      list: Effect.succeed([]),
    } as never;

    const service = makeBoxFleetService(cli, ownership);
    const status = await Effect.runPromise(service.availability);
    expect(status.available).toBe(false);
    expect(status.detail).toMatch(/Box fleet provisioning is not available/i);
    expect(availabilityReads).toBe(0);

    const created = await Effect.runPromise(
      service.create().pipe(Effect.result),
    );
    expect(created._tag).toBe("Left");
    if (created._tag === "Failure") {
      expect(JSON.stringify(created.left)).toMatch(
        /Box fleet|not available/i,
      );
    }
    expect(create).not.toHaveBeenCalled();
  });

  it("ensureHostAvailable is a no-op without CLI", async () => {
    const info = vi.fn(() => Effect.die(new Error("cli info must not run")));
    let ownershipLookups = 0;
    const cli = { info } as never;
    const ownership = {
      findOwnedByHostId: () => {
        ownershipLookups += 1;
        return Effect.succeed(undefined);
      },
    } as never;

    const service = makeBoxFleetService(cli, ownership);
    const result = await Effect.runPromise(
      service.ensureHostAvailable("box-abcdefgh"),
    );
    expect(result).toBeUndefined();
    expect(info).not.toHaveBeenCalled();
    // Freeze short-circuits before ownership lookup / resume.
    expect(ownershipLookups).toBe(0);
  });
});
