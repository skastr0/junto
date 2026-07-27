import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Context, Effect, ManagedRuntime } from "effect";
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
import type { RemoteHost } from "../src/shared/remote-hosts";
import type { BrowserHostCapabilityAuthority } from "../src/main/vellum/browser/host-capability";
import {
  BrowserProfileError,
  makeBrowserProfileService,
  type BrowserProfileServiceApi,
} from "../src/main/vellum/browser/profiles";
import { makeStateEngineLive } from "../src/main/vellum/state/engine";
import { StateEngine } from "../src/main/vellum/state/service";
import { BrowserProfileGate } from "../src/main/vellum/browser/profile-gate";
import {
  BrowserOwnerSessionTeardownFailure,
  BrowserSessionService,
  type BrowserViewAdapter,
  type BrowserViewEvents,
  type BrowserViewHandle,
  type BrowserViewOptions,
} from "../src/main/vellum/browser/sessions";
import { LOCAL_BROWSER_TEST_AUTHORITY } from "./browser-host-test-authority";

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
  readonly options: BrowserViewOptions | undefined;
  readonly calls: string[];
  readonly destroyedPromise: Promise<void>;
  readonly resolveDestroyed: () => void;
  destroyed: boolean;
}

const makeSpyAdapter = (acknowledgeDestroy = true, throwAfterDestroy = false) => {
  const views: SpyView[] = [];
  const adapter: BrowserViewAdapter = (partition, events, options) => {
    let resolveDestroyed!: () => void;
    const destroyedPromise = new Promise<void>((resolve) => {
      resolveDestroyed = resolve;
    });
    const spy: SpyView = {
      partition,
      events,
      options,
      calls: [],
      destroyedPromise,
      resolveDestroyed,
      destroyed: false,
    };
    views.push(spy);
    return {
      loadUrl: async (url) => {
        spy.calls.push(`load:${url}`);
      },
      setTopLevelOriginGuard: (origin) => spy.calls.push(`guard:${origin}`),
      attach: () => spy.calls.push("attach"),
      setBounds: () => spy.calls.push("bounds"),
      detach: () => spy.calls.push("detach"),
      stopLoading: () => spy.calls.push("stop-loading"),
      destroy: () => {
        spy.destroyed = true;
        spy.calls.push("destroy");
        if (acknowledgeDestroy) spy.resolveDestroyed();
        if (throwAfterDestroy) throw new Error("adapter teardown failed after destruction");
      },
      whenDestroyed: () => spy.destroyedPromise,
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
  hostId: "local",
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

describe("BrowserProfileGate", () => {
  it("invalidates stale snapshots monotonically across cancel, delete, and recreate", () => {
    const gate = new BrowserProfileGate();
    const initial = gate.snapshot("personal");
    expect(initial).toEqual({ profile: "personal", epoch: 0n });
    expect(gate.isCurrent(initial!)).toBe(true);

    const first = gate.begin("personal");
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(gate.snapshot("personal")).toBeUndefined();
    expect(gate.isCurrent(initial!)).toBe(false);
    expect(gate.cancelBeforeMutation(first.data)).toBe(true);
    expect(gate.cancelBeforeMutation(first.data)).toBe(false);

    const reopened = gate.snapshot("personal");
    expect(reopened?.epoch).toBe(1n);
    expect(gate.isCurrent(reopened!)).toBe(true);
    expect(gate.isCurrent(initial!)).toBe(false);

    const second = gate.begin("personal");
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.data.epoch).toBe(2n);
    expect(gate.commitDeleted(second.data)).toBe(true);
    expect(gate.commitDeleted(second.data)).toBe(false);
    expect(gate.disposition("personal")).toBe("deleted");
    expect(gate.snapshot("personal")).toBeUndefined();

    const created = gate.markCreated("personal");
    expect(created).toEqual({
      ok: true,
      data: { profile: "personal", epoch: 3n },
    });
    expect(created.ok && gate.isCurrent(created.data)).toBe(true);
    expect(gate.isCurrent(reopened!)).toBe(false);
  });

  it("returns bounded typed failures for invalid, busy, and deleted profiles", () => {
    const gate = new BrowserProfileGate();
    expect(gate.begin("../escape")).toEqual({ ok: false, code: "invalid" });
    const blocked = gate.begin("personal");
    expect(blocked.ok).toBe(true);
    expect(gate.begin("personal")).toEqual({ ok: false, code: "busy" });
    if (!blocked.ok) return;
    expect(gate.commitDeleted(blocked.data)).toBe(true);
    expect(gate.begin("personal")).toEqual({ ok: false, code: "deleted" });
  });
});

describe("BrowserSessionService", () => {
  let root: string;
  let clock: number;
  let idCounter: number;
  let stateRuntime:
    | ManagedRuntime.ManagedRuntime<StateEngine, unknown>
    | undefined;
  let state:
    | Context.Tag.Service<typeof StateEngine>
    | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "vellum-browser-sessions-"));
    stateRuntime = ManagedRuntime.make(
      makeStateEngineLive(join(root, "vellum.db")),
    );
    state = await stateRuntime.runPromise(StateEngine);
    clock = 0;
    idCounter = 0;
  });

  afterEach(async () => {
    await stateRuntime?.dispose();
    stateRuntime = undefined;
    state = undefined;
    await rm(root, { recursive: true, force: true });
  });

  const makeProfileService = (): BrowserProfileServiceApi => {
    if (state === undefined) {
      throw new Error("test StateEngine is not initialized");
    }
    return makeBrowserProfileService(state, root);
  };

  const makeService = (adapter: BrowserViewAdapter) => {
    const service = new BrowserSessionService(
      adapter,
      LOCAL_BROWSER_TEST_AUTHORITY,
      makeProfileService(),
      () => ++clock,
      () => `session-${++idCounter}`,
    );
    return { service };
  };

  const makeDefaultService = () => {
    const { adapter, views } = makeSpyAdapter();
    const service = new BrowserSessionService(
      adapter,
      LOCAL_BROWSER_TEST_AUTHORITY,
      makeProfileService(),
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
      LOCAL_BROWSER_TEST_AUTHORITY,
      makeProfileService(),
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

  it("fails before adapter creation when a page targets another physical host", async () => {
    const { adapter, views } = makeSpyAdapter();
    const remote: RemoteHost = {
      id: "studio",
      label: "studio",
      kind: "remote",
      endpoint: "studio",
      capabilities: ["browser"],
    };
    const hostAuthority: BrowserHostCapabilityAuthority = {
      findHost: (hostId) => hostId === remote.id ? remote : undefined,
      station: () => ({ hostId: "local", role: "command-center" }),
    };
    const service = new BrowserSessionService(
      adapter,
      hostAuthority,
      makeProfileService(),
      () => ++clock,
      () => `session-${++idCounter}`,
      undefined,
      undefined,
      undefined,
      undefined,
    );

    expect(await service.open(target("remote", { hostId: "studio" }))).toMatchObject({
      ok: false,
      code: "unsupported_capability",
    });
    expect(views).toHaveLength(0);
  });

  it("does not treat a Command Center host-id setting as a remote physical station", async () => {
    const { adapter, views } = makeSpyAdapter();
    const remote: RemoteHost = {
      id: "studio",
      label: "studio",
      kind: "remote",
      endpoint: "studio",
      capabilities: ["browser"],
    };
    const service = new BrowserSessionService(
      adapter,
      {
        findHost: (hostId) => hostId === remote.id ? remote : undefined,
        station: () => ({ hostId: remote.id, role: "command-center" }),
      },
      makeProfileService(),
      () => ++clock,
      () => `session-${++idCounter}`,
    );

    expect(await service.open(target("remote", { hostId: remote.id }))).toMatchObject({
      ok: false,
      code: "unsupported_capability",
    });
    expect(views).toHaveLength(0);
  });

  it("rechecks host capability and the canvas target immediately before adapter creation", async () => {
    const { adapter, views } = makeSpyAdapter();
    let browserDeclared = true;
    const stationed = (): RemoteHost => ({
      id: "studio",
      label: "studio",
      kind: "remote",
      endpoint: "studio",
      capabilities: browserDeclared ? ["browser"] : ["terminal"],
    });
    const hostAuthority: BrowserHostCapabilityAuthority = {
      findHost: (hostId) => hostId === "studio" ? stationed() : undefined,
      station: () => ({ hostId: "studio", role: "remote" }),
    };
    const service = new BrowserSessionService(
      adapter,
      hostAuthority,
      makeProfileService(),
      () => ++clock,
      () => `session-${++idCounter}`,
      undefined,
      undefined,
      undefined,
      undefined,
    );
    const original = target("removed-capability", { hostId: "studio" });

    expect(await service.open(original, undefined, async () => {
      browserDeclared = false;
      return { ok: true, data: original };
    })).toMatchObject({
      ok: false,
      code: "unsupported_capability",
    });
    expect(views).toHaveLength(0);

    browserDeclared = true;
    expect(await service.open(
      target("host-changed", { hostId: "studio" }),
      undefined,
      async () => ({
        ok: true,
        data: target("host-changed", { hostId: "other" }),
      }),
    )).toMatchObject({
      ok: false,
      code: "invalid",
    });
    expect(views).toHaveLength(0);
  });

  it("keeps private targets denied unless a constructor-injected admission grants them", async () => {
    const loopbackTarget = target("fixture", {
      url: "http://127.0.0.1:49152/fixture",
    });
    const defaults = makeDefaultService();
    expect(await defaults.service.open(loopbackTarget)).toMatchObject({
      ok: false,
      code: "forbidden",
    });
    expect(defaults.views).toHaveLength(0);

    const { adapter, views } = makeSpyAdapter();
    const qualified = new BrowserSessionService(
      adapter,
      LOCAL_BROWSER_TEST_AUTHORITY,
      makeProfileService(),
      () => ++clock,
      () => `session-${++idCounter}`,
      (url) => new URL(url).origin === "http://127.0.0.1:49152",
    );
    expect(await qualified.open(loopbackTarget)).toMatchObject({ ok: true });
    expect(views[0]?.calls).toContain("load:http://127.0.0.1:49152/fixture");
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
      loadUrl: async (_url, expectedSessionId) => events.onLoadOk(expectedSessionId),
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
      loadUrl: async (_url, expectedSessionId) => events.onLoadOk(expectedSessionId),
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
      loadUrl: async (_url, expectedSessionId) => events.onLoadOk(expectedSessionId),
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
      loadUrl: async (_url, expectedSessionId) => events.onLoadOk(expectedSessionId),
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

  it("stops one page idempotently, destroys its view, and preserves profile and sibling sessions", async () => {
    const { service, views } = makeDefaultService();
    service.setPoolLimitsProvider(async () => ({ maxVisibleSurfaces: 2, maxWarmSessions: 8 }));
    const stoppedPage = target("stop-me");
    const siblingPage = target("keep-me");
    const stopped = await service.open(stoppedPage);
    const sibling = await service.open(siblingPage);
    if (!stopped.ok || !sibling.ok) throw new Error("open failed");

    expect(await service.stop(stopped.data.sessionId)).toEqual({
      ok: true,
      data: {
        sessionId: stopped.data.sessionId,
        ref: stoppedPage.ref,
        profile: "personal",
        stopped: true,
        alreadyStopped: false,
      },
    });
    expect(views[0]?.calls.filter((call) => call === "destroy")).toHaveLength(1);
    expect(views[1]?.calls.filter((call) => call === "destroy")).toHaveLength(0);
    expect(service.state(stopped.data.sessionId)).toMatchObject({ ok: false, code: "not_found" });
    expect(service.state(sibling.data.sessionId)).toMatchObject({ ok: true });

    expect(await service.stop(stopped.data.sessionId)).toMatchObject({
      ok: true,
      data: { alreadyStopped: true },
    });
    expect(views[0]?.calls.filter((call) => call === "destroy")).toHaveLength(1);
    expect(await service.stop("never-existed")).toMatchObject({ ok: false, code: "not_found" });

    const reopened = await service.open(stoppedPage);
    expect(reopened).toMatchObject({
      ok: true,
      data: { profile: "personal", sessionId: "session-3" },
    });
    expect(views[2]?.partition).toBe("persist:vellum-profile-personal");
  });

  it("coalesces concurrent Stop Page calls onto one physical destruction acknowledgement", async () => {
    const { adapter, views } = makeSpyAdapter(false);
    const service = new BrowserSessionService(
      adapter,
      LOCAL_BROWSER_TEST_AUTHORITY,
      makeProfileService(),
      () => ++clock,
      () => `session-${++idCounter}`,
    );
    const opened = await service.open(target("concurrent-stop"));
    if (!opened.ok) throw new Error("open failed");

    const first = service.stop(opened.data.sessionId);
    const second = service.stop(opened.data.sessionId);
    expect(views[0]?.calls.filter((call) => call === "destroy")).toHaveLength(1);
    views[0]?.resolveDestroyed();

    await expect(first).resolves.toMatchObject({
      ok: true,
      data: { alreadyStopped: false },
    });
    await expect(second).resolves.toMatchObject({
      ok: true,
      data: { alreadyStopped: true },
    });
    expect(views[0]?.calls.filter((call) => call === "destroy")).toHaveLength(1);
  });

  it("treats physical destruction acknowledgement as authoritative after adapter teardown throws", async () => {
    const { adapter, views } = makeSpyAdapter(true, true);
    const service = new BrowserSessionService(
      adapter,
      LOCAL_BROWSER_TEST_AUTHORITY,
      makeProfileService(),
      () => ++clock,
      () => `session-${++idCounter}`,
    );
    const opened = await service.open(target("acknowledged-stop"));
    if (!opened.ok) throw new Error("open failed");

    expect(await service.stop(opened.data.sessionId)).toMatchObject({
      ok: true,
      data: { alreadyStopped: false },
    });
    expect(views[0]?.calls.filter((call) => call === "destroy")).toHaveLength(1);
    expect(service.state(opened.data.sessionId)).toMatchObject({ ok: false, code: "not_found" });
  });

  it("retries a timed-out Stop Page after late physical acknowledgement without reusing its authority", async () => {
    const { adapter, views } = makeSpyAdapter(false);
    const candidates = ["failed-stop-id", "failed-stop-id", "replacement-id"];
    const service = new BrowserSessionService(
      adapter,
      LOCAL_BROWSER_TEST_AUTHORITY,
      makeProfileService(),
      () => ++clock,
      () => candidates.shift() ?? `fallback-${++idCounter}`,
      undefined,
      undefined,
      5,
    );
    const opened = await service.open(target("failed-stop"));
    if (!opened.ok) throw new Error("open failed");

    expect(await service.stop(opened.data.sessionId)).toMatchObject({
      ok: false,
      code: "timeout",
    });
    views[0]?.resolveDestroyed();
    expect(await service.stop(opened.data.sessionId)).toMatchObject({
      ok: true,
      data: { alreadyStopped: true },
    });
    expect(views[0]?.calls.filter((call) => call === "destroy")).toHaveLength(1);
    expect(await service.open(target("replacement"))).toMatchObject({
      ok: true,
      data: { sessionId: "replacement-id" },
    });
  });

  it("carries an unacknowledged Stop Page view into a profile-wipe quiescence barrier", async () => {
    const { adapter, views } = makeSpyAdapter(false);
    const service = new BrowserSessionService(
      adapter,
      LOCAL_BROWSER_TEST_AUTHORITY,
      makeProfileService(),
      () => ++clock,
      () => `session-${++idCounter}`,
      undefined,
      undefined,
      5,
    );
    const opened = await service.open(target("stop-then-wipe"));
    if (!opened.ok) throw new Error("open failed");
    expect(await service.stop(opened.data.sessionId)).toMatchObject({
      ok: false,
      code: "timeout",
    });

    const quiescence = service.beginProfileQuiescence("personal", "wipe after stop timeout");
    if (!quiescence.ok) throw new Error("quiescence failed");
    let settled = false;
    void quiescence.data.completion.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 1));
    expect(settled).toBe(false);

    views[0]?.resolveDestroyed();
    await expect(quiescence.data.completion).resolves.toEqual({
      ok: true,
      data: {
        pendingOpensInvalidated: 0,
        sessionsDestroyed: 0,
        viewsDestroyed: 1,
      },
    });
  });

  it("keys warm reuse and pending coalescing by owner plus canonical ref", async () => {
    const { service, views } = makeDefaultService();
    const page = target("n1");
    const [jobAFirst, jobASecond, jobB, ui] = await Promise.all([
      service.openForOwner("job-a", page),
      service.openForOwner("job-a", page),
      service.openForOwner("job-b", page),
      service.open(page),
    ]);
    if (!jobAFirst.ok || !jobASecond.ok || !jobB.ok || !ui.ok) {
      throw new Error("owner-isolated opens failed");
    }

    expect(jobASecond.data.sessionId).toBe(jobAFirst.data.sessionId);
    expect(new Set([
      jobAFirst.data.sessionId,
      jobB.data.sessionId,
      ui.data.sessionId,
    ]).size).toBe(3);
    expect(views).toHaveLength(3);
    expect(views.filter((view) => view.options?.exactTopLevelOrigin !== undefined))
      .toHaveLength(2);
    expect(views.find((view) => view.options === undefined)).toBeDefined();
    expect(service.listForOwner("job-a")).toMatchObject({
      ok: true,
      data: [{ sessionId: jobAFirst.data.sessionId }],
    });
    expect(service.list()).toMatchObject({
      ok: true,
      data: [{ sessionId: ui.data.sessionId }],
    });
    expect(service.sessionIdForRefForOwner("job-b", page.ref)).toBe(jobB.data.sessionId);
    expect(service.sessionIdForRef(page.ref)).toBe(ui.data.sessionId);
  });

  it("keeps automation metadata out of the renderer sink", async () => {
    const { service, views } = makeDefaultService();
    const emitted: string[] = [];
    service.setSink((session) => emitted.push(session.sessionId));
    const automated = await service.openForOwner("job-a", target("automation"));
    const ui = await service.open(target("ui"));
    if (!automated.ok || !ui.ok) throw new Error("open failed");
    views[0]?.events.onLoadOk(automated.data.sessionId);
    views[1]?.events.onLoadOk(ui.data.sessionId);
    expect(emitted).not.toContain(automated.data.sessionId);
    expect(emitted).toContain(ui.data.sessionId);
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
      LOCAL_BROWSER_TEST_AUTHORITY,
      makeProfileService(),
      () => ++clock,
      generator,
    );
    const first = await firstService.open(target("n1"));
    const restarted = new BrowserSessionService(
      adapter,
      LOCAL_BROWSER_TEST_AUTHORITY,
      makeProfileService(),
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
      loadUrl: async (url, expectedSessionId) => {
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
      LOCAL_BROWSER_TEST_AUTHORITY,
      makeProfileService(),
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
        loadUrl: async (url, expectedSessionId) => {
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
      loadUrl: async (url, expectedSessionId) => {
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
        loadUrl: async (url, expectedSessionId) => {
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
      loadUrl: async (url, expectedSessionId) => {
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

  it("invalidates only the crashed session, fails its operation once, and reopens its ref", async () => {
    const hangingEvaluation = deferred<unknown>();
    const views: Array<{
      readonly events: BrowserViewEvents;
      readonly destroy: ReturnType<typeof vi.fn>;
    }> = [];
    const adapter: BrowserViewAdapter = (_partition, events) => {
      const index = views.length;
      const destroy = vi.fn();
      views.push({ events, destroy });
      return {
        loadUrl: async (url, expectedSessionId) => {
          events.onNavigationStart({ url, isSameDocument: false, expectedSessionId });
          events.onLoadOk(expectedSessionId);
        },
        attach: () => {},
        setBounds: () => {},
        detach: () => {},
        destroy,
        executeJavaScript: () =>
          index === 0
            ? hangingEvaluation.promise
            : Promise.resolve({ __vellumEval: 1, status: "ok", json: '"usable"' }),
      };
    };
    const { service } = makeService(adapter);
    const crashedTarget = target("crashed");
    const crashed = await service.openForOwner("job-crashed", crashedTarget);
    const sibling = await service.openForOwner("job-sibling", target("sibling"));
    if (!crashed.ok || !sibling.ok) throw new Error("open failed");

    const evaluation = service.evalForOwner(
      "job-crashed",
      crashed.data.sessionId,
      "new Promise(() => {})",
    );
    await Promise.resolve();
    views[0]?.events.onUnexpectedTermination();
    views[0]?.events.onUnexpectedTermination();

    await expect(evaluation).resolves.toEqual({
      ok: false,
      code: "failed",
      message: "browser renderer terminated unexpectedly",
    });
    expect(service.stateForOwner("job-crashed", crashed.data.sessionId)).toMatchObject({
      ok: false,
      code: "not_found",
    });
    expect(service.stateForOwner("job-sibling", sibling.data.sessionId)).toMatchObject({
      ok: true,
    });
    expect(views[0]?.destroy).toHaveBeenCalledOnce();
    expect(views[1]?.destroy).not.toHaveBeenCalled();
    await expect(
      service.evalForOwner("job-sibling", sibling.data.sessionId, "document.title"),
    ).resolves.toMatchObject({ ok: true, data: { result: "usable" } });

    const reopened = await service.openForOwner("job-crashed", crashedTarget);
    if (!reopened.ok) throw new Error("reopen failed");
    expect(reopened.data.sessionId).not.toBe(crashed.data.sessionId);
    expect(views).toHaveLength(3);
    await expect(
      service.evalForOwner("job-crashed", reopened.data.sessionId, "document.title"),
    ).resolves.toMatchObject({ ok: true, data: { result: "usable" } });
  });

  it("settles a crashed navigation waiter exactly once with a fixed failure", async () => {
    const { service, views } = makeDefaultService();
    const page = target("crashed-navigation");
    const opened = await service.openForOwner("job-navigation", page);
    if (!opened.ok) throw new Error("open failed");
    const terminal = service.awaitNavigationTerminalForOwner(
      "job-navigation",
      opened.data.sessionId,
    );
    const resolve = vi.fn();
    void terminal.then(resolve);

    views[0]?.events.onUnexpectedTermination();
    views[0]?.events.onUnexpectedTermination();
    await expect(terminal).resolves.toEqual({
      ok: false,
      code: "failed",
      message: "browser renderer terminated unexpectedly",
    });
    await Promise.resolve();
    expect(resolve).toHaveBeenCalledOnce();
    expect(views[0]?.calls.filter((call) => call === "destroy")).toHaveLength(1);
    expect(service.stateForOwner("job-navigation", opened.data.sessionId)).toMatchObject({
      ok: false,
      code: "not_found",
    });

    const reopened = await service.openForOwner("job-navigation", page);
    expect(reopened).toMatchObject({ ok: true, data: { sessionId: "session-2" } });
    expect(views).toHaveLength(2);
  });

  it("rejects powerful operations above the global active ceiling", async () => {
    const profileService = makeProfileService();
    await Effect.runPromise(profileService.ensureDefaults);
    if (state === undefined) {
      throw new Error("test StateEngine is not initialized");
    }
    await Effect.runPromise(
      state.transaction("test.browser-sessions.pool-limit", (writer) => {
        writer.run(
          `
            UPDATE browser_profile_settings
            SET max_warm_sessions = ?
            WHERE singleton = 1
          `,
          [32],
        );
      }),
    );
    expect(
      (await Effect.runPromise(profileService.readConfig)).maxWarmSessions,
    ).toBe(32);
    const views: Array<{ events: BrowserViewEvents }> = [];
    const adapter: BrowserViewAdapter = (_partition, events) => {
      const operation = deferred<unknown>();
      views.push({ events });
      return {
        loadUrl: async (url, expectedSessionId) => {
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
      LOCAL_BROWSER_TEST_AUTHORITY,
      profileService,
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
        loadUrl: async (url, expectedSessionId) => {
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
        loadUrl: async (url, expectedSessionId) => {
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

  it("checks owner and generation in every automation operation lane", async () => {
    const { service, views } = makeDefaultService();
    const opened = await service.openForOwner("job-a", target("n1"));
    if (!opened.ok) throw new Error("open failed");
    views[0]?.events.onLoadOk(opened.data.sessionId, "ready");

    expect(service.stateForOwner("job-b", opened.data.sessionId))
      .toMatchObject({ ok: false, code: "not_found" });
    expect(service.gotoForOwner("job-b", opened.data.sessionId, "https://next.example.com"))
      .toMatchObject({ ok: false, code: "not_found" });
    expect(await service.evalForOwner("job-b", opened.data.sessionId, "document.title"))
      .toMatchObject({ ok: false, code: "not_found" });
    expect(await service.screenshotForOwner("job-b", opened.data.sessionId))
      .toMatchObject({ ok: false, code: "not_found" });
    expect(service.closeForOwner("job-b", opened.data.sessionId))
      .toMatchObject({ ok: false, code: "not_found" });
    expect(service.authorizationSnapshotForOwner("job-b", opened.data.sessionId))
      .toMatchObject({ ok: false, code: "not_found" });
    expect(views[0]?.calls.some((call) => call.startsWith("eval:"))).toBe(false);

    expect(await service.evalForOwner("job-a", opened.data.sessionId, "document.title"))
      .toMatchObject({ ok: true });
    const navigated = service.gotoForOwner(
      "job-a",
      opened.data.sessionId,
      "https://next.example.com/path",
    );
    if (!navigated.ok) throw new Error("goto failed");
    expect(views[0]?.calls).toContain("guard:https://next.example.com");
    expect(service.stateForOwner("job-a", opened.data.sessionId))
      .toMatchObject({ ok: false, code: "not_found" });
    expect(service.authorizationSnapshotForOwner("job-a", navigated.data.sessionId))
      .toMatchObject({
        ok: true,
        data: {
          owner: "job-a",
          generation: navigated.data.sessionId,
          ref: target("n1").ref,
          profile: "personal",
          origin: "https://next.example.com",
          navigationInFlight: true,
        },
      });
  });

  it("keeps the full current origin in main-only authorization state", async () => {
    const { service, views } = makeDefaultService();
    const opened = await service.openForOwner("job-a", target("n1"));
    if (!opened.ok) throw new Error("open failed");
    const longUrl = `https://n1.example.com/${"x".repeat(BROWSER_MAX_METADATA_BYTES)}`;
    views[0]?.events.onNavigationUrl(opened.data.sessionId, longUrl);

    const visible = service.stateForOwner("job-a", opened.data.sessionId);
    const authorization = service.authorizationSnapshotForOwner("job-a", opened.data.sessionId);
    if (!visible.ok || !authorization.ok) throw new Error("session state unavailable");
    expect(utf8ByteLength(visible.data.url)).toBe(BROWSER_MAX_METADATA_BYTES);
    expect(authorization.data.origin).toBe("https://n1.example.com");
    expect(authorization.data).not.toHaveProperty("url");
  });

  it("awaits navigation finish and failure before releasing the caller", async () => {
    const { service, views } = makeDefaultService();
    const successful = await service.openForOwner("job-ok", target("ok"));
    const failed = await service.openForOwner("job-fail", target("fail"));
    if (!successful.ok || !failed.ok) throw new Error("open failed");

    const successTerminal = service.awaitNavigationTerminalForOwner(
      "job-ok",
      successful.data.sessionId,
    );
    const failedTerminal = service.awaitNavigationTerminalForOwner(
      "job-fail",
      failed.data.sessionId,
    );
    views[0]?.events.onLoadOk(successful.data.sessionId, "complete");
    views[1]?.events.onLoadFail(failed.data.sessionId, "synthetic failure");

    await expect(successTerminal).resolves.toMatchObject({
      ok: true,
      data: { state: "ready", title: "complete" },
    });
    await expect(failedTerminal).resolves.toMatchObject({
      ok: false,
      code: "failed",
      message: "synthetic failure",
    });
  });

  it("revokes one owner and aborts only that owner's terminal navigation", async () => {
    const { service, views } = makeDefaultService();
    const controller = new AbortController();
    const owned = await service.openForOwner("job-a", target("a"), controller.signal);
    const sibling = await service.openForOwner("job-b", target("b"));
    const ui = await service.open(target("ui"));
    if (!owned.ok || !sibling.ok || !ui.ok) throw new Error("open failed");

    const ownedTerminal = service.awaitNavigationTerminalForOwner(
      "job-a",
      owned.data.sessionId,
      controller.signal,
    );
    const siblingTerminal = service.awaitNavigationTerminalForOwner(
      "job-b",
      sibling.data.sessionId,
    );
    expect(service.destroyOwnerSessions("job-a", "grant revoked")).toBe(1);

    await expect(ownedTerminal).resolves.toMatchObject({
      ok: false,
      code: "cancelled",
      message: "grant revoked",
    });
    expect(service.stateForOwner("job-a", owned.data.sessionId))
      .toMatchObject({ ok: false, code: "not_found" });
    expect(service.stateForOwner("job-b", sibling.data.sessionId)).toMatchObject({ ok: true });
    expect(service.state(ui.data.sessionId)).toMatchObject({ ok: true });
    expect(views[0]?.destroyed).toBe(true);
    expect(views[1]?.destroyed).toBe(false);
    expect(views[2]?.destroyed).toBe(false);

    views[1]?.events.onLoadOk(sibling.data.sessionId);
    await expect(siblingTerminal).resolves.toMatchObject({ ok: true });
  });

  it("uses the physical destroy witness when an adapter throws after closing", async () => {
    const { adapter: spyAdapter, views } = makeSpyAdapter();
    let viewIndex = 0;
    const adapter: BrowserViewAdapter = (partition, events, options) => {
      const handle = spyAdapter(partition, events, options);
      const currentIndex = viewIndex;
      viewIndex += 1;
      if (currentIndex !== 0) return handle;
      return {
        ...handle,
        destroy: () => {
          handle.destroy();
          throw new Error("raw adapter teardown sentinel");
        },
      };
    };
    const { service } = makeService(adapter);
    const firstOwned = await service.openForOwner("job-a", target("owned-a"));
    const laterOwned = await service.openForOwner("job-a", target("owned-b"));
    const sibling = await service.openForOwner("job-b", target("sibling"));
    if (!firstOwned.ok || !laterOwned.ok || !sibling.ok) throw new Error("open failed");

    let teardownFailure: unknown;
    try {
      service.destroyOwnerSessions("job-a", "reason with raw authority context");
    } catch (error) {
      teardownFailure = error;
    }

    expect(teardownFailure).toBeUndefined();

    expect(service.stateForOwner("job-a", firstOwned.data.sessionId))
      .toMatchObject({ ok: false, code: "not_found" });
    expect(service.stateForOwner("job-a", laterOwned.data.sessionId))
      .toMatchObject({ ok: false, code: "not_found" });
    expect(service.listForOwner("job-a")).toEqual({ ok: true, data: [] });
    expect(views[0]?.destroyed).toBe(true);
    expect(views[1]?.destroyed).toBe(true);
    expect(views[2]?.destroyed).toBe(false);

    views[2]?.events.onLoadOk(sibling.data.sessionId, "sibling ready");
    expect(await service.evalForOwner("job-b", sibling.data.sessionId, "document.title"))
      .toMatchObject({ ok: true });
    expect(service.destroyOwnerSessions("job-a", "repeat is safe")).toBe(0);
    expect(service.stateForOwner("job-b", sibling.data.sessionId)).toMatchObject({ ok: true });
  });

  it("invalidates only the matching pending profile within one owner", async () => {
    const base = makeProfileService();
    await Effect.runPromise(base.ensureDefaults);
    const gate = new BrowserProfileGate();
    const personalPartition = deferred<string>();
    const workPartition = deferred<string>();
    let personalPartitionReads = 0;
    let workPartitionReads = 0;
    const profiles: BrowserProfileServiceApi = {
      ...base,
      partitionName: (profile) => {
        if (profile === "personal") {
          return Effect.promise(() => {
            personalPartitionReads += 1;
            return personalPartition.promise;
          });
        }
        if (profile === "work") {
          return Effect.promise(() => {
            workPartitionReads += 1;
            return workPartition.promise;
          });
        }
        return base.partitionName(profile);
      },
    };
    const { adapter, views } = makeSpyAdapter();
    const service = new BrowserSessionService(
      adapter,
      LOCAL_BROWSER_TEST_AUTHORITY,
      profiles,
      () => ++clock,
      () => `session-${++idCounter}`,
      undefined,
      gate,
    );
    service.setPoolLimitsProvider(async () => ({ maxVisibleSurfaces: 2, maxWarmSessions: 8 }));

    const pendingPersonal = service.openForOwner("job-shared", target("personal-page"));
    const pendingWork = service.openForOwner(
      "job-shared",
      target("work-page", { profile: "work" }),
    );
    await vi.waitFor(() => {
      expect(personalPartitionReads).toBe(1);
      expect(workPartitionReads).toBe(1);
    });

    const started = service.beginProfileQuiescence("personal");
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await expect(started.data.completion).resolves.toEqual({
      ok: true,
      data: {
        pendingOpensInvalidated: 1,
        sessionsDestroyed: 0,
        viewsDestroyed: 0,
      },
    });
    workPartition.resolve("persist:vellum-profile-work");
    const work = await pendingWork;
    expect(work).toMatchObject({ ok: true });
    expect(service.stateForOwner("job-shared", work.ok ? work.data.sessionId : "missing"))
      .toMatchObject({ ok: true });
    expect(views).toHaveLength(1);
    expect(views[0]?.partition).toBe("persist:vellum-profile-work");

    expect(gate.cancelBeforeMutation(started.data.block)).toBe(true);
    personalPartition.resolve("persist:vellum-profile-personal");
    await expect(pendingPersonal).resolves.toMatchObject({ ok: false, code: "cancelled" });
    expect(views).toHaveLength(1);
  });

  it("revalidates the profile epoch after a paused touch and before adapter construction", async () => {
    const base = makeProfileService();
    await Effect.runPromise(base.ensureDefaults);
    const gate = new BrowserProfileGate();
    const pausedTouch = deferred<void>();
    let touchCalls = 0;
    const profiles: BrowserProfileServiceApi = {
      ...base,
      touchProfile: (profile) =>
        profile === "personal"
          ? Effect.promise(() => {
              touchCalls += 1;
              return pausedTouch.promise;
            })
          : base.touchProfile(profile),
    };
    const { adapter, views } = makeSpyAdapter();
    const service = new BrowserSessionService(
      adapter,
      LOCAL_BROWSER_TEST_AUTHORITY,
      profiles,
      () => ++clock,
      () => `session-${++idCounter}`,
      undefined,
      gate,
    );

    const opening = service.open(target("paused-touch"));
    await vi.waitFor(() => expect(touchCalls).toBe(1));
    const started = service.beginProfileQuiescence("personal");
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(gate.cancelBeforeMutation(started.data.block)).toBe(true);
    pausedTouch.resolve();

    await expect(opening).resolves.toMatchObject({ ok: false, code: "cancelled" });
    expect(views).toHaveLength(0);
  });

  it("revalidates the profile epoch after a paused pool-limits lookup", async () => {
    const base = makeProfileService();
    await Effect.runPromise(base.ensureDefaults);
    const gate = new BrowserProfileGate();
    const pausedLimits = deferred<{
      readonly maxVisibleSurfaces: number;
      readonly maxWarmSessions: number;
    }>();
    let limitsReads = 0;
    const { adapter, views } = makeSpyAdapter();
    const service = new BrowserSessionService(
      adapter,
      LOCAL_BROWSER_TEST_AUTHORITY,
      base,
      () => ++clock,
      () => `session-${++idCounter}`,
      undefined,
      gate,
    );
    service.setPoolLimitsProvider(() => {
      limitsReads += 1;
      return pausedLimits.promise;
    });

    const opening = service.open(target("paused-limits"));
    await vi.waitFor(() => expect(limitsReads).toBe(1));
    const started = service.beginProfileQuiescence("personal");
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(gate.cancelBeforeMutation(started.data.block)).toBe(true);
    pausedLimits.resolve({ maxVisibleSurfaces: 2, maxWarmSessions: 8 });

    await expect(opening).resolves.toMatchObject({ ok: false, code: "cancelled" });
    expect(views).toHaveLength(0);
  });

  it("destroys matching UI and automation sessions while preserving every sibling profile", async () => {
    const gate = new BrowserProfileGate();
    const { adapter, views } = makeSpyAdapter();
    const service = new BrowserSessionService(
      adapter,
      LOCAL_BROWSER_TEST_AUTHORITY,
      makeProfileService(),
      () => ++clock,
      () => `session-${++idCounter}`,
      undefined,
      gate,
    );
    service.setPoolLimitsProvider(async () => ({ maxVisibleSurfaces: 2, maxWarmSessions: 8 }));
    const ui = await service.open(target("ui-personal"));
    const jobA = await service.openForOwner("job-a", target("a-personal"));
    const jobB = await service.openForOwner("job-b", target("b-personal"));
    const sibling = await service.openForOwner(
      "job-sibling",
      target("sibling-work", { profile: "work" }),
    );
    if (!ui.ok || !jobA.ok || !jobB.ok || !sibling.ok) throw new Error("open failed");

    const started = service.beginProfileQuiescence("personal", "profile wipe started");
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await expect(started.data.completion).resolves.toEqual({
      ok: true,
      data: {
        pendingOpensInvalidated: 0,
        sessionsDestroyed: 3,
        viewsDestroyed: 3,
      },
    });

    expect(service.state(ui.data.sessionId)).toMatchObject({ ok: false, code: "not_found" });
    expect(service.stateForOwner("job-a", jobA.data.sessionId))
      .toMatchObject({ ok: false, code: "not_found" });
    expect(service.stateForOwner("job-b", jobB.data.sessionId))
      .toMatchObject({ ok: false, code: "not_found" });
    expect(service.stateForOwner("job-sibling", sibling.data.sessionId))
      .toMatchObject({ ok: true });
    expect(views.map((view) => view.destroyed)).toEqual([true, true, true, false]);
    await expect(service.open(target("blocked-personal"))).resolves.toMatchObject({
      ok: false,
      code: "forbidden",
    });
  });

  it("lets an acknowledged profile teardown converge after destroy throws", async () => {
    const gate = new BrowserProfileGate();
    const spies = makeSpyAdapter();
    let viewIndex = 0;
    const adapter: BrowserViewAdapter = (partition, events, options) => {
      const index = viewIndex;
      viewIndex += 1;
      const handle = spies.adapter(partition, events, options);
      if (index !== 0) return handle;
      return {
        ...handle,
        destroy: () => {
          handle.destroy();
          throw new Error("injected destroy failure");
        },
      };
    };
    const service = new BrowserSessionService(
      adapter,
      LOCAL_BROWSER_TEST_AUTHORITY,
      makeProfileService(),
      () => ++clock,
      () => `session-${++idCounter}`,
      undefined,
      gate,
    );
    service.setPoolLimitsProvider(async () => ({ maxVisibleSurfaces: 2, maxWarmSessions: 8 }));
    const ui = await service.open(target("throwing-personal"));
    const job = await service.openForOwner("job-a", target("later-personal"));
    const sibling = await service.openForOwner(
      "job-a",
      target("surviving-work", { profile: "work" }),
    );
    if (!ui.ok || !job.ok || !sibling.ok) throw new Error("open failed");

    const started = service.beginProfileQuiescence("personal");
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await expect(started.data.completion).resolves.toMatchObject({
      ok: true,
      data: {
        sessionsDestroyed: 2,
        viewsDestroyed: 2,
      },
    });

    expect(spies.views.map((view) => view.destroyed)).toEqual([true, true, false]);
    expect(service.state(ui.data.sessionId)).toMatchObject({ ok: false, code: "not_found" });
    expect(service.stateForOwner("job-a", job.data.sessionId))
      .toMatchObject({ ok: false, code: "not_found" });
    expect(service.stateForOwner("job-a", sibling.data.sessionId)).toMatchObject({ ok: true });
    expect(gate.disposition("personal")).toBe("quiescing");
  });

  it("waits for physical destruction and fails closed at the hard bounded deadline", async () => {
    const gate = new BrowserProfileGate();
    const { adapter, views } = makeSpyAdapter(false);
    const service = new BrowserSessionService(
      adapter,
      LOCAL_BROWSER_TEST_AUTHORITY,
      makeProfileService(),
      () => ++clock,
      () => `session-${++idCounter}`,
      undefined,
      gate,
      20,
    );
    const opened = await service.open(target("physical-barrier"));
    if (!opened.ok) throw new Error("open failed");

    const started = service.beginProfileQuiescence("personal");
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    let completed = false;
    void started.data.completion.then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(completed).toBe(false);
    views[0]?.resolveDestroyed();
    await expect(started.data.completion).resolves.toMatchObject({ ok: true });

    const secondGate = new BrowserProfileGate();
    const secondAdapter = makeSpyAdapter(false);
    const timed = new BrowserSessionService(
      secondAdapter.adapter,
      LOCAL_BROWSER_TEST_AUTHORITY,
      makeProfileService(),
      () => ++clock,
      () => `session-${++idCounter}`,
      undefined,
      secondGate,
      5,
    );
    const timedOpen = await timed.open(target("physical-timeout"));
    if (!timedOpen.ok) throw new Error("open failed");
    const timedStart = timed.beginProfileQuiescence("personal");
    expect(timedStart.ok).toBe(true);
    if (!timedStart.ok) return;
    await expect(timedStart.data.completion).resolves.toMatchObject({
      ok: false,
      code: "timeout",
    });
    expect(secondGate.disposition("personal")).toBe("quiescing");
    expect(timed.state(timedOpen.data.sessionId)).toMatchObject({ ok: false, code: "not_found" });
  });

  it("preserves the initiating abort signal through navigation terminal", async () => {
    const { service, views } = makeDefaultService();
    const controller = new AbortController();
    const opened = await service.openForOwner("job-a", target("a"), controller.signal);
    if (!opened.ok) throw new Error("open failed");
    const terminal = service.awaitNavigationTerminalForOwner(
      "job-a",
      opened.data.sessionId,
      controller.signal,
    );

    controller.abort();

    await expect(terminal).resolves.toMatchObject({
      ok: false,
      code: "cancelled",
      message: "navigation cancelled",
    });
    expect(views[0]?.destroyed).toBe(true);
    expect(service.stateForOwner("job-a", opened.data.sessionId))
      .toMatchObject({ ok: false, code: "not_found" });
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

  it("closes UI admission monotonically and rejects every powerful UI operation", async () => {
    const { service, views } = makeDefaultService();
    const opened = await service.open(target("shutdown-gate"));
    if (!opened.ok) throw new Error("open failed");
    views[0]?.events.onLoadOk(opened.data.sessionId, "ready");
    service.setBounds(opened.data.sessionId, bounds);
    await Promise.resolve();

    const admission = service.uiAdmissionSnapshot();
    if (admission === undefined) throw new Error("UI admission unexpectedly closed");
    const precommit = service.beginUiShutdown("test shutdown");

    expect(service.uiAdmissionSnapshot()).toBeUndefined();
    expect(service.isUiAdmissionCurrent(admission)).toBe(false);
    expect(service.setBounds(opened.data.sessionId, bounds))
      .toMatchObject({ ok: false, code: "cancelled" });
    expect(service.goto(opened.data.sessionId, "https://next.example.com"))
      .toMatchObject({ ok: false, code: "cancelled" });
    expect(views[0]?.events.onNavigationStart({
      url: "https://page.example.com",
      isSameDocument: false,
    })).toBeUndefined();
    await expect(service.eval(opened.data.sessionId, "1"))
      .resolves.toMatchObject({ ok: false, code: "cancelled" });
    await expect(service.screenshot(opened.data.sessionId))
      .resolves.toMatchObject({ ok: false, code: "cancelled" });
    await expect(service.stop(opened.data.sessionId))
      .resolves.toMatchObject({ ok: false, code: "cancelled" });
    await expect(service.wipeProfile("personal"))
      .resolves.toMatchObject({ ok: false, code: "cancelled" });
    await expect(service.listProfiles())
      .resolves.toMatchObject({ ok: false, code: "cancelled" });
    await expect(service.surfaceConfig())
      .resolves.toMatchObject({ ok: false, code: "cancelled" });
    await expect(service.open(target("after-shutdown")))
      .resolves.toMatchObject({ ok: false, code: "cancelled" });

    const drained = await service.drainUiOnQuit("test shutdown");
    expect(drained).toMatchObject({
      epoch: precommit.epoch,
      clean: true,
      timedOut: false,
      activeOperations: [],
      sessionsDestroyed: 1,
    });
    expect(views[0]?.calls).toContain("detach");
    expect(views[0]?.destroyed).toBe(true);
    const teardownCalls = views[0]?.calls ?? [];
    expect(teardownCalls.indexOf("stop-loading"))
      .toBeLessThan(teardownCalls.indexOf("destroy"));
  });

  it("publishes the UI drain before a reentrant adapter destroy callback", async () => {
    const destruction = deferred<void>();
    let service!: BrowserSessionService;
    let reentered: Promise<unknown> | undefined;
    const adapter: BrowserViewAdapter = (_partition, events) => ({
      loadUrl: async (url, expectedSessionId) => {
        events.onNavigationStart({ url, isSameDocument: false, expectedSessionId });
        events.onLoadOk(expectedSessionId);
      },
      attach: () => {},
      setBounds: () => {},
      detach: () => {},
      destroy: () => {
        reentered = service.drainUiOnQuit("reentrant adapter");
        destruction.resolve();
      },
      whenDestroyed: () => destruction.promise,
    });
    service = new BrowserSessionService(
      adapter,
      LOCAL_BROWSER_TEST_AUTHORITY,
      makeProfileService(),
      () => ++clock,
      () => `session-${++idCounter}`,
      undefined,
      undefined,
      5,
      5,
    );
    const opened = await service.open(target("reentrant-destroy"));
    if (!opened.ok) throw new Error("open failed");

    const draining = service.drainUiOnQuit("outer shutdown");

    expect(reentered).toBe(draining);
    await expect(draining).resolves.toMatchObject({
      clean: true,
      sessionsDestroyed: 1,
      teardownWitnessFailures: 0,
    });
  });

  it("retains an automation destruction witness admitted before shutdown", async () => {
    const { adapter, views } = makeSpyAdapter(false);
    const service = new BrowserSessionService(
      adapter,
      LOCAL_BROWSER_TEST_AUTHORITY,
      makeProfileService(),
      () => ++clock,
      () => `session-${++idCounter}`,
      undefined,
      undefined,
      5,
      5,
    );
    const opened = await service.openForOwner("job-a", target("pre-shutdown-revoke"));
    if (!opened.ok) throw new Error("open failed");
    views[0]?.events.onLoadOk(opened.data.sessionId);

    expect(service.destroyOwnerSessions("job-a", "capability revoked")).toBe(1);
    await expect(service.drainUiOnQuit("later shutdown")).resolves.toMatchObject({
      clean: false,
      timedOut: true,
      activeOperations: ["view-destroy"],
    });

    views[0]?.resolveDestroyed();
    await Promise.resolve();
    await expect(service.drainUiOnQuit("later shutdown")).resolves.toMatchObject({
      clean: true,
      activeOperations: [],
      teardownWitnessFailures: 0,
    });
  });

  it("destroys every remaining automation runtime as a quit backstop", async () => {
    const { adapter, views } = makeSpyAdapter();
    const { service } = makeService(adapter);
    const opened = await service.openForOwner("orphan-owner", target("orphan-runtime"));
    if (!opened.ok) throw new Error("open failed");
    views[0]?.events.onLoadOk(opened.data.sessionId);

    await expect(service.drainUiOnQuit("test shutdown")).resolves.toMatchObject({
      clean: true,
      sessionsDestroyed: 1,
      teardownWitnessFailures: 0,
    });
    expect(service.stateForOwner("orphan-owner", opened.data.sessionId))
      .toMatchObject({ ok: false, code: "not_found" });
    expect(views[0]?.destroyed).toBe(true);
  });

  it("retains and invalidates a delayed automation open before reporting clean", async () => {
    const base = makeProfileService();
    await Effect.runPromise(base.ensureDefaults);
    const partition = deferred<string>();
    let partitionReads = 0;
    const profiles: BrowserProfileServiceApi = {
      ...base,
      partitionName: (profile) =>
        profile === "personal"
          ? Effect.promise(() => {
              partitionReads += 1;
              return partition.promise;
            })
          : base.partitionName(profile),
    };
    const { adapter, views } = makeSpyAdapter();
    const service = new BrowserSessionService(
      adapter,
      LOCAL_BROWSER_TEST_AUTHORITY,
      profiles,
      () => ++clock,
      () => `session-${++idCounter}`,
      undefined,
      undefined,
      5,
      50,
    );

    const opening = service.openForOwner(
      "orphan-owner",
      target("delayed-owner-shutdown-open"),
    );
    await vi.waitFor(() => expect(partitionReads).toBe(1));

    let drainSettled = false;
    const draining = service.drainUiOnQuit("test shutdown");
    void draining.then(() => {
      drainSettled = true;
    });
    await Promise.resolve();
    expect(drainSettled).toBe(false);
    expect(views).toHaveLength(0);

    partition.resolve("persist:vellum-profile-personal");

    await expect(opening).resolves.toMatchObject({
      ok: false,
      code: "cancelled",
    });
    await expect(draining).resolves.toMatchObject({
      clean: true,
      operations: ["open"],
      settled: 1,
      fulfilled: 1,
      rejected: 0,
      timedOut: false,
      activeOperations: [],
      sessionsDestroyed: 0,
    });
    expect(views).toHaveLength(0);
    expect(service.listForOwner("orphan-owner")).toEqual({ ok: true, data: [] });
  });

  it("times out unclean while an invalidated automation open remains pending", async () => {
    const base = makeProfileService();
    await Effect.runPromise(base.ensureDefaults);
    const partition = deferred<string>();
    let partitionReads = 0;
    const profiles: BrowserProfileServiceApi = {
      ...base,
      partitionName: (profile) =>
        profile === "personal"
          ? Effect.promise(() => {
              partitionReads += 1;
              return partition.promise;
            })
          : base.partitionName(profile),
    };
    const { adapter, views } = makeSpyAdapter();
    const service = new BrowserSessionService(
      adapter,
      LOCAL_BROWSER_TEST_AUTHORITY,
      profiles,
      () => ++clock,
      () => `session-${++idCounter}`,
      undefined,
      undefined,
      5,
      5,
    );

    const opening = service.openForOwner(
      "orphan-owner",
      target("stuck-owner-shutdown-open"),
    );
    await vi.waitFor(() => expect(partitionReads).toBe(1));

    await expect(service.drainUiOnQuit("test shutdown")).resolves.toMatchObject({
      clean: false,
      operations: ["open"],
      settled: 0,
      fulfilled: 0,
      rejected: 0,
      timedOut: true,
      activeOperations: ["open"],
      sessionsDestroyed: 0,
    });
    expect(views).toHaveLength(0);

    partition.resolve("persist:vellum-profile-personal");
    await expect(opening).resolves.toMatchObject({ ok: false, code: "cancelled" });
    await expect(service.drainUiOnQuit("retry shutdown")).resolves.toMatchObject({
      clean: true,
      timedOut: false,
      activeOperations: [],
    });
    expect(views).toHaveLength(0);
  });

  it("closes automation mutation admission with the UI shutdown gate", async () => {
    const { service, views } = makeDefaultService();
    const opened = await service.openForOwner(
      "automation-owner",
      target("automation-shutdown-gate"),
    );
    if (!opened.ok) throw new Error("open failed");
    views[0]?.events.onLoadOk(opened.data.sessionId, "ready");
    await Promise.resolve();

    service.beginUiShutdown("test shutdown");

    expect(service.gotoForOwner(
      "automation-owner",
      opened.data.sessionId,
      "https://next.example.com",
    )).toMatchObject({ ok: false, code: "cancelled" });
    expect(views[0]?.events.onNavigationStart({
      url: "https://page.example.com",
      isSameDocument: false,
    })).toBeUndefined();
    await expect(service.evalForOwner(
      "automation-owner",
      opened.data.sessionId,
      "1",
    )).resolves.toMatchObject({ ok: false, code: "cancelled" });
    await expect(service.screenshotForOwner(
      "automation-owner",
      opened.data.sessionId,
    )).resolves.toMatchObject({ ok: false, code: "cancelled" });
    await expect(service.stopForOwner("automation-owner", opened.data.sessionId))
      .resolves.toMatchObject({ ok: false, code: "cancelled" });
    await expect(service.openForOwner(
      "late-owner",
      target("after-automation-shutdown"),
    )).resolves.toMatchObject({ ok: false, code: "cancelled" });

    await expect(service.drainUiOnQuit("test shutdown")).resolves.toMatchObject({
      clean: true,
      sessionsDestroyed: 1,
      activeOperations: [],
    });
    expect(views[0]?.destroyed).toBe(true);
  });

  it("fails closed when a destroyed view provides no physical witness", async () => {
    const adapter: BrowserViewAdapter = (_partition, events) => ({
      loadUrl: async (url, expectedSessionId) => {
        events.onNavigationStart({ url, isSameDocument: false, expectedSessionId });
        events.onLoadOk(expectedSessionId);
      },
      attach: () => {},
      setBounds: () => {},
      detach: () => {},
      destroy: () => {},
    });
    const { service } = makeService(adapter);
    const opened = await service.openForOwner("job-a", target("missing-destroy-witness"));
    if (!opened.ok) throw new Error("open failed");

    expect(() => service.destroyOwnerSessions("job-a", "capability revoked"))
      .toThrowError(BrowserOwnerSessionTeardownFailure);
    await expect(service.drainUiOnQuit("later shutdown")).resolves.toMatchObject({
      clean: false,
      timedOut: false,
      activeOperations: [],
      teardownWitnessFailures: 1,
    });
  });

  it("keeps a rejected physical destroy witness permanently unclean", async () => {
    const adapter: BrowserViewAdapter = (_partition, events) => ({
      loadUrl: async (url, expectedSessionId) => {
        events.onNavigationStart({ url, isSameDocument: false, expectedSessionId });
        events.onLoadOk(expectedSessionId);
      },
      attach: () => {},
      setBounds: () => {},
      detach: () => {},
      destroy: () => {},
      whenDestroyed: () => Promise.reject(new Error("destroy witness rejected")),
    });
    const { service } = makeService(adapter);
    const opened = await service.openForOwner("job-a", target("rejected-destroy-witness"));
    if (!opened.ok) throw new Error("open failed");

    expect(service.destroyOwnerSessions("job-a", "capability revoked")).toBe(1);
    await expect(service.drainUiOnQuit("later shutdown")).resolves.toMatchObject({
      clean: false,
      rejected: 1,
      activeOperations: [],
      teardownWitnessFailures: 1,
    });
    await expect(service.drainUiOnQuit("later shutdown")).resolves.toMatchObject({
      clean: false,
      activeOperations: [],
      teardownWitnessFailures: 1,
    });
  });

  it("retries a retained teardown tombstone after destroy throws before closing", async () => {
    const destruction = deferred<void>();
    let destroyCalls = 0;
    const adapter: BrowserViewAdapter = (_partition, events) => ({
      loadUrl: async (url, expectedSessionId) => {
        events.onNavigationStart({ url, isSameDocument: false, expectedSessionId });
        events.onLoadOk(expectedSessionId);
      },
      attach: () => {},
      setBounds: () => {},
      detach: () => {},
      stopLoading: () => {},
      destroy: () => {
        destroyCalls += 1;
        if (destroyCalls === 1) throw new Error("transient close refusal");
        destruction.resolve();
      },
      whenDestroyed: () => destruction.promise,
    });
    const service = new BrowserSessionService(
      adapter,
      LOCAL_BROWSER_TEST_AUTHORITY,
      makeProfileService(),
      () => ++clock,
      () => `session-${++idCounter}`,
      undefined,
      undefined,
      5,
      5,
    );
    const opened = await service.open(target("retry-destroy-tombstone"));
    if (!opened.ok) throw new Error("open failed");

    await expect(service.drainUiOnQuit("first shutdown")).resolves.toMatchObject({
      clean: false,
      timedOut: true,
      activeOperations: ["view-destroy"],
      sessionsDestroyed: 1,
    });
    expect(destroyCalls).toBe(1);

    await expect(service.drainUiOnQuit("retry shutdown")).resolves.toMatchObject({
      clean: true,
      timedOut: false,
      activeOperations: [],
      teardownWitnessFailures: 0,
    });
    expect(destroyCalls).toBe(2);
  });

  it("invalidates a delayed UI opener and drains its actual admitted promise", async () => {
    const base = makeProfileService();
    await Effect.runPromise(base.ensureDefaults);
    const partition = deferred<string>();
    let partitionReads = 0;
    const profiles: BrowserProfileServiceApi = {
      ...base,
      partitionName: (profile) =>
        profile === "personal"
          ? Effect.promise(() => {
              partitionReads += 1;
              return partition.promise;
            })
          : base.partitionName(profile),
    };
    const { adapter, views } = makeSpyAdapter();
    const service = new BrowserSessionService(
      adapter,
      LOCAL_BROWSER_TEST_AUTHORITY,
      profiles,
      () => ++clock,
      () => `session-${++idCounter}`,
    );

    const opening = service.open(target("delayed-shutdown-open"));
    await vi.waitFor(() => expect(partitionReads).toBe(1));
    service.beginUiShutdown("test shutdown");
    const draining = service.drainUiOnQuit("test shutdown");
    partition.resolve("persist:vellum-profile-personal");

    await expect(opening).resolves.toMatchObject({ ok: false, code: "cancelled" });
    await expect(draining).resolves.toMatchObject({
      clean: true,
      operations: ["open"],
      settled: 1,
      timedOut: false,
    });
    expect(views).toHaveLength(0);
  });

  it("retains a confirmed profile wipe across an unclean bounded drain", async () => {
    const base = makeProfileService();
    const wipe = deferred<{ readonly status: "complete" }>();
    let wipeStarts = 0;
    const profiles: BrowserProfileServiceApi = {
      ...base,
      wipeProfile: () => Effect.promise(() => {
        wipeStarts += 1;
        return wipe.promise;
      }),
    };
    const { adapter } = makeSpyAdapter();
    const service = new BrowserSessionService(
      adapter,
      LOCAL_BROWSER_TEST_AUTHORITY,
      profiles,
      () => ++clock,
      () => `session-${++idCounter}`,
      undefined,
      undefined,
      5,
      5,
    );

    const wiping = service.wipeProfile("personal");
    await vi.waitFor(() => expect(wipeStarts).toBe(1));
    await expect(service.drainUiOnQuit("test shutdown")).resolves.toMatchObject({
      clean: false,
      timedOut: true,
      activeOperations: ["profile-wipe"],
    });

    wipe.resolve({ status: "complete" });
    await expect(wiping).resolves.toEqual({
      ok: true,
      data: { profileId: "personal", status: "complete", recovery: "complete" },
    });
    await Promise.resolve();
    await expect(service.drainUiOnQuit("test shutdown")).resolves.toMatchObject({
      clean: true,
      timedOut: false,
      activeOperations: [],
    });
  });

  it("does not let a raced public eval hide its still-live Electron promise", async () => {
    const evaluation = deferred<unknown>();
    const destruction = deferred<void>();
    const adapter: BrowserViewAdapter = (_partition, events) => ({
      loadUrl: async (url, expectedSessionId) => {
        events.onNavigationStart({ url, isSameDocument: false, expectedSessionId });
        events.onLoadOk(expectedSessionId);
      },
      attach: () => {},
      setBounds: () => {},
      detach: () => {},
      destroy: () => destruction.resolve(),
      whenDestroyed: () => destruction.promise,
      executeJavaScript: () => evaluation.promise,
    });
    const service = new BrowserSessionService(
      adapter,
      LOCAL_BROWSER_TEST_AUTHORITY,
      makeProfileService(),
      () => ++clock,
      () => `session-${++idCounter}`,
      undefined,
      undefined,
      5,
      5,
    );
    const opened = await service.open(target("shutdown-eval"));
    if (!opened.ok) throw new Error("open failed");
    const evaluating = service.eval(opened.data.sessionId, "pending()");
    await Promise.resolve();

    await expect(service.drainUiOnQuit("test shutdown")).resolves.toMatchObject({
      clean: false,
      timedOut: true,
      activeOperations: ["eval"],
    });
    await expect(evaluating).resolves.toMatchObject({ ok: false, code: "cancelled" });

    evaluation.resolve({ __vellumEval: 1, status: "ok", json: "null" });
    await Promise.resolve();
    await expect(service.drainUiOnQuit("test shutdown")).resolves.toMatchObject({
      clean: true,
      activeOperations: [],
    });
  });

  it("does not let a same-document load promise escape the shutdown fixed point", async () => {
    const sameDocumentLoad = deferred<void>();
    const destruction = deferred<void>();
    let loads = 0;
    const adapter: BrowserViewAdapter = (_partition, events) => ({
      loadUrl: (url, expectedSessionId) => {
        loads += 1;
        if (loads === 1) {
          events.onNavigationStart({ url, isSameDocument: false, expectedSessionId });
          events.onLoadOk(expectedSessionId);
          return Promise.resolve();
        }
        return sameDocumentLoad.promise;
      },
      attach: () => {},
      setBounds: () => {},
      detach: () => {},
      destroy: () => destruction.resolve(),
      whenDestroyed: () => destruction.promise,
    });
    const service = new BrowserSessionService(
      adapter,
      LOCAL_BROWSER_TEST_AUTHORITY,
      makeProfileService(),
      () => ++clock,
      () => `session-${++idCounter}`,
      undefined,
      undefined,
      5,
      5,
    );
    const opened = await service.open(target("same-document-shutdown"));
    if (!opened.ok) throw new Error("open failed");
    await Promise.resolve();

    expect(service.goto(opened.data.sessionId, `${opened.data.url}#section`))
      .toMatchObject({ ok: true });
    await expect(service.drainUiOnQuit("test shutdown")).resolves.toMatchObject({
      clean: false,
      timedOut: true,
      activeOperations: ["goto"],
    });

    sameDocumentLoad.resolve();
    await Promise.resolve();
    await expect(service.drainUiOnQuit("test shutdown")).resolves.toMatchObject({
      clean: true,
      activeOperations: [],
    });
  });

  it("lists configured profiles and rejects empty detached captures", async () => {
    const emptyAdapter: BrowserViewAdapter = (_partition, events) => ({
      loadUrl: async (url, expectedSessionId) => {
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

  it("exposes typed profile-wipe recovery receipts and preserves domain failures", async () => {
    const base = makeProfileService();
    let outcome: "complete" | "restart_required" = "complete";
    const profiles: BrowserProfileServiceApi = {
      ...base,
      wipeProfile: () => Effect.succeed({ status: outcome }),
    };
    const { adapter } = makeSpyAdapter();
    const service = new BrowserSessionService(
      adapter,
      LOCAL_BROWSER_TEST_AUTHORITY,
      profiles,
    );

    expect(await service.wipeProfile("personal")).toEqual({
      ok: true,
      data: { profileId: "personal", status: "complete", recovery: "complete" },
    });
    outcome = "restart_required";
    expect(await service.wipeProfile("personal")).toEqual({
      ok: true,
      data: {
        profileId: "personal",
        status: "restart_required",
        recovery: "pending_restart",
      },
    });

    const denied: BrowserProfileServiceApi = {
      ...base,
      wipeProfile: () => Effect.fail(new BrowserProfileError({
        code: "forbidden",
        message: "cannot wipe the last browser profile",
      })),
    };
    expect(await new BrowserSessionService(
      adapter,
      LOCAL_BROWSER_TEST_AUTHORITY,
      denied,
    ).wipeProfile("personal"))
      .toMatchObject({ ok: false, code: "forbidden" });
    expect(await service.wipeProfile("../escape"))
      .toMatchObject({ ok: false, code: "invalid" });
  });
});
