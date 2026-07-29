import { describe, expect, it } from "vitest";

import { automaticManagedSeatDisposition } from "../src/main/vellum/term/ensure-managed-seat";

describe("automatic managed-seat generation policy", () => {
  it("creates only the initial generation", () => {
    expect(automaticManagedSeatDisposition(undefined)).toBe(
      "create-initial-generation",
    );
  });

  it("reuses a live generation for factory injection", () => {
    expect(automaticManagedSeatDisposition("starting")).toBe(
      "reuse-live-generation",
    );
    expect(automaticManagedSeatDisposition("running")).toBe(
      "reuse-live-generation",
    );
  });

  it("never turns an exited generation into an automatic restart loop", () => {
    expect(automaticManagedSeatDisposition("exited")).toBe(
      "require-explicit-restart",
    );
    expect(automaticManagedSeatDisposition("missing")).toBe(
      "require-explicit-restart",
    );
  });
});
