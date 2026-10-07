import type { SqlClient } from "effect/unstable/sql";
import { describe, expect, it } from "vitest";
import { workProjectionChanges } from "../src/main/junto/work/projection-changes";

describe("work projection change dispatch", () => {
  it("defers replacement subscriptions to the next committed change", () => {
    // The stream uses the SQL client only as an installation identity.
    const changes = workProjectionChanges({} as SqlClient.SqlClient);
    let calls = 0;
    let off: () => void = () => undefined;
    const listener = () => {
      calls += 1;
      off();
      // Cap the old loop so a failure cannot hang the test runner.
      if (calls < 10) off = changes.subscribe(listener);
    };
    off = changes.subscribe(listener);
    try {
      changes.notify({ canvasName: "workspace", nodeId: "peer" });
      expect(calls).toBe(1);
      changes.notify({ canvasName: "workspace", nodeId: "peer" });
      expect(calls).toBe(2);
    } finally {
      off();
    }
  });
});
