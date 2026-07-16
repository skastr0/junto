import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
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
import { makeBrowserProfileService } from "../src/main/vellum/browser/profiles";
import {
  BrowserSessionService,
  type BrowserViewAdapter,
  type BrowserViewHandle,
} from "../src/main/vellum/browser/sessions";

// Control plane tested transport-free: dispatchControlRequest is exactly what
// the unix socket serves (auth → route → handler), with the session service on
// a spy adapter (herdr mock-runner style). No live Electron.

const makeSpyAdapter = () => {
  const evalCalls: string[] = [];
  const adapter: BrowserViewAdapter = (_partition, _events) => {
    const handle: BrowserViewHandle = {
      loadUrl: () => {},
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
    const ok = decodeControlEnvelope(JSON.parse(JSON.stringify(controlOk({ n: 1 }))));
    expect(Either.isRight(ok)).toBe(true);

    const err = decodeControlEnvelope(
      JSON.parse(JSON.stringify(controlErr("runtime_down", "app not running"))),
    );
    expect(Either.isRight(err)).toBe(true);
    if (Either.isRight(err) && !err.right.ok) {
      expect(err.right.error._tag).toBe("runtime_down");
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

  it("creates the token file chmod 600 when missing, and reuses it after", async () => {
    const path = join(root, "control.token");
    const token = loadOrCreateToken(path);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const mode = (await stat(path)).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(loadOrCreateToken(path)).toBe(token);
  });

  it("regenerates an empty token file", async () => {
    const path = join(root, "control.token");
    await writeFile(path, "");
    expect(loadOrCreateToken(path)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("tokenMatches accepts only the exact token", () => {
    expect(tokenMatches("secret", "secret")).toBe(true);
    expect(tokenMatches("secre", "secret")).toBe(false);
    expect(tokenMatches("secretX", "secret")).toBe(false);
    expect(tokenMatches(undefined, "secret")).toBe(false);
    expect(tokenMatches("", "secret")).toBe(false);
  });
});

describe("control route handlers", () => {
  let root: string;
  const TOKEN = "test-token";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "vellum-control-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const makeStack = () => {
    const { adapter, evalCalls } = makeSpyAdapter();
    const sessions = new BrowserSessionService(adapter, makeBrowserProfileService(join(root, "browser")));
    const handlers = makeControlHandlers({
      sessions,
      version: "0.0.0-test",
      canvasesDir: join(root, "canvases"),
      shotsDir: join(root, "shots"),
    });
    // `null` = send no token at all (undefined would fall back to the default).
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
    return { call, sessions, evalCalls };
  };

  it("denies every route without a token / with a wrong token", async () => {
    const { call } = makeStack();
    for (const token of [null, "wrong"]) {
      const res = await call("GET", "/doctor", undefined, token);
      expect(res.status).toBe(401);
      expect(res.envelope.ok).toBe(false);
      if (!res.envelope.ok) expect(res.envelope.error._tag).toBe("unauthorized");
    }
  });

  it("returns bad_request for unknown routes", async () => {
    const { call } = makeStack();
    const res = await call("GET", "/nope");
    expect(res.status).toBe(404);
    if (!res.envelope.ok) expect(res.envelope.error._tag).toBe("bad_request");
  });

  it("doctor reports ok with pid/version/sessions and matches DoctorData", async () => {
    const { call } = makeStack();
    const res = await call("GET", "/doctor");
    expect(res.status).toBe(200);
    expect(res.envelope.ok).toBe(true);
    if (res.envelope.ok) {
      const data = Schema.decodeUnknownEither(DoctorData)(res.envelope.data);
      expect(Either.isRight(data)).toBe(true);
      if (Either.isRight(data)) expect(data.right.version).toBe("0.0.0-test");
    }
  });

  it("open → goto → eval → screenshot → close works against a warm session", async () => {
    const { call, evalCalls } = makeStack();

    const open = await call("POST", "/open", { nodeId: "n1", url: "https://example.com" });
    expect(open.status).toBe(200);
    if (open.envelope.ok) {
      expect((open.envelope.data as { profile: string }).profile.length).toBeGreaterThan(0);
    }

    const goto = await call("POST", "/goto", { nodeId: "n1", url: "https://example.com/2" });
    expect(goto.status).toBe(200);
    if (goto.envelope.ok) expect((goto.envelope.data as { url: string }).url).toBe("https://example.com/2");

    const evald = await call("POST", "/eval", { nodeId: "n1", code: "document.title" });
    expect(evald.status).toBe(200);
    if (evald.envelope.ok) expect(evald.envelope.data).toEqual({ result: { title: "hello" } });
    expect(evalCalls).toContain("document.title");

    const shot = await call("POST", "/screenshot", { nodeId: "n1" });
    expect(shot.status).toBe(200);
    if (shot.envelope.ok) {
      const { path, bytes } = shot.envelope.data as { path: string; bytes: number };
      expect(bytes).toBe(4);
      expect((await readFile(path)).subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    }

    const close = await call("POST", "/close", { nodeId: "n1" });
    expect(close.status).toBe(200);
    if (close.envelope.ok) {
      // Detach-only: the session stays warm after close.
      expect((close.envelope.data as { state: string }).state).toBe("detached");
    }
  });

  it("eval normalizes an undefined result to null", async () => {
    const { call } = makeStack();
    await call("POST", "/open", { nodeId: "n1", url: "https://example.com" });
    const res = await call("POST", "/eval", { nodeId: "n1", code: "void 0" });
    if (res.envelope.ok) expect(res.envelope.data).toEqual({ result: null });
  });

  it("eval failure surfaces as a tagged failed error", async () => {
    const { call } = makeStack();
    await call("POST", "/open", { nodeId: "n1", url: "https://example.com" });
    const res = await call("POST", "/eval", { nodeId: "n1", code: "boom" });
    expect(res.status).toBe(500);
    if (!res.envelope.ok) {
      expect(res.envelope.error._tag).toBe("failed");
      expect(res.envelope.error.message).toContain("eval exploded");
    }
  });

  it("goto/eval/screenshot on an unknown session return not_found", async () => {
    const { call } = makeStack();
    for (const [route, body] of [
      ["/goto", { nodeId: "ghost", url: "https://x.dev" }],
      ["/eval", { nodeId: "ghost", code: "1" }],
      ["/screenshot", { nodeId: "ghost" }],
    ] as const) {
      const res = await call("POST", route, body);
      expect(res.status).toBe(404);
      if (!res.envelope.ok) expect(res.envelope.error._tag).toBe("not_found");
    }
  });

  it("open rejects non-http(s) urls as forbidden", async () => {
    const { call } = makeStack();
    const res = await call("POST", "/open", { nodeId: "n1", url: "file:///etc/passwd" });
    expect(res.status).toBe(403);
    if (!res.envelope.ok) expect(res.envelope.error._tag).toBe("forbidden");
  });

  it("rejects malformed bodies as bad_request", async () => {
    const { call } = makeStack();
    const res = await call("POST", "/open", { nodeId: 42 });
    expect(res.status).toBe(400);
    if (!res.envelope.ok) expect(res.envelope.error._tag).toBe("bad_request");
  });

  it("screenshot rejects a relative destination path", async () => {
    const { call } = makeStack();
    await call("POST", "/open", { nodeId: "n1", url: "https://example.com" });
    const res = await call("POST", "/screenshot", { nodeId: "n1", path: "shots/x.png" });
    expect(res.status).toBe(400);
    if (!res.envelope.ok) expect(res.envelope.error._tag).toBe("invalid");
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

  it("lists link nodes with entity.kind page, skipping plain links and corrupt canvases", async () => {
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
          { id: "t1", type: "text", text: "hi", x: 0, y: 0, width: 1, height: 1 },
        ],
        edges: [],
      }),
    );
    await writeFile(join(dir, "broken.canvas"), "{not json");

    const rows = await listPageNodes(dir);
    expect(rows).toEqual([
      { canvas: "work", nodeId: "p1", url: "https://mail.example.com", profile: "personal" },
    ]);
  });

  it("returns empty for a missing/empty canvases dir", async () => {
    expect(await listPageNodes(join(root, "nowhere"))).toEqual([]);
  });
});
