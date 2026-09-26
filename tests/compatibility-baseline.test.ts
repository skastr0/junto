import { describe, expect, it } from "vitest";
import { CURRENT_STATE_SCHEMA_VERSION, STATE_SCHEMA_MIGRATIONS } from "../src/main/junto/state/migrations";
import { CURRENT_STATION_PROTOCOL_SUPPORT } from "../src/shared/station-protocol";

describe("compatibility baseline authority", () => {
  it("keeps the Station protocol at the frozen 1/1/1 policy", () => {
    expect(CURRENT_STATION_PROTOCOL_SUPPORT).toEqual({
      preferred: 1,
      compatibleFrom: 1,
      warnBelow: 1,
    });
    expect(CURRENT_STATE_SCHEMA_VERSION).toBe(7);
    expect(STATE_SCHEMA_MIGRATIONS.map((step) => `${step.fromVersion}->${step.toVersion}`)).toEqual(["1->2", "2->3", "3->4", "4->5", "5->6", "6->7"]);
  });
});
