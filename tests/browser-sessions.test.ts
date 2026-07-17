import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { warmPoolEvictions } from "../src/shared/browser";
import type { ResolvedPageTarget } from "../src/main/vellum/browser/page-target";
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

  it("evicts nothing while the pool fits or when reusing a key", () => {
    expect(warmPoolEvictions([entry("a", false, 1)], "b", 3)).toEqual([]);
    expect(
      warmPoolEvictions(
        [entry("a", false, 1), entry("b", false, 2), entry("c", false, 3)],
        "a",
        3,
      ),
    ).toEqual([]);
  });

  it("evicts the least-recent detached entry and never an attached entry", () => {
    expect(
      warmPoolEvictions(
        [entry("a", false, 5), entry("b", false, 1), entry("c", true, 0)],
        "d",
        3,
      ),
    ).toEqual(["b"]);
    expect(
      warmPoolEvictions(
        [entry("a", true, 1), entry("b", true, 2), entry("c", true, 3)],
        "d",
        3,
      ),
    ).toEqual([]);
  });
});

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
    return {
      loadUrl: (url) => spy.calls.push(`load:${url}`),
      attach: () => spy.calls.push("attach"),
      setBounds: () => spy.calls.push("bounds"),
      detach: () => spy.calls.push("detach"),
      destroy: () => {
        spy.destroyed = true;
        spy.calls.push("destroy");
      },
      executeJavaScript: async (code) => ({ code }),
      capturePagePng: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    };
  };
  return { adapter, views };
};

const target = (
  nodeId: string,
  overrides: Partial<ResolvedPageTarget> = {},
): ResolvedPageTarget => ({
  ref: `vellum://canvas/work?node=${nodeId}`,
  nodeId,
  url: `https://${nodeId}.example.com`,
  profile: "personal",
  ...overrides,
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

describe("BrowserSessionService", () => {
  let root: string;
  let clock: number;
  let idCounter: number;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "vellum-browser-sessions-"));
    clock = 0;
    idCounter = 0;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const makeService = (adapter: BrowserViewAdapter) => {
    const service = new BrowserSessionService(
      adapter,
      makeBrowserProfileService(root),
      () => ++clock,
      () => `session-${++idCounter}`,
    );
    return { service };
  };

  const makeDefaultService = () => {
    const { adapter, views } = makeSpyAdapter();
    const service = new BrowserSessionService(
      adapter,
      makeBrowserProfileService(root),
      () => ++clock,
      () => `session-${++idCounter}`,
    );
    return { service, views };
  };

  const bounds = { x: 0, y: 0, width: 800, height: 600 };

  it("mints an opaque handle and loads the document-derived target", async () => {
    const { service, views } = makeDefaultService();
    const opened = await service.open(target("n1"));
    expect(opened).toMatchObject({
      ok: true,
      data: {
        sessionId: "session-1",
        ref: "vellum://canvas/work?node=n1",
        nodeId: "n1",
        profile: "personal",
      },
    });
    expect(views[0]?.partition).toBe("persist:vellum-profile-personal");
    expect(views[0]?.calls).toContain("load:https://n1.example.com");
  });

  it("rejects a target whose canonical ref, URL, or profile was substituted", async () => {
    const { service, views } = makeDefaultService();
    for (const candidate of [
      target("n1", { nodeId: "other" }),
      target("n1", { url: "file:///etc/passwd" }),
      target("n1", { profile: "../escape" }),
    ]) {
      expect((await service.open(candidate)).ok).toBe(false);
    }
    expect(views).toHaveLength(0);
  });

  it("rejects a profile absent from the profile registry", async () => {
    const { service } = makeDefaultService();
    const result = await service.open(target("n1", { profile: "missing" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid");
  });

  it("coalesces concurrent same-ref opens and preserves the handle on warm reuse", async () => {
    const { service, views } = makeDefaultService();
    const [first, second] = await Promise.all([service.open(target("n1")), service.open(target("n1"))]);
    expect(first.ok && second.ok && first.data.sessionId).toBe(second.ok ? second.data.sessionId : "");
    expect(views).toHaveLength(1);

    if (!first.ok) throw new Error("open failed");
    service.setBounds(first.data.sessionId, bounds);
    expect(service.close(first.data.sessionId)).toMatchObject({ ok: true, data: { state: "detached" } });
    const reopened = await service.open(target("n1"));
    expect(reopened).toMatchObject({ ok: true, data: { sessionId: first.data.sessionId } });
    expect(views).toHaveLength(1);
    expect(views[0]?.destroyed).toBe(false);
  });

  it("rejects URL or profile drift for a warm canonical ref", async () => {
    const { service } = makeDefaultService();
    await service.open(target("n1"));
    for (const changed of [
      target("n1", { url: "https://other.example.com" }),
      target("n1", { profile: "work" }),
    ]) {
      const result = await service.open(changed);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("invalid");
    }
  });

  it("eviction and recreation invalidate the old handle and mint a new one", async () => {
    const { service, views } = makeDefaultService();
    const first = await service.open(target("n1"));
    if (!first.ok) throw new Error("open failed");
    await service.open(target("n2"));
    await service.open(target("n3"));
    await service.open(target("n4"));
    expect(service.state(first.data.sessionId)).toMatchObject({ ok: false, code: "not_found" });
    expect(views[0]?.destroyed).toBe(true);

    const recreated = await service.open(target("n1"));
    expect(recreated.ok).toBe(true);
    if (recreated.ok) expect(recreated.data.sessionId).not.toBe(first.data.sessionId);
  });

  it("a fresh service instance mints a fresh handle for the same ref", async () => {
    const { adapter } = makeSpyAdapter();
    const generator = () => `restart-${++idCounter}`;
    const firstService = new BrowserSessionService(
      adapter,
      makeBrowserProfileService(root),
      () => ++clock,
      generator,
    );
    const first = await firstService.open(target("n1"));
    const restarted = new BrowserSessionService(
      adapter,
      makeBrowserProfileService(root),
      () => ++clock,
      generator,
    );
    const second = await restarted.open(target("n1"));
    expect(first.ok && second.ok && first.data.sessionId).not.toBe(second.ok ? second.data.sessionId : "");
  });

  it("never evicts attached sessions", async () => {
    const { service, views } = makeDefaultService();
    for (const id of ["n1", "n2", "n3"]) {
      const opened = await service.open(target(id));
      if (opened.ok) service.setBounds(opened.data.sessionId, bounds);
    }
    await service.open(target("n4"));
    expect(views.filter((view) => view.destroyed)).toHaveLength(0);
  });

  it("ignores late lifecycle callbacks from an evicted generation", async () => {
    const { service, views } = makeDefaultService();
    const first = await service.open(target("n1"));
    if (!first.ok) throw new Error("open failed");
    await service.open(target("n2"));
    await service.open(target("n3"));
    await service.open(target("n4"));
    const replacement = await service.open(target("n1"));
    if (!replacement.ok) throw new Error("replacement failed");
    views.at(-1)?.events.onLoadOk(replacement.data.sessionId, "replacement");
    views[0]?.events.onLoadFail(first.data.sessionId, "late old failure");
    expect(service.state(replacement.data.sessionId)).toMatchObject({
      ok: true,
      data: { state: "ready", title: "replacement" },
    });
  });

  it("rechecks the generation after an in-flight eval resolves", async () => {
    const evaluation = deferred<unknown>();
    let viewNumber = 0;
    const adapter: BrowserViewAdapter = (_partition, events) => {
      const number = viewNumber++;
      return {
        loadUrl: (url, expectedSessionId) => {
          events.onNavigationStart({ url, isSameDocument: false, expectedSessionId });
          events.onLoadOk(expectedSessionId);
        },
        attach: () => {},
        setBounds: () => {},
        detach: () => {},
        destroy: () => {},
        executeJavaScript: number === 0 ? () => evaluation.promise : async () => null,
      };
    };
    const { service } = makeService(adapter);
    const first = await service.open(target("n1"));
    if (!first.ok) throw new Error("open failed");
    const pending = service.eval(first.data.sessionId, "secret()");
    await service.open(target("n2"));
    await service.open(target("n3"));
    await service.open(target("n4"));
    evaluation.resolve("stale result");
    expect(await pending).toMatchObject({ ok: false, code: "not_found" });
  });

  it("rechecks the generation after an in-flight capture resolves", async () => {
    const capture = deferred<Uint8Array>();
    let viewNumber = 0;
    const adapter: BrowserViewAdapter = (_partition, events) => {
      const number = viewNumber++;
      return {
        loadUrl: (url, expectedSessionId) => {
          events.onNavigationStart({ url, isSameDocument: false, expectedSessionId });
          events.onLoadOk(expectedSessionId);
        },
        attach: () => {},
        setBounds: () => {},
        detach: () => {},
        destroy: () => {},
        capturePagePng:
          number === 0 ? () => capture.promise : async () => new Uint8Array([1]),
      };
    };
    const { service } = makeService(adapter);
    const first = await service.open(target("n1"));
    if (!first.ok) throw new Error("open failed");
    const pending = service.screenshot(first.data.sessionId);
    await service.open(target("n2"));
    await service.open(target("n3"));
    await service.open(target("n4"));
    capture.resolve(new Uint8Array([1, 2, 3]));
    expect(await pending).toMatchObject({ ok: false, code: "not_found" });
  });

  it("all existing-session operations require the exact sessionId", async () => {
    const { service, views } = makeDefaultService();
    const opened = await service.open(target("n1"));
    if (!opened.ok) throw new Error("open failed");
    expect(service.goto(opened.data.sessionId, "https://too-soon.example.com")).toMatchObject({
      ok: false,
      code: "invalid",
    });
    views[0]?.events.onLoadOk(opened.data.sessionId, "initial");
    const navigated = service.goto(opened.data.sessionId, "https://next.example.com");
    expect(navigated).toMatchObject({
      ok: true,
      data: { url: "https://next.example.com" },
    });
    expect(service.state(opened.data.sessionId)).toMatchObject({ ok: false, code: "not_found" });
    if (!navigated.ok) throw new Error("goto failed");
    expect(service.goto(navigated.data.sessionId, "https://overlap.example.com")).toMatchObject({
      ok: false,
      code: "invalid",
    });
    expect(await service.eval(navigated.data.sessionId, "document.title")).toMatchObject({
      ok: false,
      code: "invalid",
    });
    expect(await service.screenshot(navigated.data.sessionId)).toMatchObject({
      ok: false,
      code: "invalid",
    });
    for (const substitute of [opened.data.sessionId, "n1", target("n1").ref]) {
      expect(service.goto(substitute, "https://x.example.com")).toMatchObject({
        ok: false,
        code: "not_found",
      });
      expect(service.close(substitute)).toMatchObject({ ok: false, code: "not_found" });
      expect(service.state(substitute)).toMatchObject({ ok: false, code: "not_found" });
    }
    expect(service.state(navigated.data.sessionId)).toMatchObject({ ok: true });
  });

  it("rotates once for page-initiated cross-document navigation and ignores old completion", async () => {
    const { service, views } = makeDefaultService();
    const opened = await service.open(target("n1"));
    if (!opened.ok) throw new Error("open failed");
    const nextId = views[0]?.events.onNavigationStart({
      url: "https://page-initiated.example.com",
      isSameDocument: false,
    });
    expect(nextId).toBeDefined();
    expect(nextId).not.toBe(opened.data.sessionId);
    expect(service.state(opened.data.sessionId)).toMatchObject({ ok: false, code: "not_found" });
    if (nextId === undefined) throw new Error("navigation did not mint a generation");
    views[0]?.events.onLoadOk(opened.data.sessionId, "stale");
    expect(service.state(nextId)).toMatchObject({ ok: true, data: { state: "loading" } });
    views[0]?.events.onLoadOk(nextId, "current");
    expect(service.state(nextId)).toMatchObject({
      ok: true,
      data: { state: "ready", title: "current" },
    });
  });

  it("retains the generation for same-document navigation", async () => {
    const { service, views } = makeDefaultService();
    const opened = await service.open(target("n1"));
    if (!opened.ok) throw new Error("open failed");
    views[0]?.events.onLoadOk(opened.data.sessionId, "initial");
    const sameId = views[0]?.events.onNavigationStart({
      url: "https://n1.example.com#section",
      isSameDocument: true,
    });
    expect(sameId).toBe(opened.data.sessionId);
    expect(service.state(opened.data.sessionId)).toMatchObject({
      ok: true,
      data: { url: "https://n1.example.com#section" },
    });
  });

  it("serializes overlapping navigation generations and accepts only the latest completion", async () => {
    const { service, views } = makeDefaultService();
    const opened = await service.open(target("n1"));
    if (!opened.ok) throw new Error("open failed");
    const firstNavigation = views[0]?.events.onNavigationStart({
      url: "https://first.example.com",
      isSameDocument: false,
    });
    const secondNavigation = views[0]?.events.onNavigationStart({
      url: "https://second.example.com",
      isSameDocument: false,
    });
    if (firstNavigation === undefined || secondNavigation === undefined) {
      throw new Error("navigation did not mint generations");
    }
    views[0]?.events.onLoadOk(firstNavigation, "first");
    expect(service.state(secondNavigation)).toMatchObject({ ok: true, data: { state: "loading" } });
    views[0]?.events.onLoadOk(secondNavigation, "second");
    expect(service.state(secondNavigation)).toMatchObject({
      ok: true,
      data: { state: "ready", title: "second" },
    });
  });

  it("tracks current lifecycle, emits current changes, and detaches all on quit", async () => {
    const { service, views } = makeDefaultService();
    const events: string[] = [];
    service.setSink((session) => events.push(`${session.sessionId}:${session.state}`));
    const opened = await service.open(target("n1"));
    if (!opened.ok) throw new Error("open failed");
    views[0]?.events.onLoadOk(opened.data.sessionId, "Example");
    service.setBounds(opened.data.sessionId, bounds);
    service.detachAllOnQuit("test");
    expect(service.state(opened.data.sessionId)).toMatchObject({
      ok: true,
      data: { state: "detached", attached: false, title: "Example" },
    });
    expect(events).toContain(`${opened.data.sessionId}:ready`);
    expect(views[0]?.calls).toContain("detach");
    expect(views[0]?.destroyed).toBe(false);
  });

  it("lists configured profiles and rejects empty detached captures", async () => {
    const emptyAdapter: BrowserViewAdapter = (_partition, events) => ({
      loadUrl: (url, expectedSessionId) => {
        events.onNavigationStart({ url, isSameDocument: false, expectedSessionId });
        events.onLoadOk(expectedSessionId);
      },
      attach: () => {},
      setBounds: () => {},
      detach: () => {},
      destroy: () => {},
      capturePagePng: async () => new Uint8Array(),
    });
    const { service } = makeService(emptyAdapter);
    const profiles = await service.listProfiles();
    expect(profiles.ok).toBe(true);
    if (profiles.ok) {
      expect(profiles.data).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "personal", default: true }),
          expect.objectContaining({ id: "work" }),
        ]),
      );
    }
    const opened = await service.open(target("n1"));
    if (!opened.ok) throw new Error("open failed");
    expect(await service.screenshot(opened.data.sessionId)).toMatchObject({
      ok: false,
      code: "failed",
    });
  });
});
