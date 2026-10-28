/**
 * V1 of view state (0.11, 04): the window's store over main's rows.
 *
 * One snapshot at window load fills a mirror; every write is applied there
 * first (so a surface reads its own change at once), sent to main, and comes
 * back as a push that is applied again (idempotent). A write that fails asks
 * for the snapshot again rather than leaving the mirror optimistic.
 *
 * Two facades share the mirror: `ViewStateStore` for V2's command groups and
 * `NodeViewStore` for V3's node surfaces. Each read returns the store's own
 * object until that row changes, so a surface may hold it as a React
 * snapshot. A blank canvas reads nothing and writes nothing.
 *
 * The transport is `window.junto.viewState` (preload); tests inject the same
 * interface. Without it (a story, a unit test), the memory stand-ins answer.
 */
import type { JuntoApi, JuntoViewStateApi } from "@shared/ipc";
import type {
  ViewArtifactsFilter,
  ViewCommandGroups,
  ViewCommandSlot,
  ViewFocusSize,
  ViewNodeState,
  ViewOpenItem,
  ViewStateEvent,
  ViewStateSnapshot,
  ViewStateWrite,
} from "@shared/view-state";
import { VIEW_COMMAND_SLOT_COUNT } from "@shared/view-state";
import type {
  ArtifactsNodeView,
  AutomationsNodeView,
  FilesNodeView,
  NodeViewStore,
  SurfaceSize,
  TasksNodeView,
  ViewStateStore,
} from "./view-state";
import { makeMemoryNodeViewStore, makeMemoryViewStateStore } from "./view-state-stand-in";

const EMPTY_SLOT: ViewCommandSlot = { kind: "empty" };
const RAIL_SECTION = "artifact-comments";
const ACTOR_RAIL_SECTION = "seat-rail";
const keyOf = (canvas: string, node: string): string => `${canvas}\n${node}`;

const blankSlots = (): ViewCommandSlot[] =>
  Array.from({ length: VIEW_COMMAND_SLOT_COUNT }, () => EMPTY_SLOT);

type NodeDraft = {
  artifactsFilter?: ViewArtifactsFilter;
  tasksFilter?: ViewNodeState["tasksFilter"];
  openItem?: ViewOpenItem;
  expandedFolders?: ReadonlyArray<string>;
  sidebarCollapsed?: true;
};

type Board = { slots: ViewCommandSlot[]; extras: string[][] };

const isDefaultFilter = (filter: ViewArtifactsFilter): boolean =>
  filter.type === "all" && !filter.archived && filter.labels.length === 0;

const sameFilter = (a: ViewArtifactsFilter | undefined, b: ViewArtifactsFilter): boolean => {
  const left = a ?? { type: "all" as const, archived: false, labels: [] };
  return (
    left.type === b.type &&
    left.archived === b.archived &&
    left.labels.length === b.labels.length &&
    left.labels.every((label, index) => label === b.labels[index])
  );
};

const sameList = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean =>
  a.length === b.length && a.every((value, index) => value === b[index]);

const sameSize = (a: SurfaceSize | undefined, b: SurfaceSize): boolean =>
  a !== undefined && Math.round(a.width) === Math.round(b.width) && Math.round(a.height) === Math.round(b.height);

/** The window's transport: main's IPC, or undefined outside the app. */
const apiOf = (): JuntoViewStateApi | undefined => {
  if (typeof window === "undefined") return undefined;
  return (window as Window & { junto?: JuntoApi }).junto?.viewState;
};

export type MainViewState = {
  readonly viewState: ViewStateStore;
  readonly nodeView: NodeViewStore;
};

/** One mirror over one transport. Exported so a test can drive a fake API. */
export const createMainViewState = (api: JuntoViewStateApi): MainViewState => {
  const boards = new Map<string, Board>();
  const nodes = new Map<string, NodeDraft>();
  const sizes = new Map<string, ViewFocusSize>();
  const sections = new Map<string, boolean>();

  // A read returns this object until its row changes.
  const artifactsCache = new Map<string, ArtifactsNodeView>();
  const tasksCache = new Map<string, TasksNodeView>();
  const automationsCache = new Map<string, AutomationsNodeView>();
  const filesCache = new Map<string, FilesNodeView>();
  const sizeCache = new Map<string, SurfaceSize>();

  const commandListeners = new Set<(canvas: string) => void>();
  const nodeListeners = new Set<() => void>();

  const emitCanvas = (canvas: string): void => {
    for (const listener of commandListeners) listener(canvas);
  };
  const emitNodes = (): void => {
    for (const listener of nodeListeners) listener();
  };

  const boardOf = (canvas: string): Board => {
    const known = boards.get(canvas);
    if (known !== undefined) return known;
    const next: Board = { slots: blankSlots(), extras: [] };
    boards.set(canvas, next);
    return next;
  };

  const patchNode = (key: string, patch: Partial<NodeDraft>): void => {
    const next: NodeDraft = { ...(nodes.get(key) ?? {}), ...patch };
    for (const field of Object.keys(next) as Array<keyof NodeDraft>) {
      if (next[field] === undefined) delete next[field];
    }
    if (Object.keys(next).length === 0) nodes.delete(key);
    else nodes.set(key, next);
  };

  const clearCaches = (): void => {
    artifactsCache.clear();
    tasksCache.clear();
    automationsCache.clear();
    filesCache.clear();
    sizeCache.clear();
  };

  const hydrate = (snapshot: ViewStateSnapshot): void => {
    boards.clear();
    nodes.clear();
    sizes.clear();
    sections.clear();
    for (const [canvas, groups] of Object.entries(snapshot.commandGroups)) {
      boards.set(canvas, {
        slots: groups.slots.slice(0, VIEW_COMMAND_SLOT_COUNT).map((slot) => slot ?? EMPTY_SLOT),
        extras: groups.extras.map((group) => [...group]),
      });
    }
    for (const [canvas, byNode] of Object.entries(snapshot.nodes)) {
      for (const [node, state] of Object.entries(byNode)) nodes.set(keyOf(canvas, node), { ...state });
    }
    for (const [surface, size] of Object.entries(snapshot.focusSizes)) sizes.set(surface, size);
    for (const [section, open] of Object.entries(snapshot.sections)) sections.set(section, open);
    clearCaches();
  };

  /** Apply one write to the mirror, invalidating only the views it touched. */
  const apply = (write: ViewStateWrite): void => {
    switch (write.area) {
      case "command-slot":
        boardOf(write.canvasName).slots[write.slot] = write.value;
        break;
      case "command-extras":
        boardOf(write.canvasName).extras = write.value.map((group) => [...group]);
        break;
      case "artifacts-filter": {
        const key = keyOf(write.canvasName, write.nodeId);
        patchNode(key, { artifactsFilter: isDefaultFilter(write.value) ? undefined : write.value });
        artifactsCache.delete(key);
        break;
      }
      case "tasks-filter": {
        const key = keyOf(write.canvasName, write.nodeId);
        patchNode(key, { tasksFilter: write.value === "all" ? undefined : write.value });
        tasksCache.delete(key);
        break;
      }
      case "open-item": {
        const key = keyOf(write.canvasName, write.nodeId);
        patchNode(key, { openItem: write.value ?? undefined });
        for (const cache of [artifactsCache, tasksCache, automationsCache, filesCache]) cache.delete(key);
        break;
      }
      case "expanded-folders": {
        const key = keyOf(write.canvasName, write.nodeId);
        patchNode(key, { expandedFolders: write.value.length === 0 ? undefined : [...write.value] });
        filesCache.delete(key);
        break;
      }
      case "sidebar":
        patchNode(keyOf(write.canvasName, write.nodeId), { sidebarCollapsed: write.collapsed ? true : undefined });
        break;
      case "focus-size":
        if (write.value === null) sizes.delete(write.surface);
        else sizes.set(write.surface, write.value);
        sizeCache.delete(write.surface);
        break;
      case "section":
        sections.set(write.section, write.open);
        break;
    }
  };

  const announce = (write: ViewStateWrite): void => {
    if (write.area === "command-slot" || write.area === "command-extras") emitCanvas(write.canvasName);
    emitNodes();
  };

  let hydrating = true;
  const pending: ViewStateEvent[] = [];

  const reload = async (): Promise<void> => {
    // A canvas that just lost its board still has readers holding the old
    // one: announce every canvas that had one before, as well as after.
    const known = new Set(boards.keys());
    try {
      const snapshot = await api.snapshot();
      hydrate(snapshot);
      for (const canvas of new Set([...known, ...boards.keys()])) emitCanvas(canvas);
      emitNodes();
    } catch {
      // A store that cannot be read leaves the mirror as it was; the next
      // change or the next launch tries again.
    }
  };

  const send = (write: ViewStateWrite): void => {
    apply(write);
    announce(write);
    void api.apply(write).then(
      (result) => {
        if (!result.ok) void reload();
      },
      () => void reload(),
    );
  };

  const applyEvent = (event: ViewStateEvent): void => {
    if (event.area === "reload") {
      // Rows went with a node or canvas: read the snapshot again.
      void reload();
      return;
    }
    apply(event);
    announce(event);
  };

  void (async () => {
    await reload();
    hydrating = false;
    for (const event of pending.splice(0)) applyEvent(event);
  })();

  const off = api.onChanged((event) => {
    if (hydrating) {
      pending.push(event);
      return;
    }
    applyEvent(event);
  });
  // The page's lifetime owns the transport; a store made once lives with it.
  void off;

  const readBoard = (canvas: string): ViewCommandGroups | undefined => {
    if (canvas === "") return undefined;
    const board = boards.get(canvas);
    if (board === undefined) return undefined;
    return {
      slots: board.slots.slice(0, VIEW_COMMAND_SLOT_COUNT).map((slot) => slot ?? EMPTY_SLOT),
      extras: board.extras.map((group) => [...group]),
    };
  };

  const writeSlot = (canvas: string, index: number, slot: ViewCommandSlot): void => {
    if (canvas === "" || !Number.isInteger(index) || index < 0 || index >= VIEW_COMMAND_SLOT_COUNT) return;
    send({ area: "command-slot", canvasName: canvas, slot: index, value: slot });
  };

  const writeExtras = (canvas: string, extras: ReadonlyArray<ReadonlyArray<string>>): void => {
    if (canvas === "") return;
    send({ area: "command-extras", canvasName: canvas, value: extras.map((group) => [...group]) });
  };

  const artifactsOf = (canvas: string, node: string): ArtifactsNodeView | undefined => {
    if (canvas === "") return undefined;
    const key = keyOf(canvas, node);
    const cached = artifactsCache.get(key);
    if (cached !== undefined) return cached;
    const saved = nodes.get(key);
    const open = saved?.openItem?.kind === "artifact" ? saved.openItem.id : null;
    const filter = saved?.artifactsFilter;
    if (filter === undefined && open === null) return undefined;
    const view: ArtifactsNodeView = {
      type: filter?.type ?? "all",
      archived: filter?.archived ?? false,
      labels: [...(filter?.labels ?? [])].sort(),
      open,
    };
    artifactsCache.set(key, view);
    return view;
  };

  const tasksOf = (canvas: string, node: string): TasksNodeView | undefined => {
    if (canvas === "") return undefined;
    const key = keyOf(canvas, node);
    const cached = tasksCache.get(key);
    if (cached !== undefined) return cached;
    const saved = nodes.get(key);
    const open = saved?.openItem?.kind === "task" ? saved.openItem.id : null;
    if (saved?.tasksFilter === undefined && open === null) return undefined;
    const view: TasksNodeView = { state: saved?.tasksFilter ?? "all", open };
    tasksCache.set(key, view);
    return view;
  };

  const automationsOf = (canvas: string, node: string): AutomationsNodeView | undefined => {
    if (canvas === "") return undefined;
    const key = keyOf(canvas, node);
    const cached = automationsCache.get(key);
    if (cached !== undefined) return cached;
    const saved = nodes.get(key);
    if (saved?.openItem?.kind !== "automation") return undefined;
    const view: AutomationsNodeView = { open: saved.openItem.id };
    automationsCache.set(key, view);
    return view;
  };

  const filesOf = (canvas: string, node: string): FilesNodeView | undefined => {
    if (canvas === "") return undefined;
    const key = keyOf(canvas, node);
    const cached = filesCache.get(key);
    if (cached !== undefined) return cached;
    const saved = nodes.get(key);
    const open = saved?.openItem?.kind === "file" ? saved.openItem.path : null;
    const expanded = saved?.expandedFolders ?? [];
    if (open === null && expanded.length === 0) return undefined;
    const view: FilesNodeView = { open, expanded: [...expanded] };
    filesCache.set(key, view);
    return view;
  };

  const writeArtifacts = (canvas: string, node: string, view: ArtifactsNodeView): void => {
    if (canvas === "") return;
    const saved = nodes.get(keyOf(canvas, node));
    const labels = [...view.labels].sort();
    const filter: ViewArtifactsFilter = { type: view.type, archived: view.archived, labels };
    if (!sameFilter(saved?.artifactsFilter, filter)) {
      send({ area: "artifacts-filter", canvasName: canvas, nodeId: node, value: filter });
    }
    const open = saved?.openItem?.kind === "artifact" ? saved.openItem.id : null;
    if (open !== view.open) {
      send({
        area: "open-item",
        canvasName: canvas,
        nodeId: node,
        value: view.open === null ? null : { kind: "artifact", id: view.open },
      });
    }
  };

  const writeTasks = (canvas: string, node: string, view: TasksNodeView): void => {
    if (canvas === "") return;
    const saved = nodes.get(keyOf(canvas, node));
    if ((saved?.tasksFilter ?? "all") !== view.state) {
      send({ area: "tasks-filter", canvasName: canvas, nodeId: node, value: view.state });
    }
    const open = saved?.openItem?.kind === "task" ? saved.openItem.id : null;
    if (open !== view.open) {
      send({
        area: "open-item",
        canvasName: canvas,
        nodeId: node,
        value: view.open === null ? null : { kind: "task", id: view.open },
      });
    }
  };

  const writeAutomations = (canvas: string, node: string, view: AutomationsNodeView): void => {
    if (canvas === "") return;
    const saved = nodes.get(keyOf(canvas, node));
    const open = saved?.openItem?.kind === "automation" ? saved.openItem.id : null;
    if (open !== view.open) {
      send({
        area: "open-item",
        canvasName: canvas,
        nodeId: node,
        value: view.open === null ? null : { kind: "automation", id: view.open },
      });
    }
  };

  const writeFiles = (canvas: string, node: string, view: FilesNodeView): void => {
    if (canvas === "") return;
    const saved = nodes.get(keyOf(canvas, node));
    const open = saved?.openItem?.kind === "file" ? saved.openItem.path : null;
    if (open !== view.open) {
      send({
        area: "open-item",
        canvasName: canvas,
        nodeId: node,
        value: view.open === null ? null : { kind: "file", path: view.open },
      });
    }
    if (!sameList(saved?.expandedFolders ?? [], view.expanded)) {
      send({ area: "expanded-folders", canvasName: canvas, nodeId: node, value: [...view.expanded] });
    }
  };

  const writeSidebarCollapsed = (canvas: string, node: string, collapsed: boolean): void => {
    if (canvas === "") return;
    if ((nodes.get(keyOf(canvas, node))?.sidebarCollapsed === true) === collapsed) return;
    send({ area: "sidebar", canvasName: canvas, nodeId: node, collapsed });
  };

  const writeSurfaceSize = (surface: string, size: SurfaceSize | null): void => {
    if (size === null) {
      if (sizes.has(surface)) send({ area: "focus-size", surface, value: null });
      return;
    }
    const next = { width: Math.round(size.width), height: Math.round(size.height) };
    if (sameSize(sizes.get(surface), next)) return;
    send({ area: "focus-size", surface, value: next });
  };

  const writeCommentsRailOpen = (open: boolean): void => {
    if ((sections.get(RAIL_SECTION) ?? false) === open) return;
    send({ area: "section", section: RAIL_SECTION, open });
  };

  const writeActorRailExpanded = (expanded: boolean): void => {
    if ((sections.get(ACTOR_RAIL_SECTION) ?? true) === expanded) return;
    send({ area: "section", section: ACTOR_RAIL_SECTION, open: expanded });
  };

  const viewState: ViewStateStore = {
    read: readBoard,
    writeSlot,
    writeExtras,
    onChange: (listener) => {
      commandListeners.add(listener);
      return () => commandListeners.delete(listener);
    },
  };

  const nodeView: NodeViewStore = {
    artifacts: artifactsOf,
    writeArtifacts,
    tasks: tasksOf,
    writeTasks,
    automations: automationsOf,
    writeAutomations,
    files: filesOf,
    writeFiles,
    sidebarCollapsed: (canvas, node) => canvas !== "" && nodes.get(keyOf(canvas, node))?.sidebarCollapsed === true,
    writeSidebarCollapsed,
    surfaceSize: (surface) => {
      const cached = sizeCache.get(surface);
      if (cached !== undefined) return cached;
      const saved = sizes.get(surface);
      if (saved !== undefined) sizeCache.set(surface, saved);
      return saved;
    },
    writeSurfaceSize,
    commentsRailOpen: () => sections.get(RAIL_SECTION) ?? false,
    writeCommentsRailOpen,
    actorRailExpanded: () => sections.get(ACTOR_RAIL_SECTION) ?? true,
    writeActorRailExpanded,
    onChange: (listener) => {
      nodeListeners.add(listener);
      return () => nodeListeners.delete(listener);
    },
  };

  return { viewState, nodeView };
};

let shared: MainViewState | undefined;

/** The app's one store; the stand-in when there is no preload (a test, a story). */
const sharedOf = (): MainViewState | undefined => {
  const api = apiOf();
  if (api === undefined) return undefined;
  shared ??= createMainViewState(api);
  return shared;
};

export const defaultViewStateStore = (): ViewStateStore =>
  sharedOf()?.viewState ?? makeMemoryViewStateStore();

export const defaultNodeViewStore = (): NodeViewStore =>
  sharedOf()?.nodeView ?? makeMemoryNodeViewStore();
