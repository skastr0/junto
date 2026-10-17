import { Effect, Logger, ManagedRuntime } from "effect";
import { expect, it } from "vitest";
import { discardStaged } from "../src/main/junto/credentials/coordinator";
import { ObservabilityEffectLogger } from "../src/main/junto/observability/logger";
import { observabilityRing } from "../src/main/junto/observability/ring";

it("logs a staged rollback that fails, scrubbed, and keeps going", async () => {
  observabilityRing.clear();
  const deleted: string[] = [];
  const store = {
    delete: (id: string) => {
      if (id.endsWith("1")) throw new Error(`could not remove /vault/${id}: token=sk-live-0123456789abcdef0123`);
      deleted.push(id);
    },
  } as never;
  const staged = [{ credentialId: "00000000-0000-4000-8000-000000000001" }, { credentialId: "00000000-0000-4000-8000-000000000002" }] as never;
  const runtime = ManagedRuntime.make(Logger.layer([ObservabilityEffectLogger]));
  try {
    await runtime.runPromise(discardStaged(store, staged));
    expect(deleted).toEqual(["00000000-0000-4000-8000-000000000002"]);
    const rows = observabilityRing.query({ q: "rolled back", limit: 5 }).entries;
    expect(rows).toHaveLength(1);
    const text = JSON.stringify(rows[0]);
    expect(text).not.toContain("sk-live");
    expect(text).not.toContain("00000000-0000-4000-8000-000000000001");
  } finally {
    await runtime.dispose();
    observabilityRing.clear();
  }
});
