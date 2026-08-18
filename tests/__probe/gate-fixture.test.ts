/**
 * THROWAWAY — decision-gate fixture builder. Guarded by GATE_PROBE=1 so a
 * normal `bun run test` skips it entirely. Delete after the gate.
 */
import { describe, it } from "vitest";
import { ensureSyntheticFixture, type ScaleSpec } from "../scale-bench/fixture";
import { SPEC_5000 } from "./gate-specs";

const enabled = process.env.GATE_PROBE === "1";

describe.skipIf(!enabled)("gate fixture", () => {
  it(
    "builds the 5000-node fixture",
    async () => {
      const spec: ScaleSpec = SPEC_5000;
      const started = Date.now();
      const fixture = await ensureSyntheticFixture(spec, {
        log: (line) => console.log(`${new Date().toISOString()} ${line}`),
      });
      console.log(
        JSON.stringify({ built: fixture.root, ms: Date.now() - started }),
      );
    },
    6 * 60 * 60_000,
  );
});
