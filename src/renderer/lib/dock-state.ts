import { observable, observe } from "@legendapp/state";
import type { CanvasNode, EtherBrowser } from "@shared/canvas";
import type { VellumCommandBrowserApi } from "@shared/ipc";
import {
  browser$,
  browserSessionIdForRef,
  cacheBrowserSessionIfUnchanged,
  clearBrowserSessionIfUnchanged,
  isCanonicalBrowserRef,
  isUsableBrowserSession,
} from "./browser-state";

import {
  closeSurface,
  focusDockChromeVisible,
  focusSurface,
  initialWorkbenchState,
  openSurface,
  pinSurface,
  setFocusSize,
  setLayout,
  setPinnedWidthFrac,
  surfaceById,
  unpinSurface,
  type LayoutMode,
  type WorkbenchState,
  type WorkbenchTransition,
  type WorkSurface,
  type WorkZone,
} from "./surface-registry";
import { getVellumCommandApi } from "./vellum-api";
import { closeTerminalSurface, terminal$, terminalNodeIds } from "./terminal-state";

// Workbench side effects: pure transitions live in surface-registry.ts; this
// module owns the observable + detach/stream cleanup. Every close DETACHES
// only — warm browser sessions survive unless Stop Page is explicit.

export interface DockBrowserPayload {
  readonly nodeId: string;
  readonly browser: EtherBrowser;
  readonly url: string;
  readonly title: string;
}

export interface DockChatPayload {
  readonly nodeId: string;
  readonly agentKey: string;
  readonly title: string;
}

export interface DockTaskCreatePayload {
  readonly nodeId: string;
  readonly title: string;
  readonly mode: "task";
}

export interface DockNotePayload {
  readonly nodeId: string;
  readonly title: string;
  /** Live textarea value; kept outside the React Flow node lifecycle. */
  readonly draft: string;
  /** Last value committed to the canvas by an explicit or durability save. */
  readonly savedText: string;
}

const TERMINAL_SURFACE_PREFIX = "terminal:";
const CHAT_SURFACE_PREFIX = "chat:";
const TASK_CREATE_SURFACE_PREFIX = "task-create:";
const NOTE_SURFACE_PREFIX = "note:";
export const terminalSurfaceId = (nodeId: string): string => `${TERMINAL_SURFACE_PREFIX}${nodeId}`;
export const parseTerminalSurfaceId = (id: string): string | null => id.startsWith(TERMINAL_SURFACE_PREFIX) && id.length > TERMINAL_SURFACE_PREFIX.length ? id.slice(TERMINAL_SURFACE_PREFIX.length) : null;
export const chatSurfaceId = (nodeId: string): string => `${CHAT_SURFACE_PREFIX}${nodeId}`;
export const parseChatSurfaceId = (id: string): string | null =>
  id.startsWith(CHAT_SURFACE_PREFIX) && id.length > CHAT_SURFACE_PREFIX.length
    ? id.slice(CHAT_SURFACE_PREFIX.length)
    : null;
export const taskCreateSurfaceId = (nodeId: string): string =>
  `${TASK_CREATE_SURFACE_PREFIX}${nodeId}`;
export const parseTaskCreateSurfaceId = (id: string): string | null =>
  id.startsWith(TASK_CREATE_SURFACE_PREFIX) && id.length > TASK_CREATE_SURFACE_PREFIX.length
    ? id.slice(TASK_CREATE_SURFACE_PREFIX.length)
    : null;
export const noteSurfaceId = (nodeId: string): string => `${NOTE_SURFACE_PREFIX}${nodeId}`;
export const parseNoteSurfaceId = (id: string): string | null =>
  id.startsWith(NOTE_SURFACE_PREFIX) && id.length > NOTE_SURFACE_PREFIX.length
    ? id.slice(NOTE_SURFACE_PREFIX.length)
    : null;


export const dock$ = observable({
  registry: initialWorkbenchState() as WorkbenchState,
  /** canonical vellum-command:// ref -> display payload for browser slots. */
  browserByRef: {} as Record<string, DockBrowserPayload>,
  /** chat:<nodeId> -> ACP surface identity. ACP runtime state remains keyed by agentKey. */
  chatById: {} as Record<string, DockChatPayload>,
  /** task-create:<nodeId> -> quick enqueue surface for a tasks sink. */
  taskCreateById: {} as Record<string, DockTaskCreatePayload>,
  /** note:<nodeId> -> focus-safe Note editor draft and durability baseline. */
  noteById: {} as Record<string, DockNotePayload>,
  /** Explicit Stop Page failures stay visible until retry/open succeeds. */
  stopErrorByRef: {} as Record<string, string>,
  configHydrated: false,
});

type BrowserApi = ReturnType<typeof getVellumCommandApi> & Partial<VellumCommandBrowserApi>;

const api = (): BrowserApi | undefined => getVellumCommandApi() as BrowserApi | undefined;

const detachCurrentSession = (ref: string): void => {
  const sessionId = browserSessionIdForRef(ref);
  if (!sessionId) return;
  void api()?.browserClose?.(sessionId).catch(() => undefined);
};

const clearStoppedSurface = (ref: string, observedSessionId: string | undefined): boolean => {
  if (!clearBrowserSessionIfUnchanged(ref, observedSessionId)) return false;
  dock$.registry.set(closeSurface(dock$.registry.peek(), ref).state);
  dock$.browserByRef[ref].delete();
  return true;
};

/**
 * Drop residual renderer page UI for a ref when the browser plane cannot (or
 * need not) stop a live session. Prefer `clearStoppedSurface` when an observed
 * handle race-guards the clear; use this only for "no plane / nothing live".
 */
const forceClearStoppedSurface = (ref: string): void => {
  const current = browserSessionIdForRef(ref);
  clearBrowserSessionIfUnchanged(ref, current);
  browser$.sessionByRef[ref].delete();
  dock$.registry.set(closeSurface(dock$.registry.peek(), ref).state);
  dock$.browserByRef[ref].delete();
};

/**
 * One-shot hydrate marker. maxVisibleSurfaces is not a UI admission cap
 * (tabs + keep-alive); warm session limits still live in main.
 */
export const hydrateDockConfig = async (): Promise<void> => {
  if (dock$.configHydrated.peek()) return;
  dock$.configHydrated.set(true);
  void api()?.browserSurfaceConfig?.().catch(() => undefined);
};

/**
 * Apply one registry transition and run side effects for fully-closed surfaces.
 * Browser closes detach over IPC (session stays warm).
 */
const applyTransition = (transition: WorkbenchTransition): void => {
  dock$.registry.set(transition.state);
  for (const closed of transition.evicted) {
    if (closed.kind === "browser") {
      dock$.browserByRef[closed.id].delete();
      detachCurrentSession(closed.id);
    } else if (closed.kind === "terminal") {
      const nodeId = parseTerminalSurfaceId(closed.id);
      if (nodeId) closeTerminalSurface(nodeId);
    } else if (closed.kind === "chat") {
      // Closing a surface does not disconnect the ACP session. It only removes
      // the operator's current view, matching browser detach semantics.
      dock$.chatById[closed.id].delete();
    } else if (closed.kind === "task-create") {
      dock$.taskCreateById[closed.id].delete();
    } else if (closed.kind === "note") {
      dock$.noteById[closed.id].delete();
    }
  }
};

/** Open an agent's ACP conversation in the shared focus/pinned workbench. */
export const openAgentChatSurface = (
  node: CanvasNode,
  zone: WorkZone = "focus",
): void => {
  const entity = node.ether?.entity;
  if (entity?.kind !== "agent" || !entity.name) return;
  const id = chatSurfaceId(node.id);
  const title =
    (node.type === "text" ? node.text : "").split("\n")[0]?.trim() ||
    entity.name;
  dock$.chatById[id].set({
    nodeId: node.id,
    agentKey: entity.name,
    title,
  });
  applyTransition(openSurface(dock$.registry.peek(), { id, kind: "chat" }, zone));
};

/**
 * Open (or re-focus) the quick task-enqueue surface for a tasks sink node.
 * Lands in the shared focus/pinned workbench so it can sit beside a terminal
 * (and be pinned itself). Create does not dismiss — the form clears for the next.
 */
export const openTaskCreateSurface = (
  node: CanvasNode,
  options?: {
    readonly zone?: WorkZone;
  },
): void => {
  if (node.ether?.entity?.kind !== "task") return;
  const id = taskCreateSurfaceId(node.id);
  const title =
    (node.type === "text" ? node.text : "").split("\n")[0]?.trim() || "Tasks";
  const zone = options?.zone ?? "focus";
  dock$.taskCreateById[id].set({
    nodeId: node.id,
    title,
    mode: "task",
  });
  applyTransition(
    openSurface(dock$.registry.peek(), { id, kind: "task-create" }, zone),
  );
};

/**
 * Open a freeform Note in the shared workbench. Draft ownership deliberately
 * lives here rather than inside TextNode: React Flow may rebuild or temporarily
 * omit a card while canvas projections update, but operator-owned focus and
 * unsaved text must survive that churn.
 */
export const openNoteSurface = (
  node: CanvasNode,
  zone: WorkZone = "focus",
): void => {
  if (node.type !== "text" || node.ether?.entity) return;
  const id = noteSurfaceId(node.id);
  const title = node.text.split("\n")[0]?.trim() || "Note";
  const existing = dock$.noteById[id].peek();
  dock$.noteById[id].set(
    existing
      ? { ...existing, title }
      : {
          nodeId: node.id,
          title,
          draft: node.text,
          savedText: node.text,
        },
  );
  applyTransition(openSurface(dock$.registry.peek(), { id, kind: "note" }, zone));
};

export const updateNoteSurfaceDraft = (id: string, draft: string): void => {
  const payload = dock$.noteById[id].peek();
  if (!payload || payload.draft === draft) return;
  dock$.noteById[id].set({ ...payload, draft });
};

export const markNoteSurfaceSaved = (id: string, savedText: string): void => {
  const payload = dock$.noteById[id].peek();
  if (!payload) return;
  dock$.noteById[id].set({ ...payload, savedText });
};

/**
 * Reconcile the workbench with main-process live sessions after renderer reload.
 * Attached sessions land in the focus zone (v1 — no zone persistence yet).
 */
let reconciledLiveSessions = false;

export const reconcileDockFromLiveSessions = async (): Promise<void> => {
  if (reconciledLiveSessions) return;
  reconciledLiveSessions = true;
  const a = api();
  if (!a?.browserSessionList) return;
  const observedSessionIds = new Map(
    Object.entries(browser$.sessionByRef.peek()).flatMap(([ref, session]) => {
      const sessionId = isUsableBrowserSession(session) ? session.sessionId : undefined;
      return sessionId ? [[ref, sessionId] as const] : [];
    }),
  );
  try {
    const result = await a.browserSessionList();
    if (!result.ok || !result.data) return;
    for (const session of result.data) {
      if (!session.attached || !isUsableBrowserSession(session)) continue;
      if (!cacheBrowserSessionIfUnchanged(session, observedSessionIds.get(session.ref))) continue;
      dock$.browserByRef[session.ref].set({
        nodeId: session.nodeId,
        browser: { profile: session.profile },
        url: session.url,
        title: session.title ?? session.url,
      });
      applyTransition(
        openSurface(dock$.registry.peek(), { id: session.ref, kind: "browser" }, "focus"),
      );
    }
  } catch {
    // Best-effort — unreconciled attached session degrades to manual recovery.
  }
};

/**
 * Open (or re-focus) a page browser surface in the **focus** zone by default.
 * Slot appears immediately; warm session opens/reuses over IPC.
 */
export const openDockBrowser = async (
  ref: string,
  payload: DockBrowserPayload,
  zone: WorkZone = "focus",
): Promise<void> => {
  if (!isCanonicalBrowserRef(ref)) return;
  dock$.stopErrorByRef[ref].delete();
  await hydrateDockConfig();
  dock$.browserByRef[ref].set(payload);
  applyTransition(openSurface(dock$.registry.peek(), { id: ref, kind: "browser" }, zone));
  const a = api();
  if (!a?.browserOpen) return;
  const observedSessionId = browserSessionIdForRef(ref);
  try {
    const result = await a.browserOpen({ ref });
    if (result.ok && result.data?.ref === ref) {
      cacheBrowserSessionIfUnchanged(result.data, observedSessionId);
    }
  } catch {
    // Session push events (or their absence) carry the failure state.
  }
};

/** Detach a browser surface (UI first). Session and cookies survive. */
export const closeDockBrowser = (ref: string): void => {
  applyTransition(closeSurface(dock$.registry.peek(), ref));
};

observe(() => {
  terminal$.openByNodeId.get();
  terminal$.openSeq.get();
  const openIds = new Set(terminalNodeIds());
  let registry = dock$.registry.peek();
  for (const surface of registry.surfaces) {
    if (surface.kind !== "terminal") continue;
    const nodeId = parseTerminalSurfaceId(surface.id);
    if (!nodeId || !openIds.has(nodeId)) registry = closeSurface(registry, surface.id).state;
  }
  for (const nodeId of openIds) {
    const id = terminalSurfaceId(nodeId);
    // preferredZone is one-shot: apply once, then clear so a later sibling
    // open / re-sync does not re-pin after the operator unpinned.
    const preferred = terminal$.preferredZoneByNodeId[nodeId].peek();
    const zone = preferred ?? "focus";
    const existing = surfaceById(registry, id);
    if (!existing) {
      registry = openSurface(registry, { id, kind: "terminal" }, zone).state;
    } else if (zone === "pinned" && existing.zone !== "pinned") {
      // Open-pinned from the toolbar: move an already-open focus surface over.
      registry = pinSurface(registry, id).state;
    }
    if (preferred !== undefined) {
      terminal$.preferredZoneByNodeId[nodeId].delete();
    }
  }
  // Promote exactly the requested surface, ONCE — a one-shot consumed like
  // preferredZone. Replaying it on every pass yanked the front back over a
  // manual tab click whenever any terminal opened or closed elsewhere, and
  // could fire mid-teardown of a batch close. Peeked (untracked), so the
  // consume does not re-trigger this observe; openTerminalSurface sets it
  // before openByNodeId so the run this set triggers sees the fresh value.
  const lastOpened = terminal$.lastOpenNodeId.peek();
  if (lastOpened !== null && openIds.has(lastOpened)) {
    registry = focusSurface(registry, terminalSurfaceId(lastOpened)).state;
    terminal$.lastOpenNodeId.set(null);
  }
  dock$.registry.set(registry);
});

export const pinWorkbenchSurface = (id: string): void => {
  applyTransition(pinSurface(dock$.registry.peek(), id));
};

export const unpinWorkbenchSurface = (id: string): void => {
  applyTransition(unpinSurface(dock$.registry.peek(), id));
};

export const focusWorkbenchSurface = (id: string): void => {
  applyTransition(focusSurface(dock$.registry.peek(), id));
};

/**
 * Promote surface to zone MRU front and route keyboard.
 */
export const activateWorkbenchSurface = (id: string): void => {
  applyTransition(focusSurface(dock$.registry.peek(), id));
};

export const setWorkbenchLayout = (zone: WorkZone, layout: LayoutMode): void => {
  applyTransition(setLayout(dock$.registry.peek(), zone, layout));
};

export const setWorkbenchPinnedWidthFrac = (frac: number): void => {
  applyTransition(setPinnedWidthFrac(dock$.registry.peek(), frac));
};

export const setWorkbenchFocusSize = (
  size: Parameters<typeof setFocusSize>[1],
): void => {
  applyTransition(setFocusSize(dock$.registry.peek(), size));
};

/**
 * Close one workbench surface (view only). Browser closes detach over IPC;
 * terminal closes drop the view while the PTY keeps running.
 */
/** Close every workbench surface so a crashed view remounts empty. */
export const closeAllWorkbenchSurfaces = (): void => {
  const ids = dock$.registry.peek().surfaces.map((surface) => surface.id);
  for (const id of ids) closeWorkbenchSurface(id);
};

export const closeWorkbenchSurface = (id: string): void => {
  const surface = dock$.registry.peek().surfaces.find((s) => s.id === id);
  if (!surface) return;
  if (surface.kind === "browser") {
    closeDockBrowser(id);
    return;
  }
  applyTransition(closeSurface(dock$.registry.peek(), id));
};

/**
 * Close a focus surface with MODAL semantics. Without the dock chrome the
 * focus zone presents as ONE modal — mirror cycling parks siblings invisibly
 * behind the front pane, and the shell's backdrop click already dismisses
 * them all — so a single Close must dismiss the whole stack, never pop the
 * hidden MRU one press per cycled actor. With tab chrome visible, tabs are
 * real affordances and close stays per-surface. Views only; processes,
 * warm browser sessions, and PTYs keep running.
 */
export const closeFocusModalSurface = (id: string): void => {
  const registry = dock$.registry.peek();
  const surface = surfaceById(registry, id);
  if (!surface || surface.zone !== "focus" || focusDockChromeVisible(registry)) {
    closeWorkbenchSurface(id);
    return;
  }
  for (const s of registry.surfaces) {
    if (s.zone === "focus") closeWorkbenchSurface(s.id);
  }
};

/**
 * Explicitly stop one page runtime by exact opaque handle. Surface remains
 * visible on failure; removed only after authoritative destruction.
 *
 * When the browser product surface is compile-time off (preload omits
 * browserStop), no page runtime can exist under this app process. Clear any
 * residual renderer furniture and succeed so page-node document delete is not
 * blocked by historical nodes from a build that had the flag on.
 */
export const stopDockBrowser = async (ref: string): Promise<boolean> => {
  dock$.stopErrorByRef[ref].delete();
  const a = api();
  if (!a?.browserStop) {
    forceClearStoppedSurface(ref);
    return true;
  }
  let sessionId = browserSessionIdForRef(ref);
  if (!sessionId) {
    if (!a.browserSessionList) {
      // Stop API present but list missing and no cached handle: nothing to
      // kill; clear residual UI and allow document delete.
      forceClearStoppedSurface(ref);
      return true;
    }
    try {
      const listed = await a.browserSessionList();
      if (!listed.ok || !listed.data) {
        dock$.stopErrorByRef[ref].set(listed.message ?? "Could not verify whether this page is still running.");
        return false;
      }
      const live = listed.data.find(
        (candidate) => isUsableBrowserSession(candidate) && candidate.ref === ref,
      );
      sessionId = live?.sessionId;
      if (live) cacheBrowserSessionIfUnchanged(live, undefined);
      if (!sessionId) {
        // Authoritative absence — clear residual UI even if a stale handle
        // was in the cache race window (observed undefined vs stale id).
        forceClearStoppedSurface(ref);
        return true;
      }
    } catch {
      dock$.stopErrorByRef[ref].set("Could not verify whether this page is still running.");
      return false;
    }
  }
  try {
    const result = await a.browserStop(sessionId);
    if (result.ok) {
      if (clearStoppedSurface(ref, sessionId)) return true;
      dock$.stopErrorByRef[ref].set("Page runtime changed while stopping; retry Stop Page.");
      return false;
    }
    if (result.code === "not_found" && a.browserSessionList) {
      const listed = await a.browserSessionList();
      if (listed.ok && listed.data) {
        const live = listed.data.find(
          (candidate) => isUsableBrowserSession(candidate) && candidate.ref === ref,
        );
        if (!live) {
          if (clearStoppedSurface(ref, sessionId)) return true;
          dock$.stopErrorByRef[ref].set("Page runtime changed while stopping; retry Stop Page.");
          return false;
        }
        if (live.sessionId !== sessionId) {
          cacheBrowserSessionIfUnchanged(live, sessionId);
          dock$.stopErrorByRef[ref].set("Page runtime changed while stopping; retry Stop Page.");
          return false;
        }
      }
    }
    dock$.stopErrorByRef[ref].set(result.message ?? "Stop Page failed.");
  } catch {
    dock$.stopErrorByRef[ref].set("Stop Page failed.");
  }
  return false;
};

export const dockSurfaces = (): ReadonlyArray<WorkSurface> => dock$.registry.peek().surfaces;
