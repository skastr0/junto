import { describe, expect, it } from "vitest";
import {
  OBSERVABILITY_RING_CAPACITY,
  matchesObservabilityQuery,
  type ObservabilityLogEntry,
} from "../src/shared/observability";
import { makeObservabilityRing } from "../src/main/vellum/observability/ring";

const entry = (
  partial: Partial<ObservabilityLogEntry> & Pick<ObservabilityLogEntry, "message">,
): ObservabilityLogEntry => ({
  id: partial.id ?? 1,
  ts: partial.ts ?? 1_700_000_000_000,
  level: partial.level ?? "info",
  source: partial.source ?? "effect",
  message: partial.message,
  ...(partial.fiber ? { fiber: partial.fiber } : {}),
  ...(partial.spans ? { spans: partial.spans } : {}),
  ...(partial.annotations ? { annotations: partial.annotations } : {}),
});

describe("observability ring", () => {
  it("appends, orders, and respects capacity", () => {
    const ring = makeObservabilityRing(3);
    ring.append({ level: "info", source: "main", message: "a" });
    ring.append({ level: "warn", source: "main", message: "b" });
    ring.append({ level: "error", source: "main", message: "c" });
    ring.append({ level: "info", source: "main", message: "d" });

    const snap = ring.query({ limit: 10 });
    expect(snap.capacity).toBe(3);
    expect(snap.total).toBe(3);
    expect(snap.dropped).toBe(1);
    expect(snap.entries.map((e) => e.message)).toEqual(["b", "c", "d"]);
    expect(snap.newestId).toBe(4);
  });

  it("filters by level, source, and query string", () => {
    const ring = makeObservabilityRing(50);
    ring.append({ level: "info", source: "effect", message: "claim tick" });
    ring.append({
      level: "error",
      source: "main",
      message: "ssh failed",
      annotations: { host: "remote-a" },
    });
    ring.append({ level: "warn", source: "renderer", message: "layout thrash" });

    const errors = ring.query({ levels: ["error"], limit: 20 });
    expect(errors.entries).toHaveLength(1);
    expect(errors.entries[0]?.message).toBe("ssh failed");

    const ssh = ring.query({ q: "remote-a", limit: 20 });
    expect(ssh.entries).toHaveLength(1);

    const after = ring.query({ afterId: 1, limit: 20 });
    expect(after.entries.map((e) => e.id)).toEqual([2, 3]);
  });

  it("notifies subscribers and clears", () => {
    const ring = makeObservabilityRing(10);
    const seen: string[] = [];
    const unsub = ring.subscribe((e) => {
      seen.push(e.message);
    });
    ring.append({ level: "info", source: "system", message: "boot" });
    expect(seen).toEqual(["boot"]);
    unsub();
    ring.append({ level: "info", source: "system", message: "ignored" });
    expect(seen).toEqual(["boot"]);
    ring.clear();
    const snap = ring.query();
    expect(snap.total).toBe(0);
    expect(snap.entries).toEqual([]);
  });

  it("matchesObservabilityQuery is pure and shared", () => {
    const e = entry({
      message: "Station fleet resolve",
      source: "effect",
      level: "debug",
      spans: ["station.fleet.resolve-route"],
    });
    expect(matchesObservabilityQuery(e, { q: "resolve-route" })).toBe(true);
    expect(matchesObservabilityQuery(e, { levels: ["error"] })).toBe(false);
    expect(OBSERVABILITY_RING_CAPACITY).toBeGreaterThan(100);
  });
});
