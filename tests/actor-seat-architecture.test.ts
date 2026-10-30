import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (relative: string): string =>
  readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");

describe("actor seat production architecture", () => {
  it("roots expose the actor WHEN without exposing a process HOW", () => {
    for (const path of ["src/main/core-product.ts"]) {
      const root = source(path);
      expect(root, path).toContain("ActorSeatOccupyLive");
      expect(root, path).toMatch(
        /Layer\.provideMerge\(\s*ActorSeatOccupyLive,\s*(?:BaseWithPauseLive|pause),?\s*\)/u,
      );
      expect(root, path).not.toContain("TerminalSeatProcess");
    }
    // The core's runtime builds the machine core layer; main's runtime is Electron's
    // alone and must not build a second copy of it.
    expect(source("src/main/core-runtime.ts")).toContain("makeMachineCoreLayer");
    expect(source("src/main/runtime.ts")).not.toContain("makeMachineCoreLayer");
    for (const path of ["src/main/runtime.ts", "src/main/core-runtime.ts"]) {
      expect(source(path), path).not.toContain("TerminalSeatProcess");
    }
    expect(source("src/main/core-runtime.ts")).toContain("makeCoreProductLayer(options.home)");
  });

  it("keeps mutable machine identity and the seats link client in the live adapter", () => {
    const live = source(
      "src/main/junto/term/actor-seat-occupy-live.ts",
    );

    expect(live).toContain("const installation = yield* MachineRepository");
    expect(live).toContain("localHostId: () =>");
    expect(live).toContain("installation.machineName.pipe(");
    expect(live).toContain("makeSeatsProcessClient(hostId)");
    expect(live).not.toContain("termPlane.router.clientForOccupy");
    expect(live).not.toContain("router.isLocalHostId");
  });

  it("compiles spawn intent before placement and finalizes only on the process host", () => {
    // The window's and the owner commands' agent seat start (seat-control.ts).
    const ipc = source("src/main/junto/term/seat-control.ts");
    const ensure = source("src/main/junto/term/ensure-managed-seat.ts");
    const process = source("src/main/junto/term/seat-process.ts");
    const server = source("src/main/junto/term/control-server.ts");
    const host = source("src/main/junto/term/local-host.ts");
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
      "export const TERM_CONTROL_PROTOCOL = remoteStationContractVersion(",
    );
    expect(wire).not.toContain("STATION_PROTOCOL_BASELINE");
  });

  it("starts an overseer's seat the way every start does, never on a spawn intent of its own", () => {
    const native = source("src/main/junto/overseer/native.ts");
    const composition = source("src/main/junto/overseer/composition.ts");

    for (const [path, text] of [["native.ts", native], ["composition.ts", composition]] as const) {
      expect(text, path).not.toContain("makeManagedSpawnIntent");
      expect(text, path).not.toContain("actorSeatOccupy.occupy(");
    }
    expect(composition).toContain("startSeat({ canvas: asCanvasName(seat.canvasName), seatId: asNodeId(seat.nodeId) }");
    // Both the dispatch grant and the live execution start through it.
    expect(composition.match(/startOverseerSeat\(/gu)).toHaveLength(2);
  });

  it("routes every managed wake through ActorSeatOccupy", () => {
    const ensure = source("src/main/junto/term/ensure-managed-seat.ts");
    const kernel = source("src/main/junto/kernel/service.ts");

    expect(ensure).toContain("actorSeatOccupy.occupy(spec)");
    expect(ensure).not.toContain("termPlane.host.createAgentSeat");
    // The kernel starts a seat only when a delivery asks for it.
    expect(kernel.match(/yield\* ensureManagedSeatRunning\(/gu)).toHaveLength(1);
    expect(kernel).not.toContain("startManagedSeats");
    expect(kernel).toContain("const actorSeatOccupy = yield* ActorSeatOccupy");
    expect(kernel).not.toMatch(
      /import\s+\{[^}]*\bAppRuntime\b[^}]*\}\s+from/u,
    );
  });
});
