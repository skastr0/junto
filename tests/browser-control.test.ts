import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Either, Schema } from "effect";
import {
  DoctorData,
  controlErr,
  controlOk,
  controlSocketPath,
  controlTokenPath,
  decodeControlEnvelope,
  encodeControlEnvelope,
  inspectControlJson,
} from "../src/shared/browser-control";
import {
  BROWSER_CONTROL_MAX_RESPONSE_BYTES,
  BROWSER_MAX_CANVAS_SOURCE_BYTES,
  BROWSER_MAX_ERROR_BYTES,
  BROWSER_MAX_EVAL_CODE_BYTES,
  BROWSER_MAX_EVAL_RESULT_BYTES,
  BROWSER_MAX_EVAL_RESULT_DEPTH,
  BROWSER_MAX_LIST_ROWS,
  BROWSER_MAX_METADATA_BYTES,
  BROWSER_MAX_REF_BYTES,
  BROWSER_MAX_SCREENSHOT_BYTES,
  BROWSER_MAX_SESSION_ID_BYTES,
  BROWSER_MAX_URL_BYTES,
  utf8ByteLength,
} from "../src/shared/browser-limits";
import {
  dispatchControlRequest,
  listPageNodes,
  makeControlHandlers,
  rotateControlToken,
  tokenMatches,
} from "../src/main/vellum/browser/control";
import type {
  PageTargetResolver,
  ResolvedPageTarget,
} from "../src/main/vellum/browser/page-target";
import { makeBrowserProfileService } from "../src/main/vellum/browser/profiles";
import {
  BrowserSessionService,
  type BrowserViewAdapter,
  type BrowserViewHandle,
} from "../src/main/vellum/browser/sessions";
import { LOCAL_BROWSER_TEST_AUTHORITY } from "./browser-host-test-authority";
import {
  BROWSER_CAPABILITY_ACTIONS,
  makeBrowserCapabilityRegistry,
  type BrowserCapabilityRegistry,
} from "../src/main/vellum/browser/capabilities";

const REF = "vellum://canvas/work?node=n1";
const DEFAULT_TARGET: ResolvedPageTarget = {
  ref: REF,
  nodeId: "n1",
  hostId: "local",
  url: "https://example.com/",
  profile: "personal",
};

const resolverFor = (
  targets: Readonly<Record<string, ResolvedPageTarget>> = { [REF]: DEFAULT_TARGET },
): PageTargetResolver => async (candidate) => {
  if (typeof candidate !== "string") {
    return { ok: false, code: "invalid", message: "canonical ref required" };
  }
  const target = targets[candidate];
  return target === undefined
    ? { ok: false, code: "not_found", message: "page not found" }
    : { ok: true, data: target };
};

const makeSpyAdapter = (options: {
  readonly evaluate?: (code: string) => unknown | Promise<unknown>;
  readonly capture?: () => Uint8Array | Promise<Uint8Array>;
  readonly acknowledgeDestroy?: boolean;
} = {}) => {
  const evalCalls: string[] = [];
  const destroyCalls: string[] = [];
  const destroyResolvers: Array<() => void> = [];
  const adapter: BrowserViewAdapter = (_partition, events) => {
    let resolveDestroyed!: () => void;
    const destroyed = new Promise<void>((resolve) => {
      resolveDestroyed = resolve;
    });
    const handle: BrowserViewHandle = {
      loadUrl: async (url, expectedSessionId) => {
        const sessionId = events.onNavigationStart({
          url: new URL(url).href,
          isSameDocument: false,
          expectedSessionId,
        });
        if (sessionId !== undefined) {
          events.onNavigationUrl(sessionId, new URL(url).href);
          events.onLoadOk(sessionId, "loaded");
        }
      },
      attach: () => {},
      setBounds: () => {},
      detach: () => {},
      destroy: () => {
        destroyCalls.push("destroy");
        if (options.acknowledgeDestroy !== false) resolveDestroyed();
      },
      whenDestroyed: () => destroyed,
      executeJavaScript: async (code) => {
        evalCalls.push(code);
        if (code === "boom") throw new Error("eval exploded");
        const value = options.evaluate !== undefined
          ? await options.evaluate(code)
          : code === "void 0"
            ? undefined
            : { title: "hello" };
        try {
          const json = JSON.stringify(value ?? null);
          return json === undefined
            ? { __vellumEval: 1, status: "unsupported_result", message: "unsupported" }
            : { __vellumEval: 1, status: "ok", json };
        } catch {
          return { __vellumEval: 1, status: "unsupported_result", message: "unsupported" };
        }
      },
      capturePagePng: async () =>
        options.capture === undefined
          ? new Uint8Array([0x89, 0x50, 0x4e, 0x47])
          : options.capture(),
    };
    destroyResolvers.push(resolveDestroyed);
    return handle;
  };
  return {
    adapter,
    evalCalls,
    destroyCalls,
    resolveDestroyed: (index = 0): void => destroyResolvers[index]?.(),
  };
};

describe("browser control envelopes (pure)", () => {
  it("round-trips ok and error envelopes through the wire decoder", () => {
    expect(Either.isRight(decodeControlEnvelope(JSON.parse(JSON.stringify(controlOk({ n: 1 })))))).toBe(true);
    const failure = decodeControlEnvelope(
      JSON.parse(JSON.stringify(controlErr("runtime_down", "app not running"))),
    );
    expect(Either.isRight(failure)).toBe(true);
    if (Either.isRight(failure) && !failure.right.ok) {
      expect(failure.right.error._tag).toBe("runtime_down");
    }
  });

  it("rejects malformed envelopes", () => {
    for (const bad of [null, 42, { ok: "yes" }, { ok: false, error: { message: "x" } }]) {
      expect(Either.isLeft(decodeControlEnvelope(bad))).toBe(true);
    }
  });

  it("serializes only bounded finite plain JSON and clamps UTF-8 errors", () => {
    const normal = encodeControlEnvelope(controlOk({ result: { title: "hello", rows: [1, true, null] } }));
    expect(JSON.parse(normal)).toEqual({
      ok: true,
      data: { result: { title: "hello", rows: [1, true, null] } },
    });
    const encodedError = encodeControlEnvelope(
      controlErr("failed", "😀".repeat(BROWSER_MAX_ERROR_BYTES)),
    );
    const parsedError = JSON.parse(encodedError) as { error: { message: string } };
    expect(utf8ByteLength(parsedError.error.message)).toBeLessThanOrEqual(BROWSER_MAX_ERROR_BYTES);
    expect(Buffer.byteLength(encodedError)).toBeLessThanOrEqual(BROWSER_CONTROL_MAX_RESPONSE_BYTES);

    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    const accessor = Object.defineProperty({}, "secret", {
      enumerable: true,
      get: () => "must-not-run",
    });
    const symbolKey = { visible: true, [Symbol("hidden")]: "secret" };
    const sparse = new Array(2);
    sparse[1] = "present";
    for (const unsupported of [
      cyclic,
      { result: 1n },
      { result: undefined },
      { result: () => 1 },
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      accessor,
      symbolKey,
      sparse,
      new Date(),
    ]) {
      const inspected = inspectControlJson(unsupported, BROWSER_CONTROL_MAX_RESPONSE_BYTES);
      expect(inspected.ok).toBe(false);
      if (!inspected.ok) expect(inspected.error._tag).toBe("unsupported_result");
    }

    let deep: Record<string, unknown> = {};
    for (let depth = 0; depth <= BROWSER_MAX_EVAL_RESULT_DEPTH; depth += 1) deep = { next: deep };
    expect(inspectControlJson(deep, BROWSER_CONTROL_MAX_RESPONSE_BYTES)).toMatchObject({
      ok: false,
      error: { _tag: "result_too_large" },
    });
    expect(inspectControlJson("x".repeat(8), 10)).toMatchObject({ ok: true, bytes: 10 });
    expect(inspectControlJson("x".repeat(9), 10)).toMatchObject({
      ok: false,
      error: { _tag: "result_too_large" },
    });
    expect(inspectControlJson("😀😀", 10)).toMatchObject({ ok: true, bytes: 10 });
    expect(inspectControlJson("😀😀x", 10)).toMatchObject({
      ok: false,
      error: { _tag: "result_too_large" },
    });
  });

  it("derives socket/token paths under ~/.vellum/browser", () => {
    expect(controlSocketPath("/home/u")).toBe("/home/u/.vellum/browser/control.sock");
    expect(controlTokenPath("/home/u")).toBe("/home/u/.vellum/browser/control.token");
  });
});

describe("token handling", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "vellum-control-token-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("atomically rotates owner-only transport material every app run", async () => {
    const path = join(root, "control.token");
    const first = rotateControlToken(path);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const second = rotateControlToken(path);
    expect(second).toMatch(/^[0-9a-f]{64}$/);
    expect(second).not.toBe(first);
    expect((await readFile(path, "utf8")).trim()).toBe(second);
    expect((await readdir(root)).filter((name) => name.includes(".tmp"))).toEqual([]);
  });

  it("replaces a stale token symlink without following it", async () => {
    const target = join(root, "unrelated");
    const path = join(root, "control.token");
    await writeFile(target, "do-not-touch");
    await symlink(target, path);

    const token = rotateControlToken(path);

    expect(await readFile(target, "utf8")).toBe("do-not-touch");
    expect((await readFile(path, "utf8")).trim()).toBe(token);
    expect((await stat(path)).isFile()).toBe(true);
  });

  it("accepts only the exact token", () => {
    expect(tokenMatches("secret", "secret")).toBe(true);
    for (const presented of ["secre", "secretX", undefined, ""]) {
      expect(tokenMatches(presented, "secret")).toBe(false);
    }
  });
});

describe("control route handlers", () => {
  let root: string;
  let sessionCounter: number;
  let requestCounter: number;
  const capabilityRegistries: BrowserCapabilityRegistry[] = [];
  const TOKEN = "test-token";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "vellum-control-"));
    sessionCounter = 0;
    requestCounter = 0;
  });
  afterEach(async () => {
    for (const registry of capabilityRegistries.splice(0)) registry.close();
    await rm(root, { recursive: true, force: true });
  });

  const makeStack = (
    adapter: BrowserViewAdapter = makeSpyAdapter().adapter,
    resolvePageTarget: PageTargetResolver = resolverFor(),
    screenshotFiles?: {
      readonly ensureDirectory?: (path: string) => Promise<void>;
      readonly makePath?: (directory: string) => string;
      readonly writeExclusive?: (path: string, data: Uint8Array) => Promise<void>;
      readonly remove?: (path: string) => Promise<void>;
    },
    viewDestroyTimeoutMs?: number,
  ) => {
    const sessions = new BrowserSessionService(
      adapter,
      LOCAL_BROWSER_TEST_AUTHORITY,
      makeBrowserProfileService(join(root, "browser")),
      Date.now,
      () => `session-${++sessionCounter}`,
      undefined,
      undefined,
      viewDestroyTimeoutMs,
    );
    const capabilities = makeBrowserCapabilityRegistry({
      onTerminate: (notice) => {
        sessions.destroyOwnerSessions(notice.auditId, "browser authority ended");
      },
    });
    capabilityRegistries.push(capabilities);
    const principal = capabilities.createPrincipal();
    const grant = capabilities.issue(principal, {
      actions: BROWSER_CAPABILITY_ACTIONS,
      targets: [{
        ref: REF,
        hostId: DEFAULT_TARGET.hostId,
        profile: DEFAULT_TARGET.profile,
        exactOrigins: [new URL(DEFAULT_TARGET.url).origin],
      }],
      ttlMs: 60_000,
      maxUses: 10_000,
      maxInFlight: 32,
    });
    const handlers = makeControlHandlers({
      sessions,
      capabilities,
      resolvePageTarget,
      version: "0.0.0-test",
      canvasesDir: join(root, "canvases"),
      shotsDir: join(root, "shots"),
      ...(screenshotFiles === undefined ? {} : { screenshotFiles }),
    });
    const call = (
      method: string,
      path: string,
      body?: unknown,
      token: string | null = TOKEN,
      signal?: AbortSignal,
      capability: string | null = grant.secret,
      requestId: string | null = (++requestCounter).toString(16).padStart(32, "0"),
    ) =>
      dispatchControlRequest(
        handlers,
        TOKEN,
        {
          method,
          path,
          token: token ?? undefined,
          capability: capability ?? undefined,
          requestId: requestId ?? undefined,
          body,
        },
        signal,
      );
    return { call, sessions, capabilities, principal, grant };
  };

  it("authenticates every route and rejects unknown routes", async () => {
    const { call } = makeStack();
    for (const token of [null, "wrong"]) {
      const response = await call("GET", "/doctor", undefined, token);
      expect(response.status).toBe(401);
      if (!response.envelope.ok) expect(response.envelope.error._tag).toBe("unauthorized");
    }
    const sentinel = Buffer.alloc(32, 0xd7).toString("base64url");
    const unknown = await call("GET", `/missing/${sentinel}`);
    expect(unknown).toEqual({
      status: 404,
      envelope: {
        ok: false,
        error: { _tag: "bad_request", message: "unknown route" },
      },
    });
    expect(JSON.stringify(unknown)).not.toContain(sentinel);
  });

  it("reports doctor data through the shared schema", async () => {
    const response = await makeStack().call("GET", "/doctor");
    expect(response.status).toBe(200);
    if (response.envelope.ok) {
      const decoded = Schema.decodeUnknownEither(DoctorData)(response.envelope.data);
      expect(Either.isRight(decoded)).toBe(true);
      if (Either.isRight(decoded)) expect(decoded.right).toEqual({ status: "ok" });
    }
  });

  it("requires a capability and UUID request id on every protected route", async () => {
    const { call, grant } = makeStack();
    expect(await call("GET", "/profiles", undefined, TOKEN, undefined, null)).toMatchObject({
      status: 401,
      envelope: { ok: false, error: { _tag: "unauthorized" } },
    });
    expect(
      await call("GET", "/profiles", undefined, TOKEN, undefined, grant.secret, null),
    ).toMatchObject({
      status: 400,
      envelope: { ok: false, error: { _tag: "bad_request" } },
    });
    expect(
      await call("GET", "/profiles", undefined, TOKEN, undefined, grant.secret, "not-a-uuid"),
    ).toMatchObject({
      status: 400,
      envelope: { ok: false, error: { _tag: "bad_request" } },
    });
  });

  it("enforces action grants and rejects replayed request ids", async () => {
    const { call, capabilities } = makeStack();
    const principal = capabilities.createPrincipal();
    const profilesOnly = capabilities.issue(principal, {
      actions: ["profiles"],
      targets: [{
        ref: REF,
        hostId: DEFAULT_TARGET.hostId,
        profile: DEFAULT_TARGET.profile,
        exactOrigins: [new URL(DEFAULT_TARGET.url).origin],
      }],
      ttlMs: 60_000,
      maxUses: 4,
      maxInFlight: 1,
    });
    const requestId = "a".repeat(32);
    expect(
      await call("GET", "/profiles", undefined, TOKEN, undefined, profilesOnly.secret, requestId),
    ).toMatchObject({ status: 200, envelope: { ok: true } });
    expect(
      await call("GET", "/pages", undefined, TOKEN, undefined, profilesOnly.secret),
    ).toMatchObject({
      status: 403,
      envelope: { ok: false, error: { _tag: "forbidden" } },
    });
    expect(
      await call("GET", "/profiles", undefined, TOKEN, undefined, profilesOnly.secret, requestId),
    ).toMatchObject({
      status: 403,
      envelope: { ok: false, error: { _tag: "forbidden" } },
    });
  });

  it("accepts only query-free origin-form request targets", async () => {
    const { call } = makeStack();
    for (const path of [
      "/profiles?include=all",
      "/profiles#fragment",
      "//profiles",
      "http://control.local/profiles",
      "*",
    ]) {
      expect(await call("GET", path)).toMatchObject({
        status: 400,
        envelope: { ok: false, error: { _tag: "bad_request" } },
      });
    }
  });

  it("reuses an already bound warm owner session", async () => {
    const { call } = makeStack();
    const first = await call("POST", "/open", { ref: REF });
    const second = await call("POST", "/open", { ref: REF });
    expect(first).toMatchObject({ status: 200, envelope: { ok: true } });
    expect(second).toMatchObject({ status: 200, envelope: { ok: true } });
    if (!first.envelope.ok || !second.envelope.ok) throw new Error("open failed");
    expect((second.envelope.data as { sessionId: string }).sessionId).toBe(
      (first.envelope.data as { sessionId: string }).sessionId,
    );
  });

  it("isolates sibling capability namespaces within one principal", async () => {
    const { call, sessions, capabilities, principal, grant } = makeStack();
    const sibling = capabilities.issue(principal, {
      actions: BROWSER_CAPABILITY_ACTIONS,
      targets: [{
        ref: REF,
        hostId: DEFAULT_TARGET.hostId,
        profile: DEFAULT_TARGET.profile,
        exactOrigins: [new URL(DEFAULT_TARGET.url).origin],
      }],
      ttlMs: 60_000,
      maxUses: 16,
      maxInFlight: 2,
    });
    expect(sibling.ownerId).toBe(grant.ownerId);
    expect(sibling.auditId).not.toBe(grant.auditId);

    const first = await call("POST", "/open", { ref: REF });
    const second = await call(
      "POST",
      "/open",
      { ref: REF },
      TOKEN,
      undefined,
      sibling.secret,
    );
    expect(first).toMatchObject({ status: 200, envelope: { ok: true } });
    expect(second).toMatchObject({ status: 200, envelope: { ok: true } });
    if (!first.envelope.ok || !second.envelope.ok) throw new Error("open failed");
    const firstSessionId = (first.envelope.data as { sessionId: string }).sessionId;
    const secondSessionId = (second.envelope.data as { sessionId: string }).sessionId;
    expect(secondSessionId).not.toBe(firstSessionId);
    expect(sessions.listForOwner(grant.auditId)).toMatchObject({
      ok: true,
      data: [{ sessionId: firstSessionId }],
    });
    expect(sessions.listForOwner(sibling.auditId)).toMatchObject({
      ok: true,
      data: [{ sessionId: secondSessionId }],
    });
    expect(sessions.listForOwner(grant.ownerId)).toMatchObject({ ok: true, data: [] });

    expect(capabilities.revoke(grant.handle, "operator")).toBe(true);
    expect(sessions.listForOwner(grant.auditId)).toMatchObject({ ok: true, data: [] });
    expect(sessions.listForOwner(sibling.auditId)).toMatchObject({
      ok: true,
      data: [{ sessionId: secondSessionId }],
    });
    expect(
      await call(
        "POST",
        "/eval",
        { sessionId: secondSessionId, code: "document.title" },
        TOKEN,
        undefined,
        sibling.secret,
      ),
    ).toMatchObject({
      status: 200,
      envelope: { ok: true, data: { result: { title: "hello" } } },
    });
  });

  it("lists only bound owner generations and rebinds a closed warm session", async () => {
    const canvasesDir = join(root, "canvases");
    await mkdir(canvasesDir, { recursive: true });
    await writeFile(
      join(canvasesDir, "work.canvas"),
      JSON.stringify({
        nodes: [{
          id: "n1",
          type: "link",
          url: DEFAULT_TARGET.url,
          x: 0,
          y: 0,
          width: 400,
          height: 300,
          ether: {
            entity: { kind: "page" },
            browser: { profile: DEFAULT_TARGET.profile },
          },
        }],
        edges: [],
      }),
    );
    const { call, sessions, capabilities, grant } = makeStack();
    const opened = await call("POST", "/open", { ref: REF });
    if (!opened.envelope.ok) throw new Error("open failed");
    const sessionId = (opened.envelope.data as { sessionId: string }).sessionId;

    const siblingPrincipal = capabilities.createPrincipal();
    const sibling = capabilities.issue(siblingPrincipal, {
      actions: ["sessions", "pages"],
      targets: [{
        ref: REF,
        hostId: DEFAULT_TARGET.hostId,
        profile: DEFAULT_TARGET.profile,
        exactOrigins: [new URL(DEFAULT_TARGET.url).origin],
      }],
      ttlMs: 60_000,
      maxUses: 4,
      maxInFlight: 1,
    });
    expect(
      await call("GET", "/sessions", undefined, TOKEN, undefined, sibling.secret),
    ).toMatchObject({ status: 200, envelope: { ok: true, data: [] } });
    expect(
      await call("GET", "/pages", undefined, TOKEN, undefined, sibling.secret),
    ).toMatchObject({
      status: 200,
      envelope: { ok: true, data: [{ ref: REF, sessionId: null }] },
    });

    expect(await call("POST", "/close", { sessionId })).toMatchObject({
      status: 200,
      envelope: { ok: true },
    });
    expect(sessions.stateForOwner(grant.auditId, sessionId)).toMatchObject({
      ok: true,
      data: { state: "detached" },
    });
    expect(await call("GET", "/sessions")).toMatchObject({
      status: 200,
      envelope: { ok: true, data: [] },
    });
    expect(await call("GET", "/pages")).toMatchObject({
      status: 200,
      envelope: { ok: true, data: [{ ref: REF, sessionId: null }] },
    });
    expect(await call("POST", "/eval", { sessionId, code: "1" })).toMatchObject({
      status: 403,
      envelope: { ok: false, error: { _tag: "forbidden" } },
    });

    const reopened = await call("POST", "/open", { ref: REF });
    expect(reopened).toMatchObject({ status: 200, envelope: { ok: true } });
    if (!reopened.envelope.ok) throw new Error("reopen failed");
    expect((reopened.envelope.data as { sessionId: string }).sessionId).toBe(sessionId);
    expect(await call("GET", "/sessions")).toMatchObject({
      status: 200,
      envelope: { ok: true, data: [{ sessionId, ref: REF }] },
    });
    expect(await call("GET", "/pages")).toMatchObject({
      status: 200,
      envelope: { ok: true, data: [{ ref: REF, sessionId }] },
    });
  });

  it("stops a capability-scoped page, removes it from discovery, and remains idempotent", async () => {
    const spy = makeSpyAdapter();
    const { call, sessions, grant } = makeStack(spy.adapter);
    const opened = await call("POST", "/open", { ref: REF });
    if (!opened.envelope.ok) throw new Error("open failed");
    const sessionId = (opened.envelope.data as { sessionId: string }).sessionId;

    expect(await call("POST", "/stop", { sessionId })).toMatchObject({
      status: 200,
      envelope: {
        ok: true,
        data: { sessionId, stopped: true, alreadyStopped: false },
      },
    });
    expect(spy.destroyCalls).toEqual(["destroy"]);
    expect(sessions.listForOwner(grant.auditId)).toMatchObject({ ok: true, data: [] });
    expect(await call("GET", "/sessions")).toMatchObject({
      status: 200,
      envelope: { ok: true, data: [] },
    });
    expect(await call("POST", "/eval", { sessionId, code: "1" })).toMatchObject({
      status: 404,
      envelope: { ok: false, error: { _tag: "not_found" } },
    });

    expect(await call("POST", "/stop", { sessionId })).toMatchObject({
      status: 200,
      envelope: { ok: true, data: { alreadyStopped: true } },
    });
    expect(spy.destroyCalls).toEqual(["destroy"]);
  });

  it("unbinds the stopped generation after a late acknowledgement retry so the page can reopen", async () => {
    const spy = makeSpyAdapter({ acknowledgeDestroy: false });
    const { call } = makeStack(spy.adapter, resolverFor(), undefined, 5);
    const opened = await call("POST", "/open", { ref: REF });
    if (!opened.envelope.ok) throw new Error("open failed");
    const sessionId = (opened.envelope.data as { sessionId: string }).sessionId;

    expect(await call("POST", "/stop", { sessionId })).toMatchObject({
      status: 504,
      envelope: { ok: false, error: { _tag: "timeout" } },
    });
    spy.resolveDestroyed();
    expect(await call("POST", "/stop", { sessionId })).toMatchObject({
      status: 200,
      envelope: { ok: true, data: { alreadyStopped: true } },
    });
    expect(await call("POST", "/open", { ref: REF })).toMatchObject({
      status: 200,
      envelope: { ok: true },
    });
    expect(spy.destroyCalls).toEqual(["destroy"]);
  });

  it("destroys owner sessions when the canonical target changes during open", async () => {
    let resolutions = 0;
    const resolver: PageTargetResolver = async (ref) => {
      const resolved = await resolverFor()(ref);
      if (!resolved.ok) return resolved;
      resolutions += 1;
      return resolutions === 1
        ? resolved
        : { ok: true, data: { ...resolved.data, url: "https://example.com/changed" } };
    };
    const { call, sessions, grant } = makeStack(makeSpyAdapter().adapter, resolver);
    expect(await call("POST", "/open", { ref: REF })).toMatchObject({
      status: 400,
      envelope: { ok: false, error: { _tag: "invalid" } },
    });
    expect(sessions.listForOwner(grant.auditId)).toMatchObject({ ok: true, data: [] });
  });

  it("opens by canonical ref then uses the returned generation handle", async () => {
    const spy = makeSpyAdapter();
    const { call } = makeStack(spy.adapter);
    const opened = await call("POST", "/open", { ref: REF });
    expect(opened.status).toBe(200);
    if (!opened.envelope.ok) throw new Error("open failed");
    const firstId = (opened.envelope.data as { sessionId: string }).sessionId;

    const navigated = await call("POST", "/goto", {
      sessionId: firstId,
      url: "https://example.com/2",
    });
    expect(navigated.status).toBe(200);
    if (!navigated.envelope.ok) throw new Error("goto failed");
    const currentId = (navigated.envelope.data as { sessionId: string }).sessionId;
    expect(currentId).not.toBe(firstId);

    const evaluated = await call("POST", "/eval", {
      sessionId: currentId,
      code: "document.title",
    });
    expect(evaluated).toMatchObject({
      status: 200,
      envelope: { ok: true, data: { result: { title: "hello" } } },
    });
    expect(spy.evalCalls).toContain("document.title");

    const shot = await call("POST", "/screenshot", { sessionId: currentId });
    expect(shot.status).toBe(200);
    if (shot.envelope.ok) {
      const data = shot.envelope.data as { path: string; bytes: number };
      expect(data.bytes).toBe(4);
      expect((await readFile(data.path)).subarray(0, 4)).toEqual(
        Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      );
    }
    expect(await call("POST", "/close", { sessionId: currentId })).toMatchObject({
      status: 200,
      envelope: { ok: true, data: { state: "detached" } },
    });
  });

  it("normalizes undefined eval and preserves typed eval failure", async () => {
    const spy = makeSpyAdapter();
    const { call } = makeStack(spy.adapter);
    const opened = await call("POST", "/open", { ref: REF });
    if (!opened.envelope.ok) throw new Error("open failed");
    const sessionId = (opened.envelope.data as { sessionId: string }).sessionId;
    expect(await call("POST", "/eval", { sessionId, code: "void 0" })).toMatchObject({
      envelope: { ok: true, data: { result: null } },
    });
    const failed = await call("POST", "/eval", { sessionId, code: "boom" });
    expect(failed.status).toBe(500);
    if (!failed.envelope.ok) expect(failed.envelope.error.message).toContain("eval exploded");
  });

  it("rejects unsupported and oversized eval results before the wire", async () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    const spy = makeSpyAdapter({
      evaluate: (code) =>
        code === "cyclic"
          ? cyclic
          : code === "bigint"
            ? { value: 1n }
            : "x".repeat(BROWSER_MAX_EVAL_RESULT_BYTES + 1),
    });
    const { call } = makeStack(spy.adapter);
    const opened = await call("POST", "/open", { ref: REF });
    if (!opened.envelope.ok) throw new Error("open failed");
    const sessionId = (opened.envelope.data as { sessionId: string }).sessionId;
    for (const code of ["cyclic", "bigint"]) {
      expect(await call("POST", "/eval", { sessionId, code })).toMatchObject({
        status: 422,
        envelope: { ok: false, error: { _tag: "unsupported_result" } },
      });
    }
    expect(await call("POST", "/eval", { sessionId, code: "oversized" })).toMatchObject({
      status: 413,
      envelope: { ok: false, error: { _tag: "result_too_large" } },
    });
  });

  it("returns not_found for valid stale handles and bad_request for malformed substitutions", async () => {
    const { call } = makeStack();
    for (const [path, body] of [
      ["/goto", { sessionId: "n1", url: "https://x.dev" }],
      ["/screenshot", { sessionId: "ghost" }],
      ["/close", { sessionId: "ghost" }],
      ["/stop", { sessionId: "ghost" }],
    ] as const) {
      const response = await call("POST", path, body);
      expect(response.status).toBe(404);
      if (!response.envelope.ok) expect(response.envelope.error._tag).toBe("not_found");
    }
    expect(await call("POST", "/eval", { sessionId: REF, code: "1" })).toMatchObject({
      status: 400,
      envelope: { ok: false, error: { _tag: "bad_request" } },
    });
  });

  it("rejects malformed and substituted open bodies before resolution", async () => {
    let resolutions = 0;
    const resolver: PageTargetResolver = async (ref) => {
      resolutions += 1;
      return resolverFor()(ref);
    };
    const { call } = makeStack(makeSpyAdapter().adapter, resolver);
    for (const body of [
      { ref: 42 },
      { nodeId: "n1", url: "https://attacker.example.com", profile: "personal" },
      { ref: REF, url: "https://attacker.example.com" },
      { ref: REF, profile: "work" },
    ]) {
      const response = await call("POST", "/open", body);
      expect(response.status).toBe(400);
      if (!response.envelope.ok) expect(response.envelope.error._tag).toBe("bad_request");
    }
    expect(resolutions).toBe(0);
  });

  it("rejects an out-of-scope canonical ref before document resolution", async () => {
    let resolutions = 0;
    const resolver: PageTargetResolver = async (ref) => {
      resolutions += 1;
      return resolverFor()(ref);
    };
    const { call } = makeStack(makeSpyAdapter().adapter, resolver);
    expect(
      await call("POST", "/open", { ref: "vellum://canvas/work?node=other" }),
    ).toMatchObject({
      status: 403,
      envelope: { ok: false, error: { _tag: "forbidden" } },
    });
    expect(resolutions).toBe(0);
  });

  it("rejects oversized powerful fields and invalid session handles before dispatch", async () => {
    let resolutions = 0;
    const resolver: PageTargetResolver = async (ref) => {
      resolutions += 1;
      return resolverFor()(ref);
    };
    const spy = makeSpyAdapter();
    const { call } = makeStack(spy.adapter, resolver);
    const cases = [
      ["/open", { ref: "x".repeat(BROWSER_MAX_REF_BYTES + 1) }],
      ["/goto", { sessionId: "x".repeat(BROWSER_MAX_SESSION_ID_BYTES + 1), url: "https://example.com" }],
      ["/goto", { sessionId: "session-1", url: `https://example.com/${"x".repeat(BROWSER_MAX_URL_BYTES)}` }],
      ["/eval", { sessionId: "session-1", code: "x".repeat(BROWSER_MAX_EVAL_CODE_BYTES + 1) }],
      ["/screenshot", { sessionId: "has space" }],
      ["/close", { sessionId: "" }],
      ["/stop", { sessionId: "" }],
    ] as const;
    for (const [path, body] of cases) {
      expect(await call("POST", path, body)).toMatchObject({
        status: 400,
        envelope: { ok: false, error: { _tag: "bad_request" } },
      });
    }
    expect(resolutions).toBe(0);
    expect(spy.evalCalls).toEqual([]);
  });

  it("propagates an aborted signal into open, goto, eval, and screenshot", async () => {
    const aborted = new AbortController();
    aborted.abort();
    const unopened = makeStack();
    expect(await unopened.call("POST", "/open", { ref: REF }, TOKEN, aborted.signal)).toMatchObject({
      status: 408,
      envelope: { ok: false, error: { _tag: "cancelled" } },
    });
    expect(unopened.sessions.list()).toMatchObject({ ok: true, data: [] });

    for (const [path, bodyFor] of [
      ["/goto", (sessionId: string) => ({ sessionId, url: "https://example.com/#next" })],
      ["/eval", (sessionId: string) => ({ sessionId, code: "1" })],
      ["/screenshot", (sessionId: string) => ({ sessionId })],
    ] as const) {
      const stack = makeStack();
      const opened = await stack.call("POST", "/open", { ref: REF });
      if (!opened.envelope.ok) throw new Error("open failed");
      const sessionId = (opened.envelope.data as { sessionId: string }).sessionId;
      expect(await stack.call("POST", path, bodyFor(sessionId), TOKEN, aborted.signal)).toMatchObject({
        status: 408,
        envelope: { ok: false, error: { _tag: "cancelled" } },
      });
    }
  });

  it("enforces the URL allowlist on the document-derived target", async () => {
    const badRef = "vellum://canvas/work?node=bad";
    const { call } = makeStack(
      makeSpyAdapter().adapter,
      resolverFor({
        [badRef]: {
          ref: badRef,
          nodeId: "bad",
          hostId: "local",
          url: "file:///etc/passwd",
          profile: "personal",
        },
      }),
    );
    const response = await call("POST", "/open", { ref: badRef });
    expect(response.status).toBe(403);
    if (!response.envelope.ok) expect(response.envelope.error._tag).toBe("forbidden");
  });

  it("rejects every caller-provided screenshot path", async () => {
    const { call } = makeStack();
    const opened = await call("POST", "/open", { ref: REF });
    if (!opened.envelope.ok) throw new Error("open failed");
    const sessionId = (opened.envelope.data as { sessionId: string }).sessionId;
    for (const path of ["shots/x.png", "/tmp/x.png"]) {
      expect(await call("POST", "/screenshot", { sessionId, path })).toMatchObject({
        status: 400,
        envelope: { ok: false, error: { _tag: "bad_request" } },
      });
    }
  });

  it("writes random owner-only PNGs inside the server shots directory", async () => {
    const { call } = makeStack();
    const opened = await call("POST", "/open", { ref: REF });
    if (!opened.envelope.ok) throw new Error("open failed");
    const sessionId = (opened.envelope.data as { sessionId: string }).sessionId;
    const paths: string[] = [];
    for (let index = 0; index < 2; index += 1) {
      const response = await call("POST", "/screenshot", { sessionId });
      if (!response.envelope.ok) throw new Error("screenshot failed");
      const data = response.envelope.data as { path: string; bytes: number };
      expect(dirname(resolve(data.path))).toBe(resolve(join(root, "shots")));
      expect(data.path).toMatch(/[0-9a-f]{48}\.png$/);
      expect((await stat(data.path)).mode & 0o777).toBe(0o600);
      paths.push(data.path);
    }
    expect(new Set(paths).size).toBe(2);
  });

  it("does not overwrite, escape, follow a shots symlink, or write oversized pixels", async () => {
    const shotsDir = join(root, "shots");
    await mkdir(shotsDir, { recursive: true });
    const existing = join(shotsDir, "existing.png");
    await writeFile(existing, "preserve-me");
    const collision = makeStack(makeSpyAdapter().adapter, resolverFor(), { makePath: () => existing });
    const opened = await collision.call("POST", "/open", { ref: REF });
    if (!opened.envelope.ok) throw new Error("open failed");
    const id = (opened.envelope.data as { sessionId: string }).sessionId;
    expect(await collision.call("POST", "/screenshot", { sessionId: id })).toMatchObject({
      status: 500,
      envelope: { ok: false, error: { _tag: "failed" } },
    });
    expect(await readFile(existing, "utf8")).toBe("preserve-me");

    let writes = 0;
    const escaping = makeStack(makeSpyAdapter().adapter, resolverFor(), {
      makePath: () => join(root, "outside.png"),
      writeExclusive: async () => { writes += 1; },
    });
    const escapedOpen = await escaping.call("POST", "/open", { ref: REF });
    if (!escapedOpen.envelope.ok) throw new Error("open failed");
    const escapedId = (escapedOpen.envelope.data as { sessionId: string }).sessionId;
    expect(await escaping.call("POST", "/screenshot", { sessionId: escapedId })).toMatchObject({
      status: 400,
      envelope: { ok: false, error: { _tag: "invalid" } },
    });
    expect(writes).toBe(0);

    await rm(shotsDir, { recursive: true });
    const outside = join(root, "outside");
    await mkdir(outside);
    await symlink(outside, shotsDir);
    const linked = makeStack();
    const linkedOpen = await linked.call("POST", "/open", { ref: REF });
    if (!linkedOpen.envelope.ok) throw new Error("open failed");
    const linkedId = (linkedOpen.envelope.data as { sessionId: string }).sessionId;
    expect(await linked.call("POST", "/screenshot", { sessionId: linkedId })).toMatchObject({
      status: 500,
      envelope: { ok: false, error: { _tag: "failed" } },
    });
    expect(await readdir(outside)).toEqual([]);

    await rm(shotsDir);
    const oversized = makeStack(
      makeSpyAdapter({ capture: () => new Uint8Array(BROWSER_MAX_SCREENSHOT_BYTES + 1) }).adapter,
      resolverFor(),
      { writeExclusive: async () => { writes += 1; } },
    );
    const oversizedOpen = await oversized.call("POST", "/open", { ref: REF });
    if (!oversizedOpen.envelope.ok) throw new Error("open failed");
    const oversizedId = (oversizedOpen.envelope.data as { sessionId: string }).sessionId;
    expect(await oversized.call("POST", "/screenshot", { sessionId: oversizedId })).toMatchObject({
      status: 413,
      envelope: { ok: false, error: { _tag: "result_too_large" } },
    });
  });

  it("does not persist screenshot bytes after the captured generation is replaced", async () => {
    let resolveCapture!: (png: Uint8Array) => void;
    const capture = new Promise<Uint8Array>((resolve) => {
      resolveCapture = resolve;
    });
    let events: Parameters<BrowserViewAdapter>[1] | undefined;
    const adapter: BrowserViewAdapter = (_partition, nextEvents) => {
      events = nextEvents;
      return {
        loadUrl: async (url, expectedSessionId) => {
          const id = nextEvents.onNavigationStart({ url, isSameDocument: false, expectedSessionId });
          if (id !== undefined) nextEvents.onLoadOk(id);
        },
        attach: () => {},
        setBounds: () => {},
        detach: () => {},
        destroy: () => {},
        capturePagePng: () => capture,
      };
    };
    const { call } = makeStack(adapter);
    const opened = await call("POST", "/open", { ref: REF });
    if (!opened.envelope.ok) throw new Error("open failed");
    const sessionId = (opened.envelope.data as { sessionId: string }).sessionId;
    const pending = call("POST", "/screenshot", { sessionId });
    events?.onNavigationStart({ url: "https://replacement.example.com", isSameDocument: false });
    resolveCapture(new Uint8Array([1, 2, 3]));
    expect(await pending).toMatchObject({ status: 404, envelope: { ok: false } });
    expect(await readdir(join(root, "shots")).catch(() => [])).toEqual([]);
  });

  it("rechecks the generation after directory creation before writing pixels", async () => {
    let releaseDirectory!: () => void;
    let directoryStarted!: () => void;
    const directoryGate = new Promise<void>((resolve) => {
      releaseDirectory = resolve;
    });
    const started = new Promise<void>((resolve) => {
      directoryStarted = resolve;
    });
    const writes: string[] = [];
    let events: Parameters<BrowserViewAdapter>[1] | undefined;
    const adapter: BrowserViewAdapter = (_partition, nextEvents) => {
      events = nextEvents;
      return {
        loadUrl: async (url, expectedSessionId) => {
          const id = nextEvents.onNavigationStart({ url, isSameDocument: false, expectedSessionId });
          if (id !== undefined) nextEvents.onLoadOk(id);
        },
        attach: () => {},
        setBounds: () => {},
        detach: () => {},
        destroy: () => {},
        capturePagePng: async () => new Uint8Array([1, 2, 3]),
      };
    };
    const { call } = makeStack(adapter, resolverFor(), {
      ensureDirectory: async () => {
        directoryStarted();
        await directoryGate;
      },
      writeExclusive: async (path) => {
        writes.push(path);
      },
    });
    const opened = await call("POST", "/open", { ref: REF });
    if (!opened.envelope.ok) throw new Error("open failed");
    const sessionId = (opened.envelope.data as { sessionId: string }).sessionId;
    const pending = call("POST", "/screenshot", { sessionId });
    await started;
    events?.onNavigationStart({ url: "https://replacement.example.com", isSameDocument: false });
    releaseDirectory();
    expect(await pending).toMatchObject({ status: 404, envelope: { ok: false } });
    expect(writes).toEqual([]);
  });
});

describe("listPageNodes", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "vellum-control-pages-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("lists canonical page refs with nullable live handles", async () => {
    const dir = join(root, "canvases");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "work.canvas"),
      JSON.stringify({
        nodes: [
          {
            id: "p1",
            type: "link",
            url: "https://mail.example.com",
            x: 0,
            y: 0,
            width: 400,
            height: 300,
            ether: { entity: { kind: "page" }, browser: { profile: "personal" } },
          },
          { id: "l1", type: "link", url: "https://plain.example.com", x: 0, y: 0, width: 1, height: 1 },
        ],
        edges: [],
      }),
    );
    await writeFile(join(dir, "broken.canvas"), "{not json");
    expect(await listPageNodes(dir)).toEqual([
      {
        ref: "vellum://canvas/work?node=p1",
        sessionId: null,
        canvas: "work",
        nodeId: "p1",
        url: "https://mail.example.com",
        hostId: "local",
        profile: "personal",
      },
    ]);
  });

  it("bounds directory admission and aggregate canvas bytes at exact N/N+1", async () => {
    const dir = join(root, "canvases");
    await mkdir(dir, { recursive: true });
    const source = JSON.stringify({
      nodes: [{
        id: "page",
        type: "link",
        url: "https://example.com",
        x: 0,
        y: 0,
        width: 1,
        height: 1,
        ether: { entity: { kind: "page" } },
      }],
      edges: [],
    });
    await writeFile(join(dir, "a.canvas"), source);
    await writeFile(join(dir, "b.canvas"), source);
    const sourceBytes = utf8ByteLength(source);

    expect(await listPageNodes(dir, undefined, { maxScanBytes: sourceBytes - 1 }))
      .toEqual([]);
    expect(await listPageNodes(dir, undefined, { maxScanBytes: sourceBytes }))
      .toHaveLength(1);
    expect(await listPageNodes(dir, undefined, { maxDirectoryEntries: 1 }))
      .toHaveLength(1);
  });

  it("caps page rows, source files, fields, and the encoded response budget", async () => {
    const dir = join(root, "canvases");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "oversized.canvas"), Buffer.alloc(BROWSER_MAX_CANVAS_SOURCE_BYTES + 1));
    await mkdir(join(dir, "directory.canvas"));
    const linkedSource = join(root, "linked-source.canvas");
    await writeFile(linkedSource, JSON.stringify({ nodes: [], edges: [] }));
    await symlink(linkedSource, join(dir, "linked.canvas"));
    await writeFile(
      join(dir, "bounded.canvas"),
      JSON.stringify({
        nodes: [
          {
            id: "x".repeat(BROWSER_MAX_METADATA_BYTES + 1),
            type: "link", url: "https://example.com", x: 0, y: 0, width: 1, height: 1,
            ether: { entity: { kind: "page" } },
          },
          {
            id: "url-too-long", type: "link",
            url: `https://example.com/${"x".repeat(BROWSER_MAX_URL_BYTES)}`,
            x: 0, y: 0, width: 1, height: 1, ether: { entity: { kind: "page" } },
          },
          {
            id: "good", type: "link", url: "https://good.example.com",
            x: 0, y: 0, width: 1, height: 1,
            ether: { entity: { kind: "page" }, browser: { profile: "personal" } },
          },
        ],
        edges: [],
      }),
    );
    const boundedRows = await listPageNodes(dir);
    expect(boundedRows).toEqual([{
      ref: "vellum://canvas/bounded?node=good",
      sessionId: null,
      canvas: "bounded",
      nodeId: "good",
      url: "https://good.example.com",
      hostId: "local",
      profile: "personal",
    }]);

    await rm(join(dir, "bounded.canvas"));
    for (let fileIndex = 0; fileIndex < 8; fileIndex += 1) {
      await writeFile(
        join(dir, `pages-${fileIndex}.canvas`),
        JSON.stringify({
          nodes: Array.from({ length: 400 }, (_, rowIndex) => ({
            id: `p-${fileIndex}-${rowIndex}`,
            type: "link",
            url: `https://example.com/${"x".repeat(1_000)}-${fileIndex}-${rowIndex}`,
            x: 0, y: rowIndex, width: 1, height: 1,
            ether: { entity: { kind: "page" } },
          })),
          edges: [],
        }),
      );
    }
    const rows = await listPageNodes(dir);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThanOrEqual(BROWSER_MAX_LIST_ROWS);
    expect(rows.length).toBeLessThan(3_200);
    expect(JSON.parse(encodeControlEnvelope(controlOk(rows)))).toMatchObject({ ok: true });
  });

  it("returns empty for a missing canvases directory", async () => {
    expect(await listPageNodes(join(root, "nowhere"))).toEqual([]);
  });
});
