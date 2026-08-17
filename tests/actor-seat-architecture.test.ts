import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (relative: string): string =>
  readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");

describe("actor seat production architecture", () => {
  it("roots expose the actor WHEN without exposing a process HOW", () => {
    for (const path of ["src/main/runtime.ts", "src/main/remote-runtime.ts"]) {
      const root = source(path);
      expect(root, path).toContain("ActorSeatOccupyLive");
      expect(root, path).toMatch(
        /Layer\.provideMerge\(\s*ActorSeatOccupyLive,\s*BaseWithPauseLive,\s*\)/u,
      );
      expect(root, path).not.toContain("TerminalSeatProcess");
    }
  });

  it("keeps mutable station identity and router glue in the live adapter", () => {
    const live = source(
      "src/main/vellum/term/actor-seat-occupy-live.ts",
    );

    expect(live).toContain("const station = yield* StationRepository");
    expect(live).toContain("localHostId: () =>");
    expect(live).toContain("station.configuration.pipe(");
    expect(live).toContain("termPlane.router.clientForOccupy(hostId)");
    expect(live).not.toContain("router.isLocalHostId");
  });

  it("compiles spawn intent before placement and finalizes only on the process host", () => {
    const ipc = source("src/main/vellum/term/ipc.ts");
    const ensure = source("src/main/vellum/term/ensure-managed-seat.ts");
    const process = source("src/main/vellum/term/seat-process.ts");
    const server = source("src/main/vellum/term/control-server.ts");
    const host = source("src/main/vellum/term/local-host.ts");
    const wire = source("src/shared/term-control.ts");

    expect(ipc).toContain("makeManagedSpawnIntent");
    expect(ipc).not.toContain("launchForManagedSpawn(");
    expect(ensure).toContain("makeManagedSpawnIntent");
    expect(ensure).not.toContain("launchForManagedSpawn(");
    expect(process).toContain("launchForManagedSpawnIntent(spec, spec.spawnIntent)");
    expect(process).toContain("resumeFallbackIntent: spec.spawnIntent");
    const vacancyGuard = server.indexOf(
      'hostAdmission._tag !== "OccupyVacantSeat"',
    );
    const finalization = server.indexOf(
      "const finalized = launchForManagedSpawnIntent(",
    );
    expect(vacancyGuard).toBeGreaterThanOrEqual(0);
    expect(finalization).toBeGreaterThanOrEqual(0);
    expect(vacancyGuard).toBeLessThan(finalization);
    expect(host).toContain("planFreshManagedSpawnIntent(");
    expect(host).toContain("seed.resumeFallbackIntent");
    expect(server).toContain("decodeTermControlActorSeatRequest(req)");
    expect(server).toContain('actorReq.admission === "activate"');
    expect(server).toContain("existing.epoch !== expectedEpoch");
    expect(wire).toContain(
      "export const TERM_CONTROL_PROTOCOL = STATION_PROTOCOL_BASELINE",
    );
  });

  it("routes every managed wake through ActorSeatOccupy", () => {
    const ensure = source("src/main/vellum/term/ensure-managed-seat.ts");
    const kernel = source("src/main/vellum/kernel/service.ts");

    expect(ensure).toContain("actorSeatOccupy.occupy(spec)");
    expect(ensure).not.toContain("termPlane.host.createAgentSeat");
    expect(kernel.match(/yield\* ensureManagedSeatRunning\(/gu)).toHaveLength(3);
    expect(kernel).toContain("yield* startManagedSeats(");
    expect(kernel).toContain(
      "if (!running || !generationIsActive(generation)) continue;",
    );
    expect(kernel).toContain("const actorSeatOccupy = yield* ActorSeatOccupy");
    expect(kernel).not.toMatch(
      /import\s+\{[^}]*\bAppRuntime\b[^}]*\}\s+from/u,
    );
  });
});
