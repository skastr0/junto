import { LIVE_OVERSEER_ENABLED } from "@shared/features";
import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTrustedRendererHandler,
  installTrustedRendererPermissionPolicy,
  installTrustedRendererProtocol,
  registerTrustedRendererScheme,
  TRUSTED_RENDERER_SCHEME,
  TRUSTED_RENDERER_URL,
} from "../src/main/junto/trusted-renderer-protocol";
import { setTrustedMainWebContents } from "../src/main/junto/trusted-main-webcontents";

describe("trusted renderer protocol", () => {
  let root = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "vellum-trusted-renderer-"));
    await mkdir(join(root, "assets"));
    await writeFile(join(root, "index.html"), '<script src="./assets/app.js"></script>');
    await writeFile(join(root, "assets/app.js"), "globalThis.loaded = true;");
    await writeFile(join(root, "assets/app.css"), "body { color: black; }");
    // Binary sfx fixture: contents only need a stable length/byte identity.
    await writeFile(join(root, "assets/clip.wav"), Buffer.from("wav-fixture"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("registers only the privileges needed by a standard secure app origin", () => {
    let schemes: unknown;
    registerTrustedRendererScheme({
      registerSchemesAsPrivileged: (value: unknown) => {
        schemes = value;
      },
    } as never);

    expect(schemes).toEqual([
      {
        scheme: TRUSTED_RENDERER_SCHEME,
        privileges: {
          standard: true,
          secure: true,
          supportFetchAPI: true,
          bypassCSP: false,
          allowServiceWorkers: false,
          corsEnabled: false,
          stream: false,
          codeCache: false,
          allowExtensions: false,
        },
      },
    ]);
  });

  it("serves GET and HEAD with fixed security headers and MIME types", async () => {
    const handler = await createTrustedRendererHandler(root);

    const html = await handler(new Request(TRUSTED_RENDERER_URL));
    expect(html.status).toBe(200);
    expect(html.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(html.headers.get("cache-control")).toBe("no-store");
    expect(html.headers.get("x-content-type-options")).toBe("nosniff");
    expect(html.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(html.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await html.text()).toContain("./assets/app.js");

    const scriptUrl = "junto-app://renderer/assets/app.js";
    const script = await handler(new Request(scriptUrl));
    expect(script.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    const expectedLength = script.headers.get("content-length");
    expect(await script.text()).toContain("globalThis.loaded");

    const head = await handler(new Request(scriptUrl, { method: "HEAD" }));
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(expectedLength);
    expect(await head.text()).toBe("");

    const wav = await handler(new Request("junto-app://renderer/assets/clip.wav"));
    expect(wav.status).toBe(200);
    expect(wav.headers.get("content-type")).toBe("audio/wav");
    expect(new Uint8Array(await wav.arrayBuffer())).toEqual(
      new Uint8Array(Buffer.from("wav-fixture")),
    );
  });

  it.each([
    ["method", new Request(TRUSTED_RENDERER_URL, { method: "POST" }), 405],
    ["host", new Request("junto-app://attacker/index.html"), 400],
    [
      "credentials",
      { method: "GET", url: "junto-app://user:pass@renderer/index.html" } as Request,
      400,
    ],
    ["port", new Request("junto-app://renderer:123/index.html"), 400],
    ["query", new Request("junto-app://renderer/index.html?file=../secret"), 400],
    ["encoded separator", new Request("junto-app://renderer/assets%2fapp.js"), 400],
    ["encoded backslash", new Request("junto-app://renderer/assets%5capp.js"), 400],
    ["recursive encoding", new Request("junto-app://renderer/%252e%252e/secret.js"), 400],
    ["double slash", new Request("junto-app://renderer/assets//app.js"), 400],
    ["unknown extension", new Request("junto-app://renderer/assets/app.exe"), 415],
    ["missing file", new Request("junto-app://renderer/assets/missing.js"), 404],
  ])("rejects %s without exposing a path", async (_case, request, status) => {
    const handler = await createTrustedRendererHandler(root);
    const response = await handler(request);
    expect(response.status).toBe(status);
    expect(await response.text()).toBe("request rejected\n");
  });

  it("rejects a symlink that resolves outside the renderer root", async () => {
    const outside = join(root, "..", `vellum-outside-${process.pid}.js`);
    await writeFile(outside, "secret");
    await symlink(outside, join(root, "assets/escape.js"));
    try {
      const handler = await createTrustedRendererHandler(root);
      const response = await handler(
        new Request("junto-app://renderer/assets/escape.js"),
      );
      expect(response.status).toBe(403);
      expect(await response.text()).not.toContain(outside);
    } finally {
      await rm(outside, { force: true });
    }
  });

  it("installs the handler on only the protocol instance explicitly supplied", async () => {
    let defaultHandler: ((request: Request) => Promise<Response>) | undefined;
    let defaultHandled = false;
    const defaultProtocol = {
      isProtocolHandled: () => defaultHandled,
      handle: (scheme: string, handler: (request: Request) => Promise<Response>) => {
        expect(scheme).toBe(TRUSTED_RENDERER_SCHEME);
        defaultHandler = handler;
        defaultHandled = true;
      },
    };
    const browserPartition = {
      handled: false,
      handler: undefined as ((request: Request) => Promise<Response>) | undefined,
    };

    await installTrustedRendererProtocol(defaultProtocol as never, root);
    expect(defaultHandled).toBe(true);
    expect(defaultHandler).toBeDefined();
    expect(browserPartition).toEqual({ handled: false, handler: undefined });
    await expect(
      installTrustedRendererProtocol(defaultProtocol as never, root),
    ).rejects.toThrow(/already has a handler/u);
  });
});

describe("trusted renderer permissions", () => {
  it("allows sanitized clipboard writes and audio capture only in the trusted main frame", () => {
    let check: ((...args: ReadonlyArray<any>) => boolean) | undefined;
    let request: ((...args: ReadonlyArray<any>) => void) | undefined;
    const target = {
      setPermissionCheckHandler: (handler: typeof check) => {
        check = handler;
      },
      setPermissionRequestHandler: (handler: typeof request) => {
        request = handler;
      },
    };
    const trustedContents = {
      isDestroyed: () => false,
      getURL: () => TRUSTED_RENDERER_URL,
    };
    const otherContents = { isDestroyed: () => false };
    const trustedWindow = {
      isDestroyed: () => false,
      webContents: trustedContents,
    };
    setTrustedMainWebContents(trustedContents as never, {
      initialUrl: TRUSTED_RENDERER_URL,
      allows: (url) => url === TRUSTED_RENDERER_URL,
    });

    installTrustedRendererPermissionPolicy(
      target as never,
      () => trustedWindow as never,
    );

    const details = { requestingUrl: TRUSTED_RENDERER_URL, isMainFrame: true };
    expect(
      check?.(
        trustedContents,
        "clipboard-sanitized-write",
        "junto-app://renderer",
        details,
      ),
    ).toBe(true);
    expect(check?.(trustedContents, "clipboard-read", "", details)).toBe(false);
    expect(
      check?.(otherContents, "clipboard-sanitized-write", "", details),
    ).toBe(false);
    expect(
      check?.(trustedContents, "clipboard-sanitized-write", "", {
        ...details,
        isMainFrame: false,
      }),
    ).toBe(false);
    expect(
      check?.(trustedContents, "clipboard-sanitized-write", "", {
        ...details,
        requestingUrl: "https://example.com/",
      }),
    ).toBe(false);

    let allowed: boolean | undefined;
    request?.(
      trustedContents,
      "clipboard-sanitized-write",
      (value: boolean) => {
        allowed = value;
      },
      details,
    );
    expect(allowed).toBe(true);
    expect(check?.(trustedContents, "media", "", { ...details, mediaType: "audio" })).toBe(LIVE_OVERSEER_ENABLED);
    for (const mediaType of ["video", "unknown", undefined]) {
      expect(check?.(trustedContents, "media", "", { ...details, mediaType })).toBe(false);
    }
    expect(check?.(otherContents, "media", "", { ...details, mediaType: "audio" })).toBe(false);
    expect(check?.(trustedContents, "media", "", { ...details, mediaType: "audio", isMainFrame: false })).toBe(false);
    for (const mediaTypes of [["audio"], ["video"], ["audio", "video"], [], undefined]) {
      request?.(trustedContents, "media", (value: boolean) => { allowed = value; }, { ...details, mediaTypes });
      expect(allowed).toBe(LIVE_OVERSEER_ENABLED && mediaTypes?.length === 1 && mediaTypes[0] === "audio");
    }
  });

  it("permits the exact development authority only when explicitly configured", () => {
    let check: ((...args: ReadonlyArray<any>) => boolean) | undefined;
    const target = {
      setPermissionCheckHandler: (handler: typeof check) => {
        check = handler;
      },
      setPermissionRequestHandler: () => undefined,
    };
    const trustedContents = {
      isDestroyed: () => false,
      getURL: () => "http://127.0.0.1:5173/app",
    };
    const trustedWindow = {
      isDestroyed: () => false,
      webContents: trustedContents,
    };
    setTrustedMainWebContents(trustedContents as never, {
      initialUrl: "http://127.0.0.1:5173/",
      allows: (url) => url?.startsWith("http://127.0.0.1:5173/") ?? false,
    });
    installTrustedRendererPermissionPolicy(
      target as never,
      () => trustedWindow as never,
      "http://127.0.0.1:5173/",
    );

    expect(
      check?.(
        trustedContents,
        "clipboard-sanitized-write",
        "http://127.0.0.1:5173",
        { requestingUrl: "http://127.0.0.1:5173/app", isMainFrame: true },
      ),
    ).toBe(true);
    expect(
      check?.(
        trustedContents,
        "clipboard-sanitized-write",
        "http://127.0.0.1:5174",
        { requestingUrl: "http://127.0.0.1:5174/app", isMainFrame: true },
      ),
    ).toBe(false);
  });
});
