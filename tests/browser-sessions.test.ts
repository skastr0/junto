import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import { warmPoolEvictions } from "../src/shared/browser";
import {
  BROWSER_CAPTURE_TIMEOUT_MS,
  BROWSER_EVAL_TIMEOUT_MS,
  BROWSER_MAX_ACTIVE_OPERATIONS,
  BROWSER_MAX_ERROR_BYTES,
  BROWSER_MAX_EVAL_CODE_BYTES,
  BROWSER_MAX_EVAL_RESULT_BYTES,
  BROWSER_MAX_EVAL_RESULT_DEPTH,
  BROWSER_MAX_EVAL_RESULT_NODES,
  BROWSER_MAX_METADATA_BYTES,
  BROWSER_MAX_REF_BYTES,
  BROWSER_MAX_SCREENSHOT_BYTES,
  BROWSER_MAX_TITLE_BYTES,
  BROWSER_MAX_URL_BYTES,
  BROWSER_NAVIGATION_TIMEOUT_MS,
  clampUtf8Bytes,
  utf8ByteLength,
} from "../src/shared/browser-limits";
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
      executeJavaScript: async (code) => {
        spy.calls.push(`eval:${utf8ByteLength(code)}`);
        return {
          __vellumEval: 1,
          status: "ok",
          json: JSON.stringify({ code, nested: { values: [1, true, null] } }),
        };
      },
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

const utf8UrlAtBytes = (bytes: number): string => {
  const prefix = "https://example.com/";
  if (bytes < utf8ByteLength(prefix)) throw new Error("URL byte target is too small");
  return `${prefix}${"x".repeat(bytes - utf8ByteLength(prefix))}`;
};

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

  it("rejects newline, unicode, and path-like generated authority handles", async () => {
    const { adapter, views } = makeSpyAdapter();
    const candidates = ["line\nbreak", "üni", "path/id", "valid-session"];
    const service = new BrowserSessionService(
      adapter,
      makeBrowserProfileService(root),
      () => ++clock,
      () => candidates.shift() ?? "valid-fallback",
    );
    const opened = await service.open(target("bounded-id"));
    expect(opened).toMatchObject({ ok: true, data: { sessionId: "valid-session" } });
    expect(views).toHaveLength(1);
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

  it("admits a target URL at N and rejects target URL/ref at N+1 before adapter creation", async () => {
    const { service, views } = makeDefaultService();
    expect(await service.open(target("url-at-cap", {
      url: utf8UrlAtBytes(BROWSER_MAX_URL_BYTES),
    }))).toMatchObject({ ok: true });
    expect(views).toHaveLength(1);

    expect(await service.open(target("url-over-cap", {
      url: utf8UrlAtBytes(BROWSER_MAX_URL_BYTES + 1),
    }))).toMatchObject({ ok: false, code: "invalid" });
    expect(await service.open(target("ref-over-cap", {
      ref: "x".repeat(BROWSER_MAX_REF_BYTES + 1),
    }))).toMatchObject({ ok: false, code: "invalid" });
    expect(views).toHaveLength(1);
  });

  it("admits goto/eval inputs at N and rejects N+1 before their adapter calls", async () => {
    const { service, views } = makeDefaultService();
    const opened = await service.open(target("operation-caps"));
    if (!opened.ok) throw new Error("open failed");
    views[0]?.events.onLoadOk(opened.data.sessionId);

    const navigated = service.goto(
      opened.data.sessionId,
      utf8UrlAtBytes(BROWSER_MAX_URL_BYTES),
    );
    if (!navigated.ok) throw new Error("goto at cap failed");
    views[0]?.events.onLoadOk(navigated.data.sessionId);
    const loadCalls = views[0]?.calls.filter((call) => call.startsWith("load:")).length;
    expect(service.goto(
      navigated.data.sessionId,
      utf8UrlAtBytes(BROWSER_MAX_URL_BYTES + 1),
    )).toMatchObject({ ok: false, code: "invalid" });
    expect(views[0]?.calls.filter((call) => call.startsWith("load:")).length).toBe(loadCalls);

    expect(await service.eval(
      navigated.data.sessionId,
      "x".repeat(BROWSER_MAX_EVAL_CODE_BYTES),
    )).toMatchObject({ ok: true });
    const evalCalls = views[0]?.calls.filter((call) => call.startsWith("eval:")).length;
    expect(await service.eval(
      navigated.data.sessionId,
      "x".repeat(BROWSER_MAX_EVAL_CODE_BYTES + 1),
    )).toMatchObject({ ok: false, code: "invalid" });
    expect(views[0]?.calls.filter((call) => call.startsWith("eval:")).length).toBe(evalCalls);
  });

  it("decodes a strict success envelope containing nested objects and arrays", async () => {
    const { service, views } = makeDefaultService();
    const opened = await service.open(target("eval-json"));
    if (!opened.ok) throw new Error("open failed");
    views[0]?.events.onLoadOk(opened.data.sessionId);

    expect(await service.eval(opened.data.sessionId, "nested()"))
      .toEqual({
        ok: true,
        data: {
          result: {
            code: "nested()",
            nested: { values: [1, true, null] },
          },
        },
      });
  });

  it("enforces the eval envelope byte cap at exactly N/N+1", async () => {
    let json = JSON.stringify("x".repeat(BROWSER_MAX_EVAL_RESULT_BYTES - 2));
    const adapter: BrowserViewAdapter = (_partition, events) => ({
      loadUrl: (_url, expectedSessionId) => events.onLoadOk(expectedSessionId),
      attach: () => {},
      setBounds: () => {},
      detach: () => {},
      destroy: () => {},
      executeJavaScript: async () => ({ __vellumEval: 1, status: "ok", json }),
    });
    const { service } = makeService(adapter);
    const opened = await service.open(target("result-bytes"));
    if (!opened.ok) throw new Error("open failed");

    expect(utf8ByteLength(json)).toBe(BROWSER_MAX_EVAL_RESULT_BYTES);
    expect(await service.eval(opened.data.sessionId, "atCap()"))
      .toMatchObject({ ok: true });
    json = JSON.stringify("x".repeat(BROWSER_MAX_EVAL_RESULT_BYTES - 1));
    expect(utf8ByteLength(json)).toBe(BROWSER_MAX_EVAL_RESULT_BYTES + 1);
    expect(await service.eval(opened.data.sessionId, "overCap()"))
      .toMatchObject({ ok: false, code: "result_too_large" });
  });

  it("independently rechecks eval result depth, node count, and finite numbers", async () => {
    let json = "null";
    const adapter: BrowserViewAdapter = (_partition, events) => ({
      loadUrl: (_url, expectedSessionId) => events.onLoadOk(expectedSessionId),
      attach: () => {},
      setBounds: () => {},
      detach: () => {},
      destroy: () => {},
      executeJavaScript: async () => ({ __vellumEval: 1, status: "ok", json }),
    });
    const { service } = makeService(adapter);
    const opened = await service.open(target("result-shape"));
    if (!opened.ok) throw new Error("open failed");

    json = `${"[".repeat(BROWSER_MAX_EVAL_RESULT_DEPTH)}0${"]".repeat(BROWSER_MAX_EVAL_RESULT_DEPTH)}`;
    expect(await service.eval(opened.data.sessionId, "depthN()"))
      .toMatchObject({ ok: true });
    json = `[${json}]`;
    expect(await service.eval(opened.data.sessionId, "depthNPlusOne()"))
      .toMatchObject({ ok: false, code: "result_too_large" });

    json = `[${Array.from(
      { length: BROWSER_MAX_EVAL_RESULT_NODES - 1 },
      () => "0",
    ).join(",")}]`;
    expect(await service.eval(opened.data.sessionId, "nodesN()"))
      .toMatchObject({ ok: true });
    json = `${json.slice(0, -1)},0]`;
    expect(await service.eval(opened.data.sessionId, "nodesNPlusOne()"))
      .toMatchObject({ ok: false, code: "result_too_large" });

    json = "1e400";
    expect(await service.eval(opened.data.sessionId, "infinite()"))
      .toMatchObject({ ok: false, code: "unsupported_result" });
  });

  it("rejects malformed/foreign envelopes and preserves typed bounded failures", async () => {
    let response: unknown = { result: "raw" };
    const adapter: BrowserViewAdapter = (_partition, events) => ({
      loadUrl: (_url, expectedSessionId) => events.onLoadOk(expectedSessionId),
      attach: () => {},
      setBounds: () => {},
      detach: () => {},
      destroy: () => {},
      executeJavaScript: async () => response,
    });
    const { service } = makeService(adapter);
    const opened = await service.open(target("result-envelope"));
    if (!opened.ok) throw new Error("open failed");

    expect(await service.eval(opened.data.sessionId, "raw()"))
      .toMatchObject({ ok: false, code: "unsupported_result" });
    response = { __vellumEval: 1, status: "ok", json: "null", extra: true };
    expect(await service.eval(opened.data.sessionId, "extra()"))
      .toMatchObject({ ok: false, code: "unsupported_result" });
    response = {
      __vellumEval: 1,
      status: "result_too_large",
      message: "x".repeat(BROWSER_MAX_ERROR_BYTES + 1),
    };
    const typed = await service.eval(opened.data.sessionId, "large()" );
    expect(typed).toMatchObject({ ok: false, code: "result_too_large" });
    if (!typed.ok) expect(utf8ByteLength(typed.message)).toBe(BROWSER_MAX_ERROR_BYTES);
  });

  it("caps screenshot bytes immediately after capture at N/N+1", async () => {
    let bytes = BROWSER_MAX_SCREENSHOT_BYTES;
    let captures = 0;
    const adapter: BrowserViewAdapter = (_partition, events) => ({
      loadUrl: (_url, expectedSessionId) => events.onLoadOk(expectedSessionId),
      attach: () => {},
      setBounds: () => {},
      detach: () => {},
      destroy: () => {},
      capturePagePng: async () => {
        captures += 1;
        return new Uint8Array(bytes);
      },
    });
    const { service } = makeService(adapter);
    const opened = await service.open(target("screenshot-cap"));
    if (!opened.ok) throw new Error("open failed");

    expect(await service.screenshot(opened.data.sessionId))
      .toMatchObject({ ok: true });
    bytes += 1;
    expect(await service.screenshot(opened.data.sessionId))
      .toMatchObject({ ok: false, code: "result_too_large" });
    expect(captures).toBe(2);
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

  it("rejects admission when every warm-pool slot is attached", async () => {
    const { service, views } = makeDefaultService();
    for (const id of ["n1", "n2", "n3"]) {
      const opened = await service.open(target(id));
      if (opened.ok) service.setBounds(opened.data.sessionId, bounds);
    }
    const exhausted = await service.open(target("n4"));
    expect(exhausted).toMatchObject({ ok: false, code: "resource_exhausted" });
    const listed = service.list();
    expect(listed).toMatchObject({ ok: true, data: expect.any(Array) });
    if (listed.ok) expect(listed.data).toHaveLength(3);
    expect(views).toHaveLength(3);
    expect(views.filter((view) => view.destroyed)).toHaveLength(0);
  });

  it("destroys and unregisters exactly one view when eval reaches its deadline, then reopens cleanly", async () => {
    const evaluation = deferred<unknown>();
    const neverAdapter: BrowserViewAdapter = (_partition, events) => ({
      loadUrl: (url, expectedSessionId) => {
        events.onNavigationStart({ url, isSameDocument: false, expectedSessionId });
        events.onLoadOk(expectedSessionId);
      },
      attach: () => {},
      setBounds: () => {},
      detach: () => {},
      destroy: () => {},
      executeJavaScript: () => evaluation.promise,
    });
    let destroys = 0;
    const serviceWithNeverEval = new BrowserSessionService(
      (partition, events) => {
        const view = neverAdapter(partition, events);
        return { ...view, destroy: () => { destroys += 1; } };
      },
      makeBrowserProfileService(root),
      () => ++clock,
      () => `timeout-session-${++idCounter}`,
    );
    const timed = await serviceWithNeverEval.open(target("timeout"));
    if (!timed.ok) throw new Error("open failed");

    vi.useFakeTimers();
    try {
      const pending = serviceWithNeverEval.eval(timed.data.sessionId, "while (true) {}");
      await vi.advanceTimersByTimeAsync(BROWSER_EVAL_TIMEOUT_MS);
      expect(await pending).toMatchObject({ ok: false, code: "timeout" });
      expect(destroys).toBe(1);
      expect(serviceWithNeverEval.state(timed.data.sessionId)).toMatchObject({
        ok: false,
        code: "not_found",
      });
      expect(serviceWithNeverEval.sessionIdForRef(timed.data.ref)).toBeUndefined();

      evaluation.resolve("late");
      await Promise.resolve();
      expect(destroys).toBe(1);

      const reopened = await serviceWithNeverEval.open(target("timeout"));
      expect(reopened).toMatchObject({ ok: true });
      if (reopened.ok) expect(reopened.data.sessionId).not.toBe(timed.data.sessionId);
    } finally {
      vi.useRealTimers();
    }
  });

  it("destroys only the affected view when capture is aborted and ignores late completion", async () => {
    const capture = deferred<Uint8Array>();
    const views: Array<{ events: BrowserViewEvents; destroys: number }> = [];
    const adapter: BrowserViewAdapter = (_partition, events) => {
      const record = { events, destroys: 0 };
      views.push(record);
      return {
        loadUrl: (url, expectedSessionId) => {
          events.onNavigationStart({ url, isSameDocument: false, expectedSessionId });
          events.onLoadOk(expectedSessionId);
        },
        attach: () => {},
        setBounds: () => {},
        detach: () => {},
        destroy: () => { record.destroys += 1; },
        capturePagePng: views.length === 1 ? () => capture.promise : async () => new Uint8Array([1]),
      };
    };
    const { service } = makeService(adapter);
    const affected = await service.open(target("n1"));
    const unaffected = await service.open(target("n2"));
    if (!affected.ok || !unaffected.ok) throw new Error("open failed");

    const abort = new AbortController();
    const pending = service.screenshot(affected.data.sessionId, abort.signal);
    abort.abort();
    expect(await pending).toMatchObject({ ok: false, code: "cancelled" });
    expect(views[0]?.destroys).toBe(1);
    expect(views[1]?.destroys).toBe(0);
    expect(service.state(affected.data.sessionId)).toMatchObject({ ok: false, code: "not_found" });
    expect(service.state(unaffected.data.sessionId)).toMatchObject({ ok: true });

    capture.resolve(new Uint8Array([1, 2, 3]));
    await Promise.resolve();
    expect(views[0]?.destroys).toBe(1);
  });

  it("times out a never-resolving capture and releases its session lane", async () => {
    const capture = deferred<Uint8Array>();
    let destroys = 0;
    const adapter: BrowserViewAdapter = (_partition, events) => ({
      loadUrl: (url, expectedSessionId) => {
        events.onNavigationStart({ url, isSameDocument: false, expectedSessionId });
        events.onLoadOk(expectedSessionId);
      },
      attach: () => {},
      setBounds: () => {},
      detach: () => {},
      destroy: () => { destroys += 1; },
      capturePagePng: () => capture.promise,
    });
    const { service } = makeService(adapter);
    const opened = await service.open(target("capture-timeout"));
    if (!opened.ok) throw new Error("open failed");

    vi.useFakeTimers();
    try {
      const pending = service.screenshot(opened.data.sessionId);
      await vi.advanceTimersByTimeAsync(BROWSER_CAPTURE_TIMEOUT_MS);
      expect(await pending).toMatchObject({ ok: false, code: "timeout" });
      expect(destroys).toBe(1);
      expect(service.state(opened.data.sessionId)).toMatchObject({ ok: false, code: "not_found" });
      capture.resolve(new Uint8Array([1]));
      await Promise.resolve();
      expect(destroys).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("invalidates a navigation generation that never finishes and permits a clean reopen", async () => {
    const views: Array<{ events: BrowserViewEvents; destroys: number; loads: number }> = [];
    const adapter: BrowserViewAdapter = (_partition, events) => {
      const record = { events, destroys: 0, loads: 0 };
      views.push(record);
      return {
        loadUrl: (url, expectedSessionId) => {
          record.loads += 1;
          events.onNavigationStart({ url, isSameDocument: false, expectedSessionId });
          if (record.loads === 1) events.onLoadOk(expectedSessionId);
        },
        attach: () => {},
        setBounds: () => {},
        detach: () => {},
        destroy: () => { record.destroys += 1; },
      };
    };
    const { service } = makeService(adapter);
    const opened = await service.open(target("nav-timeout"));
    if (!opened.ok) throw new Error("open failed");

    vi.useFakeTimers();
    try {
      const navigated = service.goto(opened.data.sessionId, "https://next.example.com");
      if (!navigated.ok) throw new Error("goto failed");
      await vi.advanceTimersByTimeAsync(BROWSER_NAVIGATION_TIMEOUT_MS);
      expect(service.state(navigated.data.sessionId)).toMatchObject({ ok: false, code: "not_found" });
      expect(views[0]?.destroys).toBe(1);

      const reopened = await service.open(target("nav-timeout"));
      expect(reopened).toMatchObject({ ok: true });
      if (reopened.ok) expect(reopened.data.sessionId).not.toBe(navigated.data.sessionId);
      expect(views).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborting navigation destroys its view and invalidates its rotated sessionId", async () => {
    const { service, views } = makeDefaultService();
    const opened = await service.open(target("nav-abort"));
    if (!opened.ok) throw new Error("open failed");
    views[0]?.events.onLoadOk(opened.data.sessionId);
    const abort = new AbortController();
    const navigated = service.goto(opened.data.sessionId, "https://next.example.com", abort.signal);
    if (!navigated.ok) throw new Error("goto failed");
    abort.abort();
    expect(service.state(navigated.data.sessionId)).toMatchObject({ ok: false, code: "not_found" });
    expect(views[0]?.calls.filter((call) => call === "destroy")).toHaveLength(1);
  });

  it("allows only one powerful operation per session", async () => {
    const evaluation = deferred<unknown>();
    const adapter: BrowserViewAdapter = (_partition, events) => ({
      loadUrl: (url, expectedSessionId) => {
        events.onNavigationStart({ url, isSameDocument: false, expectedSessionId });
        events.onLoadOk(expectedSessionId);
      },
      attach: () => {},
      setBounds: () => {},
      detach: () => {},
      destroy: () => {},
      executeJavaScript: () => evaluation.promise,
      capturePagePng: async () => new Uint8Array([1]),
    });
    const { service } = makeService(adapter);
    const opened = await service.open(target("single-lane"));
    if (!opened.ok) throw new Error("open failed");
    const abort = new AbortController();
    const pending = service.eval(opened.data.sessionId, "longTask()", abort.signal);
    expect(await service.screenshot(opened.data.sessionId)).toMatchObject({
      ok: false,
      code: "resource_exhausted",
    });
    expect(service.goto(opened.data.sessionId, "https://other.example.com")).toMatchObject({
      ok: false,
      code: "resource_exhausted",
    });
    abort.abort();
    await pending;
  });

  it("rejects powerful operations above the global active ceiling", async () => {
    const profileService = makeBrowserProfileService(root);
    const config = await import("node:fs/promises").then(async ({ readFile, writeFile }) => {
      await Effect.runPromise(profileService.ensureDefaults);
      const path = join(root, "config.json");
      const parsed = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
      parsed.maxWarmSessions = 32;
      await writeFile(path, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
      return profileService;
    });
    const views: Array<{ events: BrowserViewEvents }> = [];
    const adapter: BrowserViewAdapter = (_partition, events) => {
      const operation = deferred<unknown>();
      views.push({ events });
      return {
        loadUrl: (url, expectedSessionId) => {
          events.onNavigationStart({ url, isSameDocument: false, expectedSessionId });
          events.onLoadOk(expectedSessionId);
        },
        attach: () => {},
        setBounds: () => {},
        detach: () => {},
        destroy: () => {},
        executeJavaScript: () => operation.promise,
      };
    };
    const service = new BrowserSessionService(
      adapter,
      config,
      () => ++clock,
      () => `global-session-${++idCounter}`,
    );
    const opened: string[] = [];
    for (let index = 0; index <= BROWSER_MAX_ACTIVE_OPERATIONS; index += 1) {
      const result = await service.open(target(`global-${index}`));
      if (!result.ok) throw new Error(`open failed at ${index}: ${result.message}`);
      opened.push(result.data.sessionId);
    }
    expect(views).toHaveLength(BROWSER_MAX_ACTIVE_OPERATIONS + 1);

    const aborts = Array.from(
      { length: BROWSER_MAX_ACTIVE_OPERATIONS },
      () => new AbortController(),
    );
    const active = opened.slice(0, BROWSER_MAX_ACTIVE_OPERATIONS).map((sessionId, index) =>
      service.eval(sessionId, "longTask()", aborts[index]?.signal),
    );
    expect(await service.eval(opened[BROWSER_MAX_ACTIVE_OPERATIONS]!, "oneTooMany()"))
      .toMatchObject({ ok: false, code: "resource_exhausted" });
    for (const abort of aborts) abort.abort();
    await Promise.all(active);
  });

  it("clamps page-controlled URL, title, and error metadata before state and broadcast", async () => {
    const { service, views } = makeDefaultService();
    const emitted: Array<{ url: string; title?: string; lastError?: string }> = [];
    service.setSink((session) => emitted.push(session));
    const opened = await service.open(target("metadata"));
    if (!opened.ok) throw new Error("open failed");
    const longTitle = "💡".repeat(BROWSER_MAX_TITLE_BYTES);
    views[0]?.events.onLoadOk(opened.data.sessionId, longTitle);
    const longUrl = `https://metadata.example.com/${"💡".repeat(BROWSER_MAX_METADATA_BYTES)}`;
    views[0]?.events.onNavigationUrl(opened.data.sessionId, longUrl);
    const navigated = service.goto(opened.data.sessionId, "https://failed.example.com");
    if (!navigated.ok) throw new Error("goto failed");
    const longError = "💥".repeat(BROWSER_MAX_ERROR_BYTES);
    views[0]?.events.onLoadFail(navigated.data.sessionId, longError);

    const state = service.state(navigated.data.sessionId);
    if (!state.ok) throw new Error("state missing");
    expect(state.data.title).toBe(clampUtf8Bytes(longTitle, BROWSER_MAX_TITLE_BYTES));
    expect(state.data.lastError).toBe(clampUtf8Bytes(longError, BROWSER_MAX_ERROR_BYTES));
    expect(utf8ByteLength(state.data.url)).toBeLessThanOrEqual(BROWSER_MAX_METADATA_BYTES);
    for (const event of emitted) {
      expect(utf8ByteLength(event.url)).toBeLessThanOrEqual(BROWSER_MAX_METADATA_BYTES);
      if (event.title !== undefined) {
        expect(utf8ByteLength(event.title)).toBeLessThanOrEqual(BROWSER_MAX_TITLE_BYTES);
      }
      if (event.lastError !== undefined) {
        expect(utf8ByteLength(event.lastError)).toBeLessThanOrEqual(BROWSER_MAX_ERROR_BYTES);
      }
    }
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
