import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IpcMain } from "electron";
import { IPC_CHANNELS, type BrowserSessionInfo } from "../src/shared/ipc";
import { BROWSER_MAX_REF_BYTES } from "../src/shared/browser-limits";
import { registerBrowserIpc } from "../src/main/vellum/browser/ipc";
import {
  BrowserSessionService,
  type BrowserViewAdapter,
} from "../src/main/vellum/browser/sessions";

type InvokeHandler = (event: unknown, ...args: ReadonlyArray<unknown>) => unknown;
const PAGE_REF = "vellum://canvas/work?node=page-1";

const session = (): BrowserSessionInfo => ({
  sessionId: "session-1",
  ref: PAGE_REF,
  nodeId: "page-1",
  url: "https://example.com/",
  profile: "default",
  state: "ready",
  attached: true,
});

describe("browser IPC bounds ingress", () => {
  const handlers = new Map<string, InvokeHandler>();
  let browserSessions: BrowserSessionService;
  const resolvePageTarget = vi.fn(async (_ref: unknown) => ({
    ok: false as const,
    code: "not_found" as const,
    message: "test resolver",
  }));

  beforeEach(() => {
    vi.restoreAllMocks();
    handlers.clear();
    resolvePageTarget.mockClear();
    const viewAdapter: BrowserViewAdapter = () => {
      throw new Error("invalid IPC input constructed a browser view");
    };
    browserSessions = new BrowserSessionService(viewAdapter);
    const ipcMain = {
      handle: vi.fn((channel: string, handler: InvokeHandler) => {
        handlers.set(channel, handler);
      }),
    } as unknown as IpcMain;
    registerBrowserIpc(ipcMain, browserSessions, () => [], resolvePageTarget);
  });

  const invoke = (channel: string, ...args: ReadonlyArray<unknown>): unknown => {
    const handler = handlers.get(channel);
    if (handler === undefined) throw new Error(`${channel} handler not registered`);
    return handler({}, ...args);
  };

  it("rejects surplus profile arguments before reading profile state", async () => {
    const listProfiles = vi.spyOn(browserSessions, "listProfiles");

    const result = await invoke(IPC_CHANNELS.browserProfiles, "surplus");

    expect(result).toMatchObject({ ok: false, code: "invalid" });
    expect(listProfiles).not.toHaveBeenCalled();
  });

  it("rejects surplus surface-config arguments before reading profile state", async () => {
    const surfaceConfig = vi.spyOn(browserSessions, "surfaceConfig");

    const result = await invoke(IPC_CHANNELS.browserSurfaceConfig, "surplus");

    expect(result).toMatchObject({ ok: false, code: "invalid" });
    expect(surfaceConfig).not.toHaveBeenCalled();
  });

  it("rejects surplus list arguments before reading session state", async () => {
    const list = vi.spyOn(browserSessions, "list");

    const result = await invoke(IPC_CHANNELS.browserSessionList, "surplus");

    expect(result).toMatchObject({ ok: false, code: "invalid" });
    expect(list).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", []],
    ["surplus", [{ ref: PAGE_REF }, "surplus"]],
  ])("rejects %s browser-open arity before page resolution", async (_label, args) => {
    const result = await invoke(IPC_CHANNELS.browserOpen, ...args);

    expect(result).toMatchObject({ ok: false, code: "invalid" });
    expect(resolvePageTarget).not.toHaveBeenCalled();
  });

  it.each([
    ["null", null],
    ["non-object", PAGE_REF],
    ["extra field", { ref: PAGE_REF, extra: true }],
    ["empty ref", { ref: "" }],
    ["non-string ref", { ref: 42 }],
    ["oversized ASCII ref", { ref: "x".repeat(BROWSER_MAX_REF_BYTES + 1) }],
    [
      "oversized UTF-8 ref",
      { ref: "😀".repeat(Math.floor(BROWSER_MAX_REF_BYTES / 4) + 1) },
    ],
  ])("rejects %s browser-open input before page resolution", async (_label, input) => {
    const result = await invoke(IPC_CHANNELS.browserOpen, input);

    expect(result).toMatchObject({ ok: false, code: "invalid" });
    expect(resolvePageTarget).not.toHaveBeenCalled();
  });

  it("passes one bounded browser-open ref to the resolver", async () => {
    const result = await invoke(IPC_CHANNELS.browserOpen, { ref: PAGE_REF });

    expect(result).toMatchObject({ ok: false, code: "not_found" });
    expect(resolvePageTarget).toHaveBeenCalledOnce();
    expect(resolvePageTarget).toHaveBeenCalledWith(PAGE_REF);
  });

  it.each([
    [IPC_CHANNELS.browserClose, "close", []],
    [IPC_CHANNELS.browserClose, "close", ["session-1", "surplus"]],
    [IPC_CHANNELS.browserSessionState, "state", []],
    [IPC_CHANNELS.browserSessionState, "state", ["session-1", "surplus"]],
  ])("rejects %s %s invalid arity before session access", async (channel, method, args) => {
    const sessionMethod = method === "close"
      ? vi.spyOn(browserSessions, "close")
      : vi.spyOn(browserSessions, "state");

    const result = await invoke(channel, ...args);

    expect(result).toMatchObject({ ok: false, code: "invalid" });
    expect(sessionMethod).not.toHaveBeenCalled();
  });

  it.each([
    ["null bounds", null],
    ["array bounds", [0, 0, 100, 100]],
    ["missing field", { x: 0, y: 0, width: 100 }],
    ["non-finite coordinate", { x: Number.NaN, y: 0, width: 100, height: 100 }],
    ["fractional coordinate", { x: 0.5, y: 0, width: 100, height: 100 }],
    ["oversized coordinate", { x: Number.MAX_SAFE_INTEGER, y: 0, width: 100, height: 100 }],
    ["zero width", { x: 0, y: 0, width: 0, height: 100 }],
    ["negative height", { x: 0, y: 0, width: 100, height: -1 }],
    ["fractional width", { x: 0, y: 0, width: 100.5, height: 100 }],
    ["oversized dimensions", { x: 0, y: 0, width: 1_000_000, height: 100 }],
    ["oversized pixel area", { x: 0, y: 0, width: 10_000, height: 10_000 }],
  ])("rejects %s before the session service is called", async (_label, bounds) => {
    const setBounds = vi.spyOn(browserSessions, "setBounds");

    const result = await invoke(IPC_CHANNELS.browserSetBounds, "session-1", bounds);

    expect(result).toMatchObject({ ok: false, code: "invalid" });
    expect(setBounds).not.toHaveBeenCalled();
  });

  it.each(["", "   ", null, 42])(
    "rejects malformed session id %j before the session service is called",
    async (sessionId) => {
      const setBounds = vi.spyOn(browserSessions, "setBounds");

      const result = await invoke(IPC_CHANNELS.browserSetBounds, sessionId, {
        x: 0,
        y: 0,
        width: 100,
        height: 100,
      });

      expect(result).toMatchObject({ ok: false, code: "invalid" });
      expect(setBounds).not.toHaveBeenCalled();
    },
  );

  it("passes validated integer bounds to the session service unchanged", async () => {
    const expected = { ok: true as const, data: session() };
    const setBounds = vi.spyOn(browserSessions, "setBounds").mockReturnValue(expected);
    const bounds = { x: -20, y: 40, width: 1200, height: 800 };

    const result = await invoke(IPC_CHANNELS.browserSetBounds, "session-1", bounds);

    expect(result).toBe(expected);
    expect(setBounds).toHaveBeenCalledOnce();
    expect(setBounds).toHaveBeenCalledWith("session-1", bounds);
  });

  it("rejects surplus arguments before the session service is called", async () => {
    const setBounds = vi.spyOn(browserSessions, "setBounds");

    const result = await invoke(
      IPC_CHANNELS.browserSetBounds,
      "session-1",
      { x: 0, y: 0, width: 100, height: 100 },
      "surplus",
    );

    expect(result).toMatchObject({ ok: false, code: "invalid" });
    expect(setBounds).not.toHaveBeenCalled();
  });
});
