import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { warmPoolEvictions } from "../src/shared/browser";
import { makeBrowserProfileService } from "../src/main/vellum/browser/profiles";
import {
  BrowserSessionService,
  type BrowserViewAdapter,
  type BrowserViewEvents,
  type BrowserViewHandle,
} from "../src/main/vellum/browser/sessions";

describe("warmPoolEvictions (pure)", () => {
  const entry = (key: string, attached: boolean, lastActiveAt: number) => ({
    key,
    attached,
    lastActiveAt,
  });

  it("evicts nothing while the pool fits", () => {
    expect(warmPoolEvictions([entry("a", false, 1)], "b", 3)).toEqual([]);
  });

  it("evicts nothing on reuse of an existing key", () => {
    const pool = [entry("a", false, 1), entry("b", false, 2), entry("c", false, 3)];
    expect(warmPoolEvictions(pool, "a", 3)).toEqual([]);
  });

  it("evicts the least-recently-active detached session first", () => {
    const pool = [entry("a", false, 5), entry("b", false, 1), entry("c", false, 3)];
    expect(warmPoolEvictions(pool, "d", 3)).toEqual(["b"]);
  });

  it("never evicts an attached session", () => {
    const pool = [entry("a", true, 1), entry("b", true, 2), entry("c", false, 3)];
    expect(warmPoolEvictions(pool, "d", 3)).toEqual(["c"]);
  });

  it("returns fewer evictions than needed when only attached sessions remain", () => {
    const pool = [entry("a", true, 1), entry("b", true, 2), entry("c", true, 3)];
    expect(warmPoolEvictions(pool, "d", 3)).toEqual([]);
  });
});

// --- service with spy adapter -------------------------------------------------

interface SpyView {
  readonly partition: string;
  readonly events: BrowserViewEvents;
  readonly calls: string[];
  destroyed: boolean;
}

const makeSpyAdapter = () => {
  const views: SpyView[] = [];
  const adapter: BrowserViewAdapter = (partition, events) => {
    const spy: SpyView = { partition, events, calls: [], destroyed: false };
    views.push(spy);
    const handle: BrowserViewHandle = {
      loadUrl: (url) => spy.calls.push(`load:${url}`),
      attach: () => spy.calls.push("attach"),
      setBounds: () => spy.calls.push("bounds"),
      detach: () => spy.calls.push("detach"),
      destroy: () => {
        spy.destroyed = true;
        spy.calls.push("destroy");
      },
    };
    return handle;
  };
  return { adapter, views };
};

describe("BrowserSessionService", () => {
  let root: string;
  let clock = 0;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "vellum-browser-sessions-"));
    clock = 0;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const makeService = () => {
    const { adapter, views } = makeSpyAdapter();
    const service = new BrowserSessionService(
      adapter,
      makeBrowserProfileService(root),
      () => ++clock,
    );
    return { service, views };
  };

  const bounds = { x: 0, y: 0, width: 800, height: 600 };

  it("open loads the URL in a view on the profile's persist: partition", async () => {
    const { service, views } = makeService();
    const res = await service.open({ nodeId: "n1", url: "https://example.com", profile: "personal" });
    expect(res.ok).toBe(true);
    expect(views).toHaveLength(1);
    expect(views[0]!.partition).toBe("persist:vellum-profile-personal");
    expect(views[0]!.calls).toContain("load:https://example.com");
  });

  it("rejects file:, javascript:, and data: urls at the service boundary", async () => {
    const { service, views } = makeService();
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "data:text/html,hi"]) {
      const res = await service.open({ nodeId: "n1", url, profile: "personal" });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.code).toBe("forbidden");
    }
    expect(views).toHaveLength(0);
  });

  it("rejects unknown profiles", async () => {
    const { service } = makeService();
    const res = await service.open({ nodeId: "n1", url: "https://example.com", profile: "nope" });
    expect(res.ok).toBe(false);
  });

  it("close detaches the surface but keeps the session warm (no destroy)", async () => {
    const { service, views } = makeService();
    await service.open({ nodeId: "n1", url: "https://example.com", profile: "personal" });
    service.setBounds("n1", bounds);
    expect(views[0]!.calls).toContain("attach");
    const closed = service.close("n1");
    expect(closed.ok && closed.data.state).toBe("detached");
    expect(views[0]!.calls).toContain("detach");
    expect(views[0]!.destroyed).toBe(false);
    // session survives — reopen reuses the same view, no new view created
    const reopened = await service.open({ nodeId: "n1", url: "https://example.com", profile: "personal" });
    expect(reopened.ok).toBe(true);
    expect(views).toHaveLength(1);
  });

  it("enforces maxWarmSessions by evicting the least-recent detached session", async () => {
    const { service, views } = makeService();
    // default config maxWarmSessions = 3
    await service.open({ nodeId: "n1", url: "https://a.com", profile: "personal" });
    await service.open({ nodeId: "n2", url: "https://b.com", profile: "personal" });
    await service.open({ nodeId: "n3", url: "https://c.com", profile: "personal" });
    // n2 is attached; n1 is the oldest detached -> evicted
    service.setBounds("n2", bounds);
    const res = await service.open({ nodeId: "n4", url: "https://d.com", profile: "personal" });
    expect(res.ok).toBe(true);
    expect(views[0]!.destroyed).toBe(true); // n1
    expect(views[1]!.destroyed).toBe(false); // n2 attached, never evicted
    const list = service.list();
    expect(list.ok && list.data.map((s) => s.nodeId).sort()).toEqual(["n2", "n3", "n4"]);
  });

  it("never evicts an attached session even when the pool overflows", async () => {
    const { service, views } = makeService();
    await service.open({ nodeId: "n1", url: "https://a.com", profile: "personal" });
    await service.open({ nodeId: "n2", url: "https://b.com", profile: "personal" });
    await service.open({ nodeId: "n3", url: "https://c.com", profile: "personal" });
    service.setBounds("n1", bounds);
    service.setBounds("n2", bounds);
    service.setBounds("n3", bounds);
    await service.open({ nodeId: "n4", url: "https://d.com", profile: "personal" });
    expect(views.filter((v) => v.destroyed)).toHaveLength(0);
  });

  it("refuses a silent profile switch on a warm session", async () => {
    const { service } = makeService();
    await service.open({ nodeId: "n1", url: "https://a.com", profile: "personal" });
    const res = await service.open({ nodeId: "n1", url: "https://a.com", profile: "work" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("invalid");
  });

  it("tracks load lifecycle through the shared state machine", async () => {
    const { service, views } = makeService();
    await service.open({ nodeId: "n1", url: "https://a.com", profile: "personal" });
    views[0]!.events.onLoadOk("Example");
    const state = service.state("n1");
    expect(state.ok && state.data?.state).toBe("ready");
    expect(state.ok && state.data?.title).toBe("Example");
    views[0]!.events.onLoadFail("net::ERR");
    const failed = service.state("n1");
    expect(failed.ok && failed.data?.state).toBe("failed");
  });

  it("pushes session changes to the sink", async () => {
    const { service, views } = makeService();
    const events: string[] = [];
    service.setSink((s) => events.push(`${s.nodeId}:${s.state}`));
    await service.open({ nodeId: "n1", url: "https://a.com", profile: "personal" });
    views[0]!.events.onLoadOk("t");
    service.close("n1");
    expect(events).toContain("n1:loading");
    expect(events).toContain("n1:ready");
    expect(events).toContain("n1:detached");
  });

  it("detachAllOnQuit detaches every view and destroys none", async () => {
    const { service, views } = makeService();
    await service.open({ nodeId: "n1", url: "https://a.com", profile: "personal" });
    await service.open({ nodeId: "n2", url: "https://b.com", profile: "personal" });
    service.setBounds("n1", bounds);
    service.detachAllOnQuit("test");
    expect(views[0]!.calls).toContain("detach");
    expect(views.filter((v) => v.destroyed)).toHaveLength(0);
    const list = service.list();
    expect(list.ok && list.data.every((s) => !s.attached)).toBe(true);
  });

  it("lists profiles with the default flagged", async () => {
    const { service } = makeService();
    const res = await service.listProfiles();
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.map((p) => p.id).sort()).toEqual(["personal", "work"]);
      expect(res.data.find((p) => p.id === "personal")?.default).toBe(true);
    }
  });
});
