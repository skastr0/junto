/**
 * The canvas seam for e2e (docs/canvas-gpu-architecture.md §22, milestone 0.1).
 *
 * Every spec talks to the canvas through this module and nothing else: no
 * `.react-flow` selector and no `rf__` test id may appear in a spec. Two
 * backends sit behind the same surface:
 *
 *  - `dom` (today): reads the React Flow DOM. Pointer actions delegate to
 *    Playwright locators, so a click is exactly the click the spec wrote
 *    before the migration.
 *  - `hook` (milestone 0.3+): reads `window.__juntoCanvas`, the test hook the
 *    GPU canvas exposes in test builds (ready, ids, screen rect of a card or
 *    part, text, selection, camera, tier). Pointer actions stay real input —
 *    `page.mouse` at the points the hook returns — so engine picking is what
 *    the spec exercises, never a synthetic app command.
 *
 * `canvasBackend` picks the backend per call: the hook wins when it exists,
 * so a spec can flip the feature key live and keep working. Facts the hook
 * does not carry (a card's DOM subtree, focus, in-card queries) go through
 * `card().element()`, which is DOM-only by definition and throws under the
 * hook — those assertions get rewritten against the hook when it lands.
 */
import { expect, type Locator, type Page } from "@playwright/test";
import type { CanvasTestHook, EngineStats } from "../../src/window/canvas/contract";

export interface CanvasPoint {
  readonly x: number;
  readonly y: number;
}

export interface CanvasRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface CanvasCamera {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
}

export type CanvasModifier = "Alt" | "Control" | "Meta" | "Shift";

export interface CanvasClickOptions {
  /** Offset from the card's/pane's/part's top-left corner; default is its centre. */
  readonly position?: CanvasPoint;
  readonly modifiers?: ReadonlyArray<CanvasModifier>;
  readonly button?: "left" | "middle" | "right";
}

export interface CanvasDragOptions extends CanvasClickOptions {
  /** Pointer moves between press and release; default 12. */
  readonly steps?: number;
  /** Drag origin; default is the card's centre. */
  readonly from?: CanvasPoint;
}

export type HandleSide = "top" | "right" | "bottom" | "left";
export type HandleType = "source" | "target";

/** A card or pane sub-element: a connect handle, a verb drop zone, the
 * floating toolbar, a region's drag handle. */
export type CanvasPartQuery =
  | { readonly kind: "handle"; readonly side: HandleSide; readonly type?: HandleType }
  | { readonly kind: "verbZone"; readonly verb: string }
  | { readonly kind: "toolbar" }
  | { readonly kind: "regionHandle" };

export interface CanvasPart {
  box(): Promise<CanvasRect | null>;
  /** How many elements the part resolves to (the `toHaveCount` form). */
  count(): Promise<number>;
  click(options?: CanvasClickOptions): Promise<void>;
  rightClick(options?: { readonly position?: CanvasPoint; readonly modifiers?: ReadonlyArray<CanvasModifier> }): Promise<void>;
  hover(): Promise<void>;
}

export interface CanvasCard {
  readonly id: string;
  /** Assert the card is rendered and visible; throws after `timeout`. */
  visible(options?: { readonly timeout?: number }): Promise<void>;
  /** 0 or 1 — the count form specs used with `toHaveCount`. */
  count(): Promise<number>;
  box(): Promise<CanvasRect | null>;
  /** Rendered text content (what `toContainText` matched). */
  text(): Promise<string>;
  selected(): Promise<boolean>;
  click(options?: CanvasClickOptions): Promise<void>;
  dblclick(options?: CanvasClickOptions): Promise<void>;
  rightClick(options?: { readonly position?: CanvasPoint; readonly modifiers?: ReadonlyArray<CanvasModifier> }): Promise<void>;
  /** Real pointer drag to another card's centre or an absolute point. */
  drag(to: CanvasPoint | CanvasCard, options?: CanvasDragOptions): Promise<void>;
  /** The floating toolbar shown for this card's selection. */
  toolbar(): CanvasPart;
  /**
   * The card's DOM element — the escape hatch for assertions the helper does
   * not cover (focus, roles, in-card queries, data attributes). DOM backend
   * only; throws under the GPU hook, where the fact must come from the hook
   * or the model instead.
   */
  element(): Promise<Locator>;
}

export interface CanvasPane {
  box(): Promise<CanvasRect | null>;
  click(options?: CanvasClickOptions): Promise<void>;
  rightClick(options?: { readonly position?: CanvasPoint }): Promise<void>;
  /**
   * A synthetic click dispatched on the pane element itself — what specs used
   * to clear a selection without a real pointer landing on whatever card
   * sits under the point. DOM backend only; the hook backend throws.
   */
  dispatchClick(): Promise<void>;
}

/**
 * The test hook the GPU canvas exposes in test builds (milestone 0.3 owns the
 * app side). This is the contract's `CanvasTestHook` (src/window/canvas/
 * contract.ts), which the shell puts on `window.__juntoCanvas`. `rectOf`'s
 * `part` carries the hook's part vocabulary — `handle:<role>:<side>`,
 * `verb:<verb>`, `region-handle`, `toolbar` — wider than `Part["kind"]`, so
 * the calls below cast the key through.
 */
export type { CanvasTestHook, EngineStats };

declare global {
  interface Window {
    __juntoCanvas?: CanvasTestHook;
  }
}

// --- DOM backend -----------------------------------------------------------
//
// The only place React Flow selectors may live. `CANVAS_DOM` is exported for
// measurement probes (zz-*) that must observe raw DOM the helper does not
// abstract, like a per-frame transform log; specs use the helpers below.

export const CANVAS_DOM = {
  root: ".react-flow",
  viewport: ".react-flow__viewport",
  pane: ".react-flow__pane",
  node: ".react-flow__node",
  cardNode: ".react-flow__node:not(.react-flow__node-group)",
  regionNode: ".react-flow__node-group",
  selectedNode: ".react-flow__node.selected",
  toolbar: ".react-flow__node-toolbar",
} as const;

const attr = (value: string): string => JSON.stringify(value);

const nodeSelector = (id: string): string =>
  `${CANVAS_DOM.node}[data-id=${attr(id)}]`;

const partSelector = (id: string, part: CanvasPartQuery): string => {
  switch (part.kind) {
    case "handle":
      return `${nodeSelector(id)} .junto-handle--${part.type ?? "source"}.junto-handle--${part.side}`;
    case "verbZone":
      return `${nodeSelector(id)} [data-verb=${attr(part.verb)}]`;
    case "regionHandle":
      return `${nodeSelector(id)} .region-drag-handle`;
    case "toolbar":
      return `${CANVAS_DOM.toolbar}[data-id~=${attr(id)}]`;
  }
};

/**
 * The hook's part vocabulary — the strings `rectOf`'s `part` argument carries
 * in the shell's test hook (`src/window/canvas/shell/test-hook.ts`):
 * `handle:<role>:<side>`, `verb:<verb>`, `region-handle`, `toolbar`.
 */
const hookPartKey = (part: CanvasPartQuery): string => {
  switch (part.kind) {
    case "handle":
      return `handle:${part.type ?? "source"}:${part.side}`;
    case "verbZone":
      return `verb:${part.verb}`;
    case "regionHandle":
      return "region-handle";
    case "toolbar":
      return "toolbar";
  }
};

interface CanvasProbe {
  ready(page: Page): Promise<boolean>;
  ids(page: Page): Promise<ReadonlyArray<string>>;
  regionCount(page: Page): Promise<number>;
  selectedIds(page: Page): Promise<ReadonlyArray<string>>;
  cardCount(page: Page, id: string): Promise<number>;
  cardVisible(page: Page, id: string): Promise<boolean>;
  cardRect(page: Page, id: string): Promise<CanvasRect | null>;
  cardText(page: Page, id: string): Promise<string>;
  cardSelected(page: Page, id: string): Promise<boolean>;
  cardIdsByText(page: Page, text: string): Promise<ReadonlyArray<string>>;
  paneRect(page: Page): Promise<CanvasRect | null>;
  partRect(page: Page, id: string, part: CanvasPartQuery): Promise<CanvasRect | null>;
  partCount(page: Page, id: string, part: CanvasPartQuery): Promise<number>;
  camera(page: Page): Promise<CanvasCamera>;
}

const domNode = (page: Page, id: string): Locator => page.locator(nodeSelector(id));

const domProbe: CanvasProbe = {
  ready: (page) => page.locator(CANVAS_DOM.root).isVisible().catch(() => false),
  ids: (page) =>
    page
      .locator(CANVAS_DOM.cardNode)
      .evaluateAll((els) => els.map((el) => el.getAttribute("data-id") ?? ""))
      .catch(() => [] as string[]),
  regionCount: (page) => page.locator(CANVAS_DOM.regionNode).count(),
  selectedIds: (page) =>
    page
      .locator(CANVAS_DOM.selectedNode)
      .evaluateAll((els) => els.map((el) => el.getAttribute("data-id") ?? ""))
      .catch(() => [] as string[]),
  cardCount: (page, id) => domNode(page, id).count(),
  cardVisible: (page, id) => domNode(page, id).isVisible().catch(() => false),
  cardRect: (page, id) => domNode(page, id).boundingBox(),
  cardText: (page, id) => domNode(page, id).innerText(),
  cardSelected: (page, id) =>
    domNode(page, id)
      .evaluate((el) => el.classList.contains("selected"))
      .catch(() => false),
  cardIdsByText: (page, text) =>
    page.evaluate(
      ([selector, needle]) => {
        const wanted = needle.toLowerCase();
        const found: string[] = [];
        for (const el of document.querySelectorAll(selector)) {
          if (((el as HTMLElement).innerText ?? "").toLowerCase().includes(wanted)) {
            found.push(el.getAttribute("data-id") ?? "");
          }
        }
        return found;
      },
      [CANVAS_DOM.cardNode, text] as const,
    ),
  paneRect: (page) => page.locator(CANVAS_DOM.pane).boundingBox(),
  partRect: (page, id, part) =>
    page.locator(partSelector(id, part)).first().boundingBox(),
  partCount: (page, id, part) => page.locator(partSelector(id, part)).count(),
  camera: async (page) => {
    const transform = await page
      .locator(CANVAS_DOM.viewport)
      .evaluate((el) => (el as HTMLElement).style.transform);
    const match =
      /translate\(([-\d.e]+)px,\s*([-\d.e]+)px\)\s*scale\(([-\d.e]+)\)/.exec(transform);
    if (match === null) {
      throw new Error(`canvas viewport transform unreadable: ${JSON.stringify(transform)}`);
    }
    return { x: Number(match[1]), y: Number(match[2]), zoom: Number(match[3]) };
  },
};

const hookProbe: CanvasProbe = {
  ready: (page) =>
    page.evaluate(() => window.__juntoCanvas?.ready() === true).catch(() => false),
  ids: (page) =>
    page.evaluate(() => [...(window.__juntoCanvas?.cardIds() ?? [])]),
  regionCount: (page) =>
    page.evaluate(() => window.__juntoCanvas?.regionIds().length ?? 0),
  selectedIds: (page) =>
    page.evaluate(() => [...(window.__juntoCanvas?.selection() ?? [])]),
  cardCount: (page, id) =>
    page.evaluate(
      (cardId) => (window.__juntoCanvas?.cardIds().includes(cardId) === true ? 1 : 0),
      id,
    ),
  cardVisible: (page, id) =>
    page.evaluate((cardId) => {
      const rect = window.__juntoCanvas?.rectOf(cardId);
      return rect !== undefined && rect.width > 0 && rect.height > 0;
    }, id),
  cardRect: (page, id) =>
    page.evaluate((cardId) => window.__juntoCanvas?.rectOf(cardId) ?? null, id),
  cardText: (page, id) =>
    page.evaluate((cardId) => window.__juntoCanvas?.textOf(cardId) ?? "", id),
  cardSelected: (page, id) =>
    page.evaluate(
      (cardId) => window.__juntoCanvas?.selection().includes(cardId) === true,
      id,
    ),
  cardIdsByText: (page, text) =>
    page.evaluate((needle) => {
      const hook = window.__juntoCanvas;
      if (hook === undefined) return [] as string[];
      const wanted = needle.toLowerCase();
      return hook.cardIds().filter((id) => (hook.textOf(id) ?? "").toLowerCase().includes(wanted));
    }, text),
  paneRect: (page) =>
    page.evaluate(() => window.__juntoCanvas?.rectOf("") ?? null),
  partRect: (page, id, part) =>
    page.evaluate(
      ([cardId, key]) =>
        window.__juntoCanvas?.rectOf(cardId, key as Parameters<NonNullable<Window["__juntoCanvas"]>["rectOf"]>[1]) ?? null,
      [id, hookPartKey(part)] as const,
    ),
  partCount: (page, id, part) =>
    page.evaluate(
      ([cardId, key]) =>
        (window.__juntoCanvas?.rectOf(
          cardId,
          key as Parameters<NonNullable<Window["__juntoCanvas"]>["rectOf"]>[1],
        ) != null
          ? 1
          : 0),
      [id, hookPartKey(part)] as const,
    ),
  camera: (page) =>
    page.evaluate(() => {
      const hook = window.__juntoCanvas;
      if (hook === undefined) throw new Error("canvas hook missing");
      return hook.camera();
    }),
};

type CanvasBackend =
  | { readonly kind: "dom"; readonly probe: CanvasProbe }
  | { readonly kind: "hook"; readonly probe: CanvasProbe };

const canvasBackend = async (page: Page): Promise<CanvasBackend> => {
  const hooked = await page
    .evaluate(() => typeof window.__juntoCanvas?.ready === "function")
    .catch(() => false);
  return hooked ? { kind: "hook", probe: hookProbe } : { kind: "dom", probe: domProbe };
};

// --- shared pointer plumbing ------------------------------------------------

const centre = (rect: CanvasRect): CanvasPoint => ({
  x: rect.x + rect.width / 2,
  y: rect.y + rect.height / 2,
});

const pointIn = (rect: CanvasRect, position: CanvasPoint | undefined): CanvasPoint => ({
  x: rect.x + (position?.x ?? rect.width / 2),
  y: rect.y + (position?.y ?? rect.height / 2),
});

/**
 * A locator click waits for the element's box to hold still before pressing.
 * The hook reports live rects, so give the same courtesy: two equal samples a
 * beat apart mean the camera is not mid-flight under the point.
 */
const stableRect = async (
  read: () => Promise<CanvasRect | null>,
  label: string,
): Promise<CanvasRect> => {
  const deadline = Date.now() + 4_000;
  let last: CanvasRect | null = null;
  for (;;) {
    const rect = await read();
    if (rect !== null) {
      if (
        last !== null &&
        rect.x === last.x &&
        rect.y === last.y &&
        rect.width === last.width &&
        rect.height === last.height
      ) {
        return rect;
      }
      last = rect;
    }
    if (Date.now() >= deadline) {
      throw new Error(`${label}: no stable rect within 4000ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
};

const modifiersDown = async (
  page: Page,
  modifiers: ReadonlyArray<CanvasModifier> | undefined,
): Promise<void> => {
  for (const modifier of modifiers ?? []) await page.keyboard.down(modifier);
};

const modifiersUp = async (
  page: Page,
  modifiers: ReadonlyArray<CanvasModifier> | undefined,
): Promise<void> => {
  for (const modifier of [...(modifiers ?? [])].reverse()) {
    await page.keyboard.up(modifier);
  }
};

const hookClick = async (
  page: Page,
  point: CanvasPoint,
  options?: CanvasClickOptions,
): Promise<void> => {
  await modifiersDown(page, options?.modifiers);
  try {
    await page.mouse.click(point.x, point.y, { button: options?.button ?? "left" });
  } finally {
    await modifiersUp(page, options?.modifiers);
  }
};

const hookHover = async (page: Page, point: CanvasPoint): Promise<void> => {
  await page.mouse.move(point.x, point.y);
};

// --- parts -------------------------------------------------------------------

const makePart = (
  page: Page,
  id: string,
  part: CanvasPartQuery,
  label: string,
): CanvasPart => {
  const backend = (): Promise<CanvasBackend> => canvasBackend(page);
  const locatorPart = (): Locator => page.locator(partSelector(id, part)).first();

  const pointFor = async (position?: CanvasPoint): Promise<CanvasPoint> => {
    const { probe } = await backend();
    const rect = await stableRect(() => probe.partRect(page, id, part), label);
    return pointIn(rect, position);
  };

  const clickAt = async (options?: CanvasClickOptions): Promise<void> => {
    const b = await backend();
    if (b.kind === "dom") {
      await locatorPart().click({
        ...(options?.position === undefined ? {} : { position: options.position }),
        ...(options?.modifiers === undefined
          ? {}
          : { modifiers: [...options.modifiers] }),
        ...(options?.button === undefined ? {} : { button: options.button }),
      });
      return;
    }
    await hookClick(page, await pointFor(options?.position), options);
  };

  return {
    box: async () => {
      const { probe } = await backend();
      return probe.partRect(page, id, part);
    },

    count: async () => {
      const { probe } = await backend();
      return probe.partCount(page, id, part);
    },

    click: clickAt,

    rightClick: async (options) => {
      await clickAt({ position: options?.position, modifiers: options?.modifiers, button: "right" });
    },

    hover: async () => {
      const b = await backend();
      if (b.kind === "dom") {
        const rect = await locatorPart().boundingBox();
        if (rect === null) throw new Error(`${label}: no box to hover`);
        await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
        return;
      }
      await hookHover(page, await pointFor());
    },
  };
};

// --- public surface ---------------------------------------------------------

/** The canvas is mounted and painted. Replaces `expect(.react-flow).toBeVisible`. */
export const canvasReady = async (
  page: Page,
  options?: { readonly timeout?: number },
): Promise<void> => {
  const { probe } = await canvasBackend(page);
  await expect
    .poll(() => probe.ready(page), {
      timeout: options?.timeout ?? 30_000,
      message: "the canvas never became ready",
    })
    .toBe(true);
};

/** Card (non-region) node count. */
export const cardCount = async (page: Page): Promise<number> => {
  const { probe } = await canvasBackend(page);
  return (await probe.ids(page)).length;
};

/** Region node count. */
export const regionCount = async (page: Page): Promise<number> => {
  const { probe } = await canvasBackend(page);
  return probe.regionCount(page);
};

/** Card ids in paint order — for "find the card whose text is X" lookups. */
export const cardIds = async (page: Page): Promise<ReadonlyArray<string>> => {
  const { probe } = await canvasBackend(page);
  return probe.ids(page);
};

/** Data-ids of every selected node (cards and regions), paint order. */
export const selectedIds = async (page: Page): Promise<ReadonlyArray<string>> => {
  const { probe } = await canvasBackend(page);
  return probe.selectedIds(page);
};

/**
 * Ids of the cards whose rendered text contains `text` (case-insensitive,
 * like Playwright's `hasText`) — for "find the card whose text is X" lookups.
 */
export const cardIdsByText = async (page: Page, text: string): Promise<ReadonlyArray<string>> => {
  const { probe } = await canvasBackend(page);
  return probe.cardIdsByText(page, text);
};

/**
 * The first card whose rendered text contains `text` — the `hasText` lookup
 * specs used. Polls until one appears or `timeout` (default 30s) throws.
 */
export const cardByText = async (
  page: Page,
  text: string,
  options?: { readonly timeout?: number },
): Promise<CanvasCard> => {
  const { probe } = await canvasBackend(page);
  const timeout = options?.timeout ?? 30_000;
  const deadline = Date.now() + timeout;
  for (;;) {
    const ids = await probe.cardIdsByText(page, text);
    if (ids.length > 0) return card(page, ids[0]!);
    if (Date.now() >= deadline) {
      throw new Error(`no canvas card contains ${JSON.stringify(text)} within ${timeout}ms`);
    }
    await page.waitForTimeout(100);
  }
};

export const card = (page: Page, id: string): CanvasCard => {
  const cardBackend = (): Promise<CanvasBackend> => canvasBackend(page);
  const locator = (): Locator => domNode(page, id);

  const pointFor = async (options?: CanvasClickOptions): Promise<CanvasPoint> => {
    const { probe } = await cardBackend();
    const rect = await stableRect(() => probe.cardRect(page, id), `card ${id}`);
    return pointIn(rect, options?.position);
  };

  const dragTo = async (to: CanvasPoint | CanvasCard, options?: CanvasDragOptions): Promise<void> => {
    const { probe } = await cardBackend();
    const from =
      options?.from ??
      centre(await stableRect(() => probe.cardRect(page, id), `card ${id}`));
    const target =
      typeof to === "object" && "id" in to
        ? centre(await stableRect(() => probe.cardRect(page, to.id), `card ${to.id}`))
        : to;
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    try {
      await page.mouse.move(target.x, target.y, { steps: options?.steps ?? 12 });
    } finally {
      await page.mouse.up();
    }
  };

  return {
    id,

    visible: async (options) => {
      const { probe } = await cardBackend();
      await expect
        .poll(() => probe.cardVisible(page, id), {
          timeout: options?.timeout ?? 30_000,
          message: `canvas card ${id} never became visible`,
        })
        .toBe(true);
    },

    count: async () => {
      const { probe } = await cardBackend();
      return probe.cardCount(page, id);
    },

    box: async () => {
      const { probe } = await cardBackend();
      return probe.cardRect(page, id);
    },

    text: async () => {
      const { probe } = await cardBackend();
      return probe.cardText(page, id);
    },

    selected: async () => {
      const { probe } = await cardBackend();
      return probe.cardSelected(page, id);
    },

    click: async (options) => {
      const backend = await cardBackend();
      if (backend.kind === "dom") {
        await locator().click({
          ...(options?.position === undefined ? {} : { position: options.position }),
          ...(options?.modifiers === undefined
            ? {}
            : { modifiers: [...options.modifiers] }),
          ...(options?.button === undefined ? {} : { button: options.button }),
        });
        return;
      }
      await hookClick(page, await pointFor(options), options);
    },

    dblclick: async (options) => {
      const backend = await cardBackend();
      if (backend.kind === "dom") {
        await locator().dblclick({
          ...(options?.position === undefined ? {} : { position: options.position }),
          ...(options?.modifiers === undefined
            ? {}
            : { modifiers: [...options.modifiers] }),
          ...(options?.button === undefined ? {} : { button: options.button }),
        });
        return;
      }
      const point = await pointFor(options);
      await modifiersDown(page, options?.modifiers);
      try {
        await page.mouse.dblclick(point.x, point.y, { button: options?.button ?? "left" });
      } finally {
        await modifiersUp(page, options?.modifiers);
      }
    },

    rightClick: async (options) => {
      const backend = await cardBackend();
      if (backend.kind === "dom") {
        await locator().click({
          ...(options?.position === undefined ? {} : { position: options.position }),
          ...(options?.modifiers === undefined
            ? {}
            : { modifiers: [...options.modifiers] }),
          button: "right",
        });
        return;
      }
      const point = await pointFor(options);
      await modifiersDown(page, options?.modifiers);
      try {
        await page.mouse.click(point.x, point.y, { button: "right" });
      } finally {
        await modifiersUp(page, options?.modifiers);
      }
    },

    drag: dragTo,

    toolbar: () => makePart(page, id, { kind: "toolbar" }, `toolbar of card ${id}`),

    element: async () => {
      const backend = await cardBackend();
      if (backend.kind !== "dom") {
        throw new Error(
          `card(${id}).element() reads the DOM canvas; the GPU canvas exposes facts through the hook, not elements`,
        );
      }
      return locator();
    },
  };
};

export const pane = (page: Page): CanvasPane => {
  const paneLocator = (): Locator => page.locator(CANVAS_DOM.pane);

  const pointFor = async (options?: { readonly position?: CanvasPoint }): Promise<CanvasPoint> => {
    const { probe } = await canvasBackend(page);
    const rect = await stableRect(() => probe.paneRect(page), "canvas pane");
    return pointIn(rect, options?.position);
  };

  return {
    box: async () => {
      const { probe } = await canvasBackend(page);
      return probe.paneRect(page);
    },

    click: async (options) => {
      const backend = await canvasBackend(page);
      if (backend.kind === "dom") {
        await paneLocator().click({
          ...(options?.position === undefined ? {} : { position: options.position }),
          ...(options?.modifiers === undefined
            ? {}
            : { modifiers: [...options.modifiers] }),
          ...(options?.button === undefined ? {} : { button: options.button }),
        });
        return;
      }
      await hookClick(page, await pointFor(options), options);
    },

    rightClick: async (options) => {
      const backend = await canvasBackend(page);
      if (backend.kind === "dom") {
        await paneLocator().click({
          ...(options?.position === undefined ? {} : { position: options.position }),
          button: "right",
        });
        return;
      }
      const point = await pointFor(options);
      await page.mouse.click(point.x, point.y, { button: "right" });
    },

    dispatchClick: async () => {
      const backend = await canvasBackend(page);
      if (backend.kind !== "dom") {
        throw new Error("pane().dispatchClick() is a DOM-canvas escape; the GPU canvas takes real pointer input");
      }
      await page.evaluate((selector) => {
        document.querySelector(selector)?.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
      }, CANVAS_DOM.pane);
    },
  };
};

/** The camera the canvas is showing: pan offset and zoom. */
export const camera = async (page: Page): Promise<CanvasCamera> => {
  const { probe } = await canvasBackend(page);
  return probe.camera(page);
};

/**
 * The tier the canvas is drawing at. The hook answers `tier()`; the DOM
 * backend reads the app's `data-canvas-tier` (what the DOM canvas sets today).
 */
export const canvasTier = async (page: Page): Promise<string> => {
  const backend = await canvasBackend(page);
  if (backend.kind === "hook") {
    return page.evaluate(() => window.__juntoCanvas!.tier());
  }
  return page.evaluate(() => document.documentElement.dataset.canvasTier ?? "dom");
};

/** The engine's own counters — the hook backend only; null on the DOM canvas. */
export const canvasStats = async (page: Page): Promise<EngineStats | null> =>
  page.evaluate(() => window.__juntoCanvas?.stats() ?? null).catch(() => null);

/**
 * Wait until the camera holds still — the animation-complete wait specs used
 * as a fixed `waitForTimeout`. Polls `camera()` until the transform is
 * unchanged for `stableMs` (default 400ms, about what 30 held animation
 * frames meant), or throws after `timeout` (default 15s).
 */
export const cameraSettled = async (
  page: Page,
  options?: { readonly timeout?: number; readonly stableMs?: number },
): Promise<void> => {
  const timeout = options?.timeout ?? 15_000;
  const stableMs = options?.stableMs ?? 400;
  const deadline = Date.now() + timeout;
  let last: string | null = null;
  let stableSince = 0;
  while (Date.now() < deadline) {
    const cam = await camera(page).catch(() => null);
    const key = cam === null ? null : `${cam.x},${cam.y},${cam.zoom}`;
    if (key !== null && key === last) {
      if (stableSince === 0) stableSince = Date.now();
      if (Date.now() - stableSince >= stableMs) return;
    } else {
      stableSince = 0;
    }
    last = key;
    await page.waitForTimeout(90);
  }
  throw new Error(`canvas camera did not settle within ${timeout}ms`);
};

/** A card's connect handle on one side (`source` by default). */
export const handle = (
  page: Page,
  id: string,
  side: HandleSide,
  type: HandleType = "source",
): CanvasPart =>
  makePart(page, id, { kind: "handle", side, type }, `handle ${type}:${side} of card ${id}`);

/** A card's verb drop zone — the target end of a wire verb. */
export const verbZone = (page: Page, id: string, verb: string): CanvasPart =>
  makePart(page, id, { kind: "verbZone", verb }, `verb zone ${verb} of card ${id}`);

/** A region's drag handle (its title bar). */
export const regionHandle = (page: Page, id: string): CanvasPart =>
  makePart(page, id, { kind: "regionHandle" }, `region handle of ${id}`);

// --- viewport frame log -------------------------------------------------------
//
// Measurement probes (zz-zoom-smooth) sample the viewport transform once per
// animation frame. That is raw DOM observation, not a canvas fact the hook
// contract carries, so it lives here where the selectors may.

export interface CanvasViewportFrameLog {
  readonly t: number[];
  readonly moved: number[];
  readonly wheel: { readonly at: number[]; readonly stamp: number[] };
}

/** Start a per-frame log of the viewport transform and wheel arrivals. */
export const watchViewportFrames = (page: Page): Promise<void> =>
  page.evaluate((selector) => {
    const viewport = document.querySelector<HTMLElement>(selector);
    const hook = window.__juntoCanvas;
    if (viewport === null && hook === undefined) return;
    const log = { t: [] as number[], moved: [] as number[], wheel: { at: [] as number[], stamp: [] as number[] } };
    window.addEventListener("wheel", (event) => {
      log.wheel.at.push(performance.timeOrigin + performance.now());
      log.wheel.stamp.push(performance.timeOrigin + event.timeStamp);
    }, { capture: true, passive: true });
    // The DOM canvas moves its viewport transform; the GPU canvas moves the
    // camera the hook reports. Either way `now` is the frame's motion sample.
    const sample = (): string =>
      hook !== undefined
        ? JSON.stringify(hook.camera())
        : (viewport?.style.transform ?? "");
    let last = sample();
    const tick = (): void => {
      const now = sample();
      log.t.push(performance.timeOrigin + performance.now());
      log.moved.push(now === last ? 0 : 1);
      last = now;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    (window as unknown as { __juntoViewportLog?: typeof log }).__juntoViewportLog = log;
  }, CANVAS_DOM.viewport);

/** The log `watchViewportFrames` started. */
export const viewportFrameLog = (page: Page): Promise<CanvasViewportFrameLog> =>
  page.evaluate(() => {
    const log = (window as unknown as { __juntoViewportLog?: CanvasViewportFrameLog }).__juntoViewportLog;
    if (log === undefined) throw new Error("watchViewportFrames was never started");
    return log;
  });
