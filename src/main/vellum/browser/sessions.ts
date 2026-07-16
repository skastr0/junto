import { Effect } from "effect";
import {
  initialBrowserSession,
  isAllowedBrowserUrl,
  isWarmBrowserSession,
  reduceBrowserSession,
  warmPoolEvictions,
  type BrowserSessionMachine,
} from "@shared/browser";
import type { BrowserSessionInfo, BrowserSurfaceBounds } from "@shared/ipc";
import {
  makeBrowserProfileService,
  type BrowserProfileServiceApi,
} from "./profiles";

// Warm browser session pool: one WebContentsView per opened page node, keyed
// by nodeId. Follows the herdr plain-singleton pattern (not an Effect Layer):
// the pool owns long-lived Electron views whose lifecycle is driven by IPC
// calls and app quit hooks, and pushes change events to the renderer — the
// same imperative shape as HerdrStreamManager. Wrapping that in a ManagedRuntime
// layer would only add ceremony between ipcMain.handle and the view handles.
// Profile config/partition mapping stays behind the (Effect) profile service;
// this file runs those effects at the boundary.

/**
 * Thin Electron seam. The real adapter (view-adapter.ts) creates a
 * WebContentsView on the given persist: partition and parents it under the
 * BrowserWindow contentView — NEVER under an xyflow node. Tests inject a spy.
 * destroy() releases the runtime view only; the partition (cookies) is on
 * disk and always survives.
 */
export interface BrowserViewHandle {
  loadUrl(url: string): void;
  /** Parent the native view under the window contentView at the given rect. */
  attach(bounds: BrowserSurfaceBounds): void;
  setBounds(bounds: BrowserSurfaceBounds): void;
  /** Remove from the window; keep the view (and its session) warm. */
  detach(): void;
  /** Drop the runtime view. Profile partition data persists. */
  destroy(): void;
  /** Control-plane seam: run JS in the page, JSON-serializable result. Optional — spies may omit. */
  executeJavaScript?(code: string): Promise<unknown>;
  /** Control-plane seam: capture the page as PNG bytes. Optional — spies may omit. */
  capturePagePng?(): Promise<Uint8Array>;
}

export interface BrowserViewEvents {
  readonly onLoadStart: () => void;
  readonly onLoadOk: (title?: string) => void;
  readonly onLoadFail: (message: string) => void;
}

export type BrowserViewAdapter = (
  partition: string,
  events: BrowserViewEvents,
) => BrowserViewHandle;

export type BrowserErrorCode = "invalid" | "not_found" | "forbidden" | "failed";

export interface BrowserResultOk<T> {
  readonly ok: true;
  readonly data: T;
}
export interface BrowserResultErr {
  readonly ok: false;
  readonly code: BrowserErrorCode;
  readonly message: string;
}
export type BrowserResult<T> = BrowserResultOk<T> | BrowserResultErr;

interface SessionEntry {
  readonly nodeId: string;
  readonly profile: string;
  url: string;
  machine: BrowserSessionMachine;
  attached: boolean;
  lastActiveAt: number;
  view: BrowserViewHandle;
}

const err = (code: BrowserErrorCode, message: string): BrowserResultErr => ({
  ok: false,
  code,
  message,
});

export class BrowserSessionService {
  private readonly sessions = new Map<string, SessionEntry>();
  private sink: ((session: BrowserSessionInfo) => void) | undefined;

  constructor(
    private readonly adapter: BrowserViewAdapter,
    private readonly profiles: BrowserProfileServiceApi = makeBrowserProfileService(),
    private readonly now: () => number = Date.now,
  ) {}

  /** Renderer push channel (browserSessionChanged). */
  setSink(sink: (session: BrowserSessionInfo) => void): void {
    this.sink = sink;
  }

  private info(entry: SessionEntry): BrowserSessionInfo {
    return {
      nodeId: entry.nodeId,
      url: entry.url,
      profile: entry.profile,
      state: entry.machine.state,
      attached: entry.attached,
      ...(entry.machine.title !== undefined ? { title: entry.machine.title } : {}),
      ...(entry.machine.lastError !== undefined ? { lastError: entry.machine.lastError } : {}),
    };
  }

  private emit(entry: SessionEntry): void {
    this.sink?.(this.info(entry));
  }

  private reduce(entry: SessionEntry, event: Parameters<typeof reduceBrowserSession>[1]): void {
    const next = reduceBrowserSession(entry.machine, event);
    if (next === entry.machine) return;
    entry.machine = next;
    this.emit(entry);
  }

  async listProfiles(): Promise<BrowserResult<ReadonlyArray<{ id: string; label?: string; default?: boolean }>>> {
    try {
      const config = await Effect.runPromise(this.profiles.readConfig);
      return {
        ok: true,
        data: config.profiles.map((p) => ({
          id: p.id,
          ...(p.label !== undefined ? { label: p.label } : {}),
          ...(p.id === config.defaultProfile ? { default: true } : {}),
        })),
      };
    } catch (error) {
      return err("failed", error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Open (or re-open) a page node's session. Reuses a warm session for the
   * same nodeId; otherwise creates a partitioned view, evicting the
   * least-recently-active DETACHED sessions when the pool is full. Attached
   * sessions are never evicted.
   */
  async open(input: {
    readonly nodeId: string;
    readonly url: string;
    readonly profile: string;
  }): Promise<BrowserResult<BrowserSessionInfo>> {
    if (!input.nodeId) return err("invalid", "nodeId required");
    // Scheme allowlist enforced at the service boundary — file:, javascript:,
    // data: never reach a WebContentsView regardless of caller.
    if (!isAllowedBrowserUrl(input.url)) {
      return err("forbidden", `url not allowed (http/https only): ${input.url}`);
    }

    const existing = this.sessions.get(input.nodeId);
    if (existing && isWarmBrowserSession(existing.machine.state)) {
      // Warm reuse. Profile is bound at creation — a profile switch is an
      // explicit close + open, never a silent repartition.
      if (existing.profile !== input.profile) {
        return err(
          "invalid",
          `session for ${input.nodeId} is bound to profile ${existing.profile}; close it before switching`,
        );
      }
      existing.lastActiveAt = this.now();
      if (existing.url !== input.url) {
        existing.url = input.url;
        this.reduce(existing, { type: "reload" });
        existing.view.loadUrl(input.url);
      }
      return { ok: true, data: this.info(existing) };
    }

    let partition: string;
    let maxWarmSessions: number;
    try {
      partition = await Effect.runPromise(this.profiles.partitionName(input.profile));
      const config = await Effect.runPromise(this.profiles.readConfig);
      maxWarmSessions = config.maxWarmSessions;
      await Effect.runPromise(this.profiles.touchProfile(input.profile));
    } catch (error) {
      return err("invalid", error instanceof Error ? error.message : String(error));
    }

    for (const key of warmPoolEvictions(
      [...this.sessions.values()].map((e) => ({
        key: e.nodeId,
        attached: e.attached,
        lastActiveAt: e.lastActiveAt,
      })),
      input.nodeId,
      maxWarmSessions,
    )) {
      this.destroySession(key);
    }

    const entry: SessionEntry = {
      nodeId: input.nodeId,
      profile: input.profile,
      url: input.url,
      machine: initialBrowserSession(),
      attached: false,
      lastActiveAt: this.now(),
      view: undefined as unknown as BrowserViewHandle,
    };
    entry.view = this.adapter(partition, {
      onLoadStart: () => this.reduce(entry, { type: "load_start" }),
      onLoadOk: (title) => this.reduce(entry, { type: "load_ok", ...(title !== undefined ? { title } : {}) }),
      onLoadFail: (message) => this.reduce(entry, { type: "load_fail", message }),
    });
    this.sessions.set(input.nodeId, entry);
    this.reduce(entry, { type: "open" });
    entry.view.loadUrl(input.url);
    return { ok: true, data: this.info(entry) };
  }

  /** Attach the session's view to the window at the given surface rect. */
  setBounds(nodeId: string, bounds: BrowserSurfaceBounds): BrowserResult<BrowserSessionInfo> {
    const entry = this.sessions.get(nodeId);
    if (!entry) return err("not_found", `no session for ${nodeId}`);
    entry.lastActiveAt = this.now();
    if (!entry.attached) {
      entry.attached = true;
      entry.view.attach(bounds);
      this.reduce(entry, { type: "reattach" });
      this.emit(entry);
    } else {
      entry.view.setBounds(bounds);
    }
    return { ok: true, data: this.info(entry) };
  }

  /**
   * Close the surface: detach the view from the window, keep the session
   * warm. Product lock: never destroys the view or wipes the profile here —
   * cookies and runtime state survive until warm-pool eviction.
   */
  close(nodeId: string): BrowserResult<BrowserSessionInfo> {
    const entry = this.sessions.get(nodeId);
    if (!entry) return err("not_found", `no session for ${nodeId}`);
    if (entry.attached) {
      entry.attached = false;
      entry.view.detach();
    }
    entry.lastActiveAt = this.now();
    this.reduce(entry, { type: "detach" });
    return { ok: true, data: this.info(entry) };
  }

  /**
   * Control-plane eval: run JS inside the page's isolated web content. The
   * result is whatever executeJavaScript resolves to (JSON-serializable by the
   * time it crosses the socket). Works on warm detached sessions too — a
   * surface on screen is not required.
   */
  async eval(nodeId: string, code: string): Promise<BrowserResult<{ result: unknown }>> {
    const entry = this.sessions.get(nodeId);
    if (!entry) return err("not_found", `no session for ${nodeId}`);
    if (!entry.view.executeJavaScript) return err("failed", "adapter does not support eval");
    entry.lastActiveAt = this.now();
    try {
      return { ok: true, data: { result: await entry.view.executeJavaScript(code) } };
    } catch (error) {
      return err("failed", error instanceof Error ? error.message : String(error));
    }
  }

  /** Control-plane screenshot: PNG bytes of the page. Caller owns persistence. */
  async screenshot(nodeId: string): Promise<BrowserResult<{ png: Uint8Array }>> {
    const entry = this.sessions.get(nodeId);
    if (!entry) return err("not_found", `no session for ${nodeId}`);
    if (!entry.view.capturePagePng) return err("failed", "adapter does not support screenshot");
    entry.lastActiveAt = this.now();
    try {
      return { ok: true, data: { png: await entry.view.capturePagePng() } };
    } catch (error) {
      return err("failed", error instanceof Error ? error.message : String(error));
    }
  }

  state(nodeId: string): BrowserResult<BrowserSessionInfo | null> {
    const entry = this.sessions.get(nodeId);
    return { ok: true, data: entry ? this.info(entry) : null };
  }

  list(): BrowserResult<ReadonlyArray<BrowserSessionInfo>> {
    return { ok: true, data: [...this.sessions.values()].map((e) => this.info(e)) };
  }

  /** Warm-pool eviction / explicit kill only. Partition data persists. */
  private destroySession(nodeId: string): void {
    const entry = this.sessions.get(nodeId);
    if (!entry) return;
    if (entry.attached) entry.view.detach();
    entry.view.destroy();
    this.reduce(entry, { type: "destroy" });
    this.sessions.delete(nodeId);
  }

  /**
   * Browser product lock: quit / relaunch MUST detach views only. Never
   * destroys sessions here beyond dropping the surfaces, and NEVER touches
   * profile partitions — cookies survive quit unconditionally.
   */
  detachAllOnQuit(reason: string): void {
    for (const entry of this.sessions.values()) {
      try {
        if (entry.attached) {
          entry.attached = false;
          entry.view.detach();
        }
        this.reduce(entry, { type: "detach" });
      } catch (error) {
        console.error(`[browser] detach on quit failed (${reason}, ${entry.nodeId}):`, error);
      }
    }
  }
}
