import { describe, expect, it } from "vitest";
import { liveAgentGenerationToReuse } from "../src/main/vellum/term/router";
import type { TerminalSessionSummary } from "../src/shared/terminal";

const live = (
  overrides: Partial<TerminalSessionSummary> = {},
): TerminalSessionSummary => ({
  bindingId: "seat",
  epoch: "e1",
  hostId: "remote-a",
  status: "running",
  detached: false,
  ...overrides,
});

describe("liveAgentGenerationToReuse", () => {
  it("reuses a running or starting Remote generation", () => {
    expect(liveAgentGenerationToReuse(live())).toEqual(live());
    expect(liveAgentGenerationToReuse(live({ status: "starting" }))?.status).toBe(
      "starting",
    );
  });

  it("does not reuse exited, missing, or stopping generations", () => {
    expect(liveAgentGenerationToReuse(undefined)).toBeUndefined();
    expect(liveAgentGenerationToReuse(live({ status: "exited" }))).toBeUndefined();
    expect(liveAgentGenerationToReuse(live({ status: "missing" }))).toBeUndefined();
    expect(
      liveAgentGenerationToReuse(live({ stopping: true })),
    ).toBeUndefined();
  });
});
