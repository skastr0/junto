import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Either, Schema } from "effect";
import {
  DoctorData,
  controlErr,
  controlOk,
  controlSocketPath,
  controlTokenPath,
  decodeControlEnvelope,
} from "../src/shared/browser-control";
import {
  dispatchControlRequest,
  listPageNodes,
  loadOrCreateToken,
  makeControlHandlers,
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

const REF = "vellum://canvas/work?node=n1";
const DEFAULT_TARGET: ResolvedPageTarget = {
  ref: REF,
  nodeId: "n1",
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

const makeSpyAdapter = () => {
  const evalCalls: string[] = [];
  const adapter: BrowserViewAdapter = (_partition, events) => {
    const handle: BrowserViewHandle = {
      loadUrl: (url, expectedSessionId) => {
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
      destroy: () => {},
      executeJavaScript: async (code) => {
        evalCalls.push(code);
        if (code === "boom") throw new Error("eval exploded");
        if (code === "void 0") return undefined;
        return { title: "hello" };
      },
      capturePagePng: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    };
    return handle;
  };
  return { adapter, evalCalls };
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

  it("creates owner-only token material and reuses a nonempty token", async () => {
    const path = join(root, "control.token");
    const token = loadOrCreateToken(path);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(loadOrCreateToken(path)).toBe(token);
    await writeFile(path, "");
    expect(loadOrCreateToken(path)).toMatch(/^[0-9a-f]{64}$/);
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
  const TOKEN = "test-token";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "vellum-control-"));
    sessionCounter = 0;
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const makeStack = (
    adapter: BrowserViewAdapter = makeSpyAdapter().adapter,
    resolvePageTarget: PageTargetResolver = resolverFor(),
    screenshotFiles?: {
      readonly ensureDirectory: (path: string) => Promise<void>;
      readonly write: (path: string, data: Uint8Array) => Promise<void>;
    },
  ) => {
    const sessions = new BrowserSessionService(
      adapter,
      makeBrowserProfileService(join(root, "browser")),
      Date.now,
      () => `session-${++sessionCounter}`,
    );
    const handlers = makeControlHandlers({
      sessions,
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
    ) =>
      dispatchControlRequest(handlers, TOKEN, {
        method,
        path,
        token: token ?? undefined,
        body,
      });
    return { call, sessions };
  };

  it("authenticates every route and rejects unknown routes", async () => {
    const { call } = makeStack();
    for (const token of [null, "wrong"]) {
      const response = await call("GET", "/doctor", undefined, token);
      expect(response.status).toBe(401);
      if (!response.envelope.ok) expect(response.envelope.error._tag).toBe("unauthorized");
    }
    expect((await call("GET", "/nope")).status).toBe(404);
  });

  it("reports doctor data through the shared schema", async () => {
    const response = await makeStack().call("GET", "/doctor");
    expect(response.status).toBe(200);
    if (response.envelope.ok) {
      const decoded = Schema.decodeUnknownEither(DoctorData)(response.envelope.data);
      expect(Either.isRight(decoded)).toBe(true);
      if (Either.isRight(decoded)) expect(decoded.right.version).toBe("0.0.0-test");
    }
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

  it("returns not_found for stale, node-id, ref, and unknown handle substitutions", async () => {
    const { call } = makeStack();
    for (const [path, body] of [
      ["/goto", { sessionId: "n1", url: "https://x.dev" }],
      ["/eval", { sessionId: REF, code: "1" }],
      ["/screenshot", { sessionId: "ghost" }],
      ["/close", { sessionId: "ghost" }],
    ] as const) {
      const response = await call("POST", path, body);
      expect(response.status).toBe(404);
      if (!response.envelope.ok) expect(response.envelope.error._tag).toBe("not_found");
    }
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

  it("enforces the URL allowlist on the document-derived target", async () => {
    const badRef = "vellum://canvas/work?node=bad";
    const { call } = makeStack(
      makeSpyAdapter().adapter,
      resolverFor({
        [badRef]: {
          ref: badRef,
          nodeId: "bad",
          url: "file:///etc/passwd",
          profile: "personal",
        },
      }),
    );
    const response = await call("POST", "/open", { ref: badRef });
    expect(response.status).toBe(403);
    if (!response.envelope.ok) expect(response.envelope.error._tag).toBe("forbidden");
  });

  it("rejects relative screenshot paths", async () => {
    const { call } = makeStack();
    const opened = await call("POST", "/open", { ref: REF });
    if (!opened.envelope.ok) throw new Error("open failed");
    const sessionId = (opened.envelope.data as { sessionId: string }).sessionId;
    const response = await call("POST", "/screenshot", { sessionId, path: "shots/x.png" });
    expect(response.status).toBe(400);
    if (!response.envelope.ok) expect(response.envelope.error._tag).toBe("invalid");
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
        loadUrl: (url, expectedSessionId) => {
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
        loadUrl: (url, expectedSessionId) => {
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
      write: async (path) => {
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
        profile: "personal",
      },
    ]);
  });

  it("returns empty for a missing canvases directory", async () => {
    expect(await listPageNodes(join(root, "nowhere"))).toEqual([]);
  });
});
