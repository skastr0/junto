import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Effect } from "effect";
import { expect, it, vi } from "vitest";
import { startCore } from "../src/main/junto/core";
import { AgentSignalRepository } from "../src/main/junto/signals/repository";
import { seatStateRuntime } from "../src/main/junto/term/agent-state/runtime";
import { termPlane } from "../src/main/junto/term/plane";

it("a windowless core puts a seat's open blocked signal on its snapshot, so the cut sees it waiting", async () => {
  const home = await mkdtemp(join(tmpdir(), "junto-core-reports-"));
  let core: Awaited<ReturnType<typeof startCore>> | undefined;
  const list = vi.spyOn(termPlane.host, "list");
  const reported = vi.spyOn(seatStateRuntime, "seatReported");
  try {
    core = await startCore({ home, build: "b".repeat(64), bundles: {} });
    list.mockReturnValue([
      { bindingId: "own-binding", epoch: "ep_1", canvasName: "rest", nodeId: "own-seat", status: "running" },
    ] as never);
    const signal = await core.runtime.runPromise(Effect.flatMap(AgentSignalRepository, (signals) =>
      signals.raise({ canvasName: "rest", nodeId: "own-seat", kind: "blocked", text: "need the API key" })));
    expect(reported).toHaveBeenCalledWith("own-binding", expect.objectContaining({ signalId: signal.signalId, kind: "blocked", open: true }));
  } finally {
    list.mockRestore();
    reported.mockRestore();
    await core?.close();
    await rm(home, { recursive: true, force: true });
  }
});
