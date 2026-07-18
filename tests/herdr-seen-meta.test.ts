import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearsPendingSeen,
  herdr$,
  herdrMetaPaintEqual,
  mergeHerdrMetaAfterRefresh,
  nextPendingSeen,
  refreshHerdrMeta,
  type HerdrMetaCache,
} from "../src/renderer/lib/herdr-state";
import type { EtherHerdr } from "../src/shared/canvas";
import type { HerdrPaneInfo } from "../src/shared/ipc";

const pane = (agentStatus: string, extra?: Partial<HerdrPaneInfo>): HerdrPaneInfo =>
  ({ paneId: "w1:p1", agentStatus, ...extra }) as HerdrPaneInfo;

const herdrOf = (paneId = "w1:p1"): EtherHerdr =>
  ({ host: "local", paneId, terminalId: "term_1" }) as EtherHerdr;

describe("mergeHerdrMetaAfterRefresh", () => {
  it("protects optimistic idle when seenGen advanced and remote still says done", () => {
    const previous: HerdrMetaCache = {
      status: "ok",
      meta: pane("idle"),
      seenGen: 2,
      fetchedAt: 100,
    };
    const merged = mergeHerdrMetaAfterRefresh(previous, 1, pane("done"));
    expect(merged.agentStatus).toBe("idle");
  });

  it("accepts remote done when no local mark-seen happened", () => {
    const previous: HerdrMetaCache = {
      status: "ok",
      meta: pane("working"),
      seenGen: 0,
    };
    const merged = mergeHerdrMetaAfterRefresh(previous, 0, pane("done"));
    expect(merged.agentStatus).toBe("done");
  });

  it("accepts remote working even after seenGen bump", () => {
    const previous: HerdrMetaCache = {
      status: "ok",
      meta: pane("idle"),
      seenGen: 3,
    };
    const merged = mergeHerdrMetaAfterRefresh(previous, 1, pane("working"));
    expect(merged.agentStatus).toBe("working");
  });

  it("protects idle under pendingSeen even when refresh starts after open", () => {
    // VL-030 residual: startSeenGen == nowGen (refresh began after mark-seen).
    const previous: HerdrMetaCache = {
      status: "ok",
      meta: pane("idle"),
      seenGen: 1,
      pendingSeen: true,
    };
    const merged = mergeHerdrMetaAfterRefresh(previous, 1, pane("done"));
    expect(merged.agentStatus).toBe("idle");
  });

  it("does not demote working|blocked to idle under pendingSeen + remote done", () => {
    const previous: HerdrMetaCache = {
      status: "ok",
      meta: pane("working"),
      seenGen: 1,
      pendingSeen: true,
    };
    const merged = mergeHerdrMetaAfterRefresh(previous, 1, pane("done"));
    expect(merged.agentStatus).toBe("working");
  });

  it("sticky-keeps prior agentStatus when remote omits it", () => {
    const previous: HerdrMetaCache = {
      status: "ok",
      meta: pane("idle", { agent: "codex", cwd: "/proj" }),
      seenGen: 0,
    };
    const remote = { paneId: "w1:p1", agent: "codex" } as HerdrPaneInfo;
    const merged = mergeHerdrMetaAfterRefresh(previous, 0, remote);
    expect(merged.agentStatus).toBe("idle");
    expect(merged.cwd).toBe("/proj");
  });

  it("sticky-keeps prior preview when remote omits it", () => {
    const previous: HerdrMetaCache = {
      status: "ok",
      meta: pane("idle", { preview: "last line" }),
      seenGen: 0,
    };
    const merged = mergeHerdrMetaAfterRefresh(previous, 0, pane("idle"));
    expect(merged.preview).toBe("last line");
  });

  it("holds stronger prior over remote unknown blips (no green↔steel thrash)", () => {
    const previous: HerdrMetaCache = {
      status: "ok",
      meta: pane("idle"),
      seenGen: 0,
    };
    const merged = mergeHerdrMetaAfterRefresh(previous, 0, pane("unknown"));
    expect(merged.agentStatus).toBe("idle");
  });

  it("accepts first remote unknown when there is no stronger prior", () => {
    const previous: HerdrMetaCache = {
      status: "ok",
      meta: { paneId: "w1:p1" } as HerdrPaneInfo,
      seenGen: 0,
    };
    const merged = mergeHerdrMetaAfterRefresh(previous, 0, pane("unknown"));
    expect(merged.agentStatus).toBe("unknown");
  });
});

describe("clearsPendingSeen", () => {
  it("clears on idle/working/blocked only", () => {
    expect(clearsPendingSeen("idle")).toBe(true);
    expect(clearsPendingSeen("working")).toBe(true);
    expect(clearsPendingSeen("blocked")).toBe(true);
    expect(clearsPendingSeen("done")).toBe(false);
    expect(clearsPendingSeen("unknown")).toBe(false);
    expect(clearsPendingSeen(undefined)).toBe(false);
  });
});

describe("herdrMetaPaintEqual", () => {
  it("is true for identical paint fields", () => {
    const a = pane("idle", { agent: "grok", cwd: "/x" });
    const b = pane("idle", { agent: "grok", cwd: "/x" });
    expect(herdrMetaPaintEqual(a, b)).toBe(true);
  });

  it("is false when agentStatus differs", () => {
    expect(herdrMetaPaintEqual(pane("idle"), pane("done"))).toBe(false);
  });
});

describe("nextPendingSeen composition", () => {
  it("keeps pendingSeen across remote done (protect cycle)", () => {
    const previous: HerdrMetaCache = {
      status: "ok",
      meta: pane("idle"),
      seenGen: 1,
      pendingSeen: true,
    };
    const remote = pane("done");
    const merged = mergeHerdrMetaAfterRefresh(previous, 1, remote);
    expect(merged.agentStatus).toBe("idle");
    // Gate must still hold — second remote done would still protect.
    expect(nextPendingSeen(previous.pendingSeen, remote.agentStatus)).toBe(true);
    const still = mergeHerdrMetaAfterRefresh(
      { ...previous, meta: merged, pendingSeen: true },
      1,
      pane("done"),
    );
    expect(still.agentStatus).toBe("idle");
  });

  it("clears pendingSeen only when remote is idle|working|blocked", () => {
    expect(nextPendingSeen(true, "idle")).toBe(false);
    expect(nextPendingSeen(true, "working")).toBe(false);
    expect(nextPendingSeen(true, "blocked")).toBe(false);
    expect(nextPendingSeen(true, "done")).toBe(true);
    expect(nextPendingSeen(true, "unknown")).toBe(true);
    expect(nextPendingSeen(true, undefined)).toBe(true);
  });
});

describe("refreshHerdrMeta coalesce", () => {
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
    herdr$.metaByNodeId.set({});
  });

  it("actually calls herdrGetMeta (slot registered before async body)", async () => {
    const getMeta = vi.fn(async () => ({
      ok: true as const,
      data: pane("working", { agent: "codex", cwd: "/proj" }),
    }));
    (globalThis as unknown as { window: { vellum: { herdrGetMeta: typeof getMeta } } }).window = {
      vellum: { herdrGetMeta: getMeta },
    };
    const nodeId = "n-coalesce-1";
    await refreshHerdrMeta(nodeId, herdrOf());
    expect(getMeta).toHaveBeenCalledTimes(1);
    expect(herdr$.metaByNodeId[nodeId].peek()?.meta?.agentStatus).toBe("working");
  });

  it("coalesces concurrent calls into one in-flight fetch + one rerun", async () => {
    let resolveFirst!: (v: { ok: true; data: HerdrPaneInfo }) => void;
    let calls = 0;
    const getMeta = vi.fn(
      () =>
        new Promise<{ ok: true; data: HerdrPaneInfo }>((resolve) => {
          calls += 1;
          if (calls === 1) {
            resolveFirst = resolve;
          } else {
            resolve({ ok: true, data: pane("idle", { agent: "codex" }) });
          }
        }),
    );
    (globalThis as unknown as { window: { vellum: { herdrGetMeta: typeof getMeta } } }).window = {
      vellum: { herdrGetMeta: getMeta },
    };
    const nodeId = "n-coalesce-2";
    const a = refreshHerdrMeta(nodeId, herdrOf());
    const b = refreshHerdrMeta(nodeId, herdrOf());
    // First still in-flight; second only sets rerun.
    expect(getMeta).toHaveBeenCalledTimes(1);
    resolveFirst!({ ok: true, data: pane("working", { agent: "codex" }) });
    await Promise.all([a, b]);
    // Rerun after first completes.
    expect(getMeta).toHaveBeenCalledTimes(2);
    expect(herdr$.metaByNodeId[nodeId].peek()?.meta?.agentStatus).toBe("idle");
  });

  it("holds pendingSeen across remote done through the real refresh path", async () => {
    const getMeta = vi.fn(async () => ({
      ok: true as const,
      data: pane("done", { agent: "codex" }),
    }));
    (globalThis as unknown as { window: { vellum: { herdrGetMeta: typeof getMeta } } }).window = {
      vellum: { herdrGetMeta: getMeta },
    };
    const nodeId = "n-pending-1";
    herdr$.metaByNodeId[nodeId].set({
      status: "ok",
      meta: pane("idle", { agent: "codex" }),
      seenGen: 1,
      pendingSeen: true,
    });
    await refreshHerdrMeta(nodeId, herdrOf());
    const cache = herdr$.metaByNodeId[nodeId].peek();
    expect(cache?.meta?.agentStatus).toBe("idle");
    expect(cache?.pendingSeen).toBe(true);
  });
});
