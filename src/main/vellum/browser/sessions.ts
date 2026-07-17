import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import {
  initialBrowserSession,
  isAllowedBrowserUrl,
  isValidProfileId,
  isWarmBrowserSession,
  reduceBrowserSession,
  warmPoolEvictions,
  type BrowserSessionMachine,
} from "@shared/browser";
import type { BrowserSessionInfo, BrowserSurfaceBounds } from "@shared/ipc";
import { parseNodeRef } from "@shared/node-ref";
import type { ResolvedPageTarget } from "./page-target";
import {
  makeBrowserProfileService,
  type BrowserProfileServiceApi,
} from "./profiles";

/**
 * Thin Electron seam. The real adapter creates a partitioned
 * WebContentsView parented under the BrowserWindow contentView. Tests inject
 * a spy. destroy() releases only the runtime view; profile storage persists.
 */
export interface BrowserViewHandle {
  loadUrl(url: string, expectedSessionId: string): void;
  attach(bounds: BrowserSurfaceBounds): void;
  setBounds(bounds: BrowserSurfaceBounds): void;
  detach(): void;
  destroy(): void;
  executeJavaScript?(code: string): Promise<unknown>;
  capturePagePng?(): Promise<Uint8Array>;
}

export interface BrowserViewEvents {
  readonly onNavigationStart: (event: {
    readonly url: string;
    readonly isSameDocument: boolean;
    readonly expectedSessionId?: string;
  }) => string | undefined;
  readonly onNavigationAmbiguous: (sessionId: string) => void;
  readonly onLoadOk: (sessionId: string, title?: string) => void;
  readonly onLoadFail: (sessionId: string, message: string) => void;
  readonly onNavigationUrl: (sessionId: string, url: string) => void;
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
  sessionId: string;
  readonly ref: string;
  readonly nodeId: string;
  readonly profile: string;
  readonly targetUrl: string;
  url: string;
  machine: BrowserSessionMachine;
  attached: boolean;
  navigationInFlight: string | undefined;
  lastActiveAt: number;
  view: BrowserViewHandle;
}

interface PendingOpen {
  readonly target: ResolvedPageTarget;
  readonly promise: Promise<BrowserResult<BrowserSessionInfo>>;
}

const err = (code: BrowserErrorCode, message: string): BrowserResultErr => ({
  ok: false,
  code,
  message,
});

const EVAL_TIMEOUT_MS = 30_000;

const withTimeout = <T>(promise: Promise<T>, ms: number, message: string): Promise<T> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });

const sameTarget = (left: ResolvedPageTarget, right: ResolvedPageTarget): boolean =>
  left.ref === right.ref &&
  left.nodeId === right.nodeId &&
  left.url === right.url &&
  left.profile === right.profile;

const validateTarget = (target: ResolvedPageTarget): BrowserResultErr | undefined => {
  const parsed = parseNodeRef(target.ref);
  if (!parsed.ok || parsed.value.nodeId !== target.nodeId) {
    return err("invalid", "resolved page target does not match its canonical ref");
  }
  if (!isAllowedBrowserUrl(target.url)) {
    return err("forbidden", `url not allowed (http/https only): ${target.url}`);
  }
  if (!isValidProfileId(target.profile)) {
    return err("invalid", "resolved page target has an invalid browser profile");
  }
  return undefined;
};

/**
 * Warm browser pool. Runtime authority is a fresh opaque sessionId. A
 * canonical page ref is only the secondary key used for warm reuse; nodeId is
 * display metadata and is never accepted by an existing-session operation.
 */
export class BrowserSessionService {
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly sessionIdByRef = new Map<string, string>();
  private readonly pendingOpenByRef = new Map<string, PendingOpen>();
  private sink: ((session: BrowserSessionInfo) => void) | undefined;

  constructor(
    private readonly adapter: BrowserViewAdapter,
    private readonly profiles: BrowserProfileServiceApi = makeBrowserProfileService(),
    private readonly now: () => number = Date.now,
    private readonly generateSessionId: () => string = randomUUID,
  ) {}

  setSink(sink: (session: BrowserSessionInfo) => void): void {
    this.sink = sink;
  }

  private info(entry: SessionEntry): BrowserSessionInfo {
    return {
      sessionId: entry.sessionId,
      ref: entry.ref,
      nodeId: entry.nodeId,
      url: entry.url,
      profile: entry.profile,
      state: entry.machine.state,
      attached: entry.attached,
      ...(entry.machine.title !== undefined ? { title: entry.machine.title } : {}),
      ...(entry.machine.lastError !== undefined ? { lastError: entry.machine.lastError } : {}),
    };
  }

  private isCurrent(entry: SessionEntry): boolean {
    return (
      this.sessions.get(entry.sessionId) === entry &&
      this.sessionIdByRef.get(entry.ref) === entry.sessionId
    );
  }

  private emit(entry: SessionEntry): void {
    if (this.isCurrent(entry)) this.sink?.(this.info(entry));
  }

  private reduceCurrent(
    entry: SessionEntry,
    event: Parameters<typeof reduceBrowserSession>[1],
  ): void {
    if (!this.isCurrent(entry)) return;
    const next = reduceBrowserSession(entry.machine, event);
    if (next === entry.machine) return;
    entry.machine = next;
    this.emit(entry);
  }

  private finishGeneration(
    entry: SessionEntry,
    sessionId: string,
    event: Parameters<typeof reduceBrowserSession>[1],
  ): void {
    if (
      entry.sessionId !== sessionId ||
      entry.navigationInFlight !== sessionId ||
      !this.isCurrent(entry)
    ) {
      return;
    }
    entry.navigationInFlight = undefined;
    this.reduceCurrent(entry, event);
  }

  private updateGenerationUrl(entry: SessionEntry, sessionId: string, url: string): void {
    if (entry.sessionId !== sessionId || !this.isCurrent(entry)) return;
    entry.url = url;
    this.emit(entry);
  }

  private register(entry: SessionEntry): void {
    this.sessions.set(entry.sessionId, entry);
    this.sessionIdByRef.set(entry.ref, entry.sessionId);
  }

  private unregister(entry: SessionEntry): void {
    if (this.sessions.get(entry.sessionId) === entry) this.sessions.delete(entry.sessionId);
    if (this.sessionIdByRef.get(entry.ref) === entry.sessionId) {
      this.sessionIdByRef.delete(entry.ref);
    }
  }

  private mintSessionId(): BrowserResult<string> {
    for (let attempt = 0; attempt < 32; attempt += 1) {
      let candidate: string;
      try {
        candidate = this.generateSessionId();
      } catch (error) {
        return err("failed", error instanceof Error ? error.message : String(error));
      }
      if (candidate.length > 0 && candidate.length <= 256 && !this.sessions.has(candidate)) {
        return { ok: true, data: candidate };
      }
    }
    return err("failed", "could not mint a unique browser session id");
  }

  private rotateGeneration(
    entry: SessionEntry,
    url: string,
  ): BrowserResult<string> {
    if (!this.isCurrent(entry)) return err("not_found", `no session for ${entry.sessionId}`);
    const minted = this.mintSessionId();
    if (!minted.ok) return minted;
    this.sessions.delete(entry.sessionId);
    entry.sessionId = minted.data;
    entry.url = url;
    this.sessions.set(entry.sessionId, entry);
    this.sessionIdByRef.set(entry.ref, entry.sessionId);
    return minted;
  }

  private navigationStarted(
    entry: SessionEntry,
    event: {
      readonly url: string;
      readonly isSameDocument: boolean;
      readonly expectedSessionId?: string;
    },
  ): string | undefined {
    if (!this.isCurrent(entry)) return undefined;
    if (event.isSameDocument) {
      this.updateGenerationUrl(entry, entry.sessionId, event.url);
      return entry.sessionId;
    }
    if (event.expectedSessionId !== undefined) {
      if (event.expectedSessionId !== entry.sessionId) return undefined;
      entry.url = event.url;
      entry.navigationInFlight = entry.sessionId;
      this.reduceCurrent(entry, { type: "load_start" });
      return entry.sessionId;
    }
    const rotated = this.rotateGeneration(entry, event.url);
    if (!rotated.ok) {
      this.destroySession(entry.sessionId);
      return undefined;
    }
    entry.navigationInFlight = rotated.data;
    this.reduceCurrent(entry, { type: "load_start" });
    return rotated.data;
  }

  private navigationAmbiguous(entry: SessionEntry, sessionId: string): void {
    if (entry.sessionId !== sessionId || !this.isCurrent(entry)) return;
    this.destroySession(sessionId);
  }

  async listProfiles(): Promise<
    BrowserResult<ReadonlyArray<{ id: string; label?: string; default?: boolean }>>
  > {
    try {
      const config = await Effect.runPromise(this.profiles.readConfig);
      return {
        ok: true,
        data: config.profiles.map((profile) => ({
          id: profile.id,
          ...(profile.label !== undefined ? { label: profile.label } : {}),
          ...(profile.id === config.defaultProfile ? { default: true } : {}),
        })),
      };
    } catch (error) {
      return err("failed", error instanceof Error ? error.message : String(error));
    }
  }

  async surfaceConfig(): Promise<
    BrowserResult<{ maxVisibleSurfaces: number; maxWarmSessions: number }>
  > {
    try {
      const config = await Effect.runPromise(this.profiles.readConfig);
      return {
        ok: true,
        data: {
          maxVisibleSurfaces: config.maxVisibleSurfaces,
          maxWarmSessions: config.maxWarmSessions,
        },
      };
    } catch (error) {
      return err("failed", error instanceof Error ? error.message : String(error));
    }
  }

  /** Same-ref callers share exactly one creation attempt and one sessionId. */
  async open(target: ResolvedPageTarget): Promise<BrowserResult<BrowserSessionInfo>> {
    const invalid = validateTarget(target);
    if (invalid !== undefined) return invalid;

    const pending = this.pendingOpenByRef.get(target.ref);
    if (pending !== undefined) {
      return sameTarget(pending.target, target)
        ? pending.promise
        : err("invalid", "canonical page ref resolved to conflicting page metadata");
    }

    const promise = this.openResolved(target);
    const record: PendingOpen = { target, promise };
    this.pendingOpenByRef.set(target.ref, record);
    try {
      return await promise;
    } finally {
      if (this.pendingOpenByRef.get(target.ref) === record) {
        this.pendingOpenByRef.delete(target.ref);
      }
    }
  }

  private async openResolved(
    target: ResolvedPageTarget,
  ): Promise<BrowserResult<BrowserSessionInfo>> {
    const existingId = this.sessionIdByRef.get(target.ref);
    const existing = existingId === undefined ? undefined : this.sessions.get(existingId);
    if (existingId !== undefined && existing === undefined) this.sessionIdByRef.delete(target.ref);
    if (existing !== undefined && isWarmBrowserSession(existing.machine.state)) {
      const currentTarget: ResolvedPageTarget = {
        ref: existing.ref,
        nodeId: existing.nodeId,
        url: existing.targetUrl,
        profile: existing.profile,
      };
      if (!sameTarget(currentTarget, target)) {
        return err("invalid", "canonical page ref changed while its session is warm");
      }
      existing.lastActiveAt = this.now();
      return { ok: true, data: this.info(existing) };
    }

    let partition: string;
    let maxWarmSessions: number;
    try {
      partition = await Effect.runPromise(this.profiles.partitionName(target.profile));
      const config = await Effect.runPromise(this.profiles.readConfig);
      maxWarmSessions = config.maxWarmSessions;
      await Effect.runPromise(this.profiles.touchProfile(target.profile));
    } catch (error) {
      return err("invalid", error instanceof Error ? error.message : String(error));
    }

    const minted = this.mintSessionId();
    if (!minted.ok) return minted;
    for (const sessionId of warmPoolEvictions(
      [...this.sessions.values()].map((entry) => ({
        key: entry.sessionId,
        attached: entry.attached,
        lastActiveAt: entry.lastActiveAt,
      })),
      minted.data,
      maxWarmSessions,
    )) {
      this.destroySession(sessionId);
    }

    const entry: SessionEntry = {
      sessionId: minted.data,
      ref: target.ref,
      nodeId: target.nodeId,
      profile: target.profile,
      targetUrl: target.url,
      url: target.url,
      machine: initialBrowserSession(),
      attached: false,
      navigationInFlight: minted.data,
      lastActiveAt: this.now(),
      view: undefined as unknown as BrowserViewHandle,
    };

    try {
      entry.view = this.adapter(partition, {
        onNavigationStart: (event) => this.navigationStarted(entry, event),
        onNavigationAmbiguous: (sessionId) => this.navigationAmbiguous(entry, sessionId),
        onLoadOk: (sessionId, title) =>
          this.finishGeneration(entry, sessionId, {
            type: "load_ok",
            ...(title !== undefined ? { title } : {}),
          }),
        onLoadFail: (sessionId, message) =>
          this.finishGeneration(entry, sessionId, { type: "load_fail", message }),
        onNavigationUrl: (sessionId, url) => this.updateGenerationUrl(entry, sessionId, url),
      });
      this.register(entry);
      this.reduceCurrent(entry, { type: "open" });
      entry.view.loadUrl(entry.url, entry.sessionId);
    } catch (error) {
      this.unregister(entry);
      try {
        entry.view?.destroy();
      } catch {
        // Runtime construction already failed; cleanup remains best effort.
      }
      return err("failed", error instanceof Error ? error.message : String(error));
    }
    return { ok: true, data: this.info(entry) };
  }

  goto(sessionId: string, url: string): BrowserResult<BrowserSessionInfo> {
    const entry = this.sessions.get(sessionId);
    if (entry === undefined) return err("not_found", `no session for ${sessionId}`);
    if (!isAllowedBrowserUrl(url)) {
      return err("forbidden", `url not allowed (http/https only): ${url}`);
    }
    if (entry.navigationInFlight !== undefined) {
      return err("invalid", "a top-level navigation is already in flight");
    }
    entry.lastActiveAt = this.now();
    const currentUrl = new URL(entry.url);
    const nextUrl = new URL(url);
    const sameDocument =
      currentUrl.origin === nextUrl.origin &&
      currentUrl.pathname === nextUrl.pathname &&
      currentUrl.search === nextUrl.search &&
      currentUrl.hash !== nextUrl.hash;
    if (sameDocument) {
      try {
        entry.url = url;
        entry.view.loadUrl(url, entry.sessionId);
        return { ok: true, data: this.info(entry) };
      } catch (error) {
        return err("failed", error instanceof Error ? error.message : String(error));
      }
    }

    const rotated = this.rotateGeneration(entry, url);
    if (!rotated.ok) return rotated;
    entry.navigationInFlight = rotated.data;
    try {
      this.reduceCurrent(entry, { type: "reload" });
      entry.view.loadUrl(url, entry.sessionId);
      if (!this.isCurrent(entry)) return err("not_found", `no session for ${sessionId}`);
      return { ok: true, data: this.info(entry) };
    } catch (error) {
      this.destroySession(entry.sessionId);
      return err("failed", error instanceof Error ? error.message : String(error));
    }
  }

  setBounds(
    sessionId: string,
    bounds: BrowserSurfaceBounds,
  ): BrowserResult<BrowserSessionInfo> {
    const entry = this.sessions.get(sessionId);
    if (entry === undefined) return err("not_found", `no session for ${sessionId}`);
    entry.lastActiveAt = this.now();
    try {
      if (!entry.attached) {
        entry.attached = true;
        entry.view.attach(bounds);
        this.reduceCurrent(entry, { type: "reattach" });
        this.emit(entry);
      } else {
        entry.view.setBounds(bounds);
      }
      return { ok: true, data: this.info(entry) };
    } catch (error) {
      return err("failed", error instanceof Error ? error.message : String(error));
    }
  }

  /** Detach only. The warm view and its profile storage remain alive. */
  close(sessionId: string): BrowserResult<BrowserSessionInfo> {
    const entry = this.sessions.get(sessionId);
    if (entry === undefined) return err("not_found", `no session for ${sessionId}`);
    try {
      if (entry.attached) {
        entry.attached = false;
        entry.view.detach();
      }
      entry.lastActiveAt = this.now();
      this.reduceCurrent(entry, { type: "detach" });
      return { ok: true, data: this.info(entry) };
    } catch (error) {
      return err("failed", error instanceof Error ? error.message : String(error));
    }
  }

  async eval(sessionId: string, code: string): Promise<BrowserResult<{ result: unknown }>> {
    const entry = this.sessions.get(sessionId);
    if (entry === undefined) return err("not_found", `no session for ${sessionId}`);
    if (entry.navigationInFlight !== undefined) {
      return err("invalid", "cannot evaluate while top-level navigation is in flight");
    }
    if (entry.view.executeJavaScript === undefined) {
      return err("failed", "adapter does not support eval");
    }
    entry.lastActiveAt = this.now();
    try {
      const result = await withTimeout(
        entry.view.executeJavaScript(code),
        EVAL_TIMEOUT_MS,
        `eval timed out after ${EVAL_TIMEOUT_MS}ms — the page script may be hung`,
      );
      if (!this.isCurrent(entry)) return err("not_found", `no session for ${sessionId}`);
      return { ok: true, data: { result } };
    } catch (error) {
      if (!this.isCurrent(entry)) return err("not_found", `no session for ${sessionId}`);
      return err("failed", error instanceof Error ? error.message : String(error));
    }
  }

  async screenshot(sessionId: string): Promise<BrowserResult<{ png: Uint8Array }>> {
    const entry = this.sessions.get(sessionId);
    if (entry === undefined) return err("not_found", `no session for ${sessionId}`);
    if (entry.navigationInFlight !== undefined) {
      return err("invalid", "cannot capture while top-level navigation is in flight");
    }
    if (entry.view.capturePagePng === undefined) {
      return err("failed", "adapter does not support screenshot");
    }
    entry.lastActiveAt = this.now();
    try {
      const png = await entry.view.capturePagePng();
      if (!this.isCurrent(entry)) return err("not_found", `no session for ${sessionId}`);
      if (png.byteLength === 0) {
        return err(
          "failed",
          `capture produced no pixels — session ${sessionId} is detached; open its surface and retry`,
        );
      }
      return { ok: true, data: { png } };
    } catch (error) {
      if (!this.isCurrent(entry)) return err("not_found", `no session for ${sessionId}`);
      return err("failed", error instanceof Error ? error.message : String(error));
    }
  }

  state(sessionId: string): BrowserResult<BrowserSessionInfo> {
    const entry = this.sessions.get(sessionId);
    return entry === undefined
      ? err("not_found", `no session for ${sessionId}`)
      : { ok: true, data: this.info(entry) };
  }

  list(): BrowserResult<ReadonlyArray<BrowserSessionInfo>> {
    return { ok: true, data: [...this.sessions.values()].map((entry) => this.info(entry)) };
  }

  sessionIdForRef(ref: string): string | undefined {
    const sessionId = this.sessionIdByRef.get(ref);
    return sessionId !== undefined && this.sessions.has(sessionId) ? sessionId : undefined;
  }

  /** Warm-pool eviction only. Profile partition data persists. */
  private destroySession(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (entry === undefined) return;
    this.reduceCurrent(entry, { type: "destroy" });
    this.unregister(entry);
    try {
      if (entry.attached) entry.view.detach();
    } finally {
      entry.view.destroy();
    }
  }

  /** Quit detaches views only; profile partitions are never touched. */
  detachAllOnQuit(reason: string): void {
    for (const entry of this.sessions.values()) {
      try {
        if (entry.attached) {
          entry.attached = false;
          entry.view.detach();
        }
        this.reduceCurrent(entry, { type: "detach" });
      } catch (error) {
        console.error(`[browser] detach on quit failed (${reason}, ${entry.sessionId}):`, error);
      }
    }
  }
}
