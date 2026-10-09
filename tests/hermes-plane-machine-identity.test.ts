import { Effect, Layer } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeThisMachine } from "../src/shared/remote-hosts";
import { setHostsSnapshot } from "../src/main/junto/hosts/snapshot";
import { HermesPlane, HermesPlaneLive } from "../src/main/junto/hermes/plane";
import { HermesTransport } from "../src/main/junto/hermes/transport";
import { THIS_MACHINE } from "./support/machines";

const PROFILE_TABLE = `
 Profile          Model                        Gateway      Alias
 ───────────────    ───────────────────────────    ─────────    ─────
 ◆default         gpt-5.5                      running      —
`;

const transportOf = (profiles: ReturnType<typeof vi.fn>) =>
  Layer.succeed(HermesTransport, HermesTransport.of({
    profiles: profiles as never,
    version: () => Effect.succeed({ ok: true, stdout: "Hermes Agent v0.18.2" }),
    connectAcp: () => Effect.die("unexpected ACP connection"),
  }));

const withPlane = <A>(profiles: ReturnType<typeof vi.fn>, use: (plane: typeof HermesPlane.Service) => Promise<A>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const plane = yield* HermesPlane;
      return yield* Effect.promise(() => use(plane));
    }).pipe(Effect.provide(Layer.provide(HermesPlaneLive, transportOf(profiles))), Effect.scoped),
  );

afterEach(() => {
  setHostsSnapshot([]);
});

describe("HermesPlane machine identity", () => {
  it("reads this machine from the machine list at each fetch, so a changed row wins", async () => {
    setHostsSnapshot([makeThisMachine(THIS_MACHINE, { hermesId: "fleet-old" })]);
    const profiles = vi.fn(() => Effect.succeed({ ok: true, stdout: PROFILE_TABLE }));

    const result = await withPlane(profiles, async (plane) => {
      // The row changes after the plane is built and before it is asked.
      setHostsSnapshot([makeThisMachine(THIS_MACHINE, { hermesId: "fleet-new" })]);
      return plane.fetchBundle();
    });

    expect(result.entities.map((entity) => entity.key)).toEqual(["fleet-new:default"]);
    expect(profiles).toHaveBeenCalledWith("fleet-new");
  });

  it("does not start before the machine list names this machine", async () => {
    setHostsSnapshot([]);
    const profiles = vi.fn(() => Effect.succeed({ ok: true, stdout: PROFILE_TABLE }));

    await expect(withPlane(profiles, (plane) => plane.fetchBundle())).rejects.toThrow(
      /not hydrated in the host registry/,
    );
    expect(profiles).not.toHaveBeenCalled();
  });
});
