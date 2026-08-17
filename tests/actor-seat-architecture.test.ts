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
