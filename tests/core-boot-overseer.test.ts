import { mkdtemp, rm } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { startCore } from "../src/main/junto/core";
import type { OverseerPages } from "../src/main/junto/overseer/pages";

// The core starts once per process, so the desktop core's overseer is its own file.
it("composes the overseer and the live overseer in the core, on the page port it is given, and lets them go on close", async () => {
  const home = await mkdtemp("/tmp/junto-core-");
  const beginDelete = vi.fn();
  const finishDelete = vi.fn();
  const pages = {
    deleteSessionsForRef: async () => [],
    beginDelete,
    finishDelete,
  } as unknown as OverseerPages;
  let core: Awaited<ReturnType<typeof startCore>> | undefined;
  try {
    core = await startCore({
      home,
      build: "c".repeat(64),
      bundles: {},
      overseer: { captureApplicationPage: async () => ({ ok: false, unavailable: true, reason: "no window" }), pages },
      overseerLive: true,
    });
    // The live overseer is composed in the core too, and answers there.
    expect(await core.overseerLive!.liveSnapshot()).toBeDefined();
    const prepared = await core.overseer!.native.prepareOverseerNodeDelete([{ kind: "page", canvasName: "factory", nodeId: "p1" }]);
    expect(prepared.ok).toBe(true);
    expect(beginDelete).toHaveBeenCalledWith("junto://canvas/factory?node=p1", expect.stringMatching(/^odl-/u));
    if (prepared.ok) core.overseer!.native.finishOverseerNodeDelete(prepared.leaseId, "aborted");
    expect(finishDelete).toHaveBeenCalledTimes(1);
    await core.close();
  } finally {
    await core?.close();
    await rm(home, { recursive: true, force: true });
  }
});
