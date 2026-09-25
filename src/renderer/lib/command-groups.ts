/**
 * Command groups: the operator's RTS control groups on hotbar slots 1 to 9.
 * Pure contract; RtsBottomBar (keys, chips), the multi-select menu, and the
 * canvas switch in App wire it.
 *
 * Keys
 * - Save is the platform modifier plus a digit: ⌘ on macOS, Ctrl elsewhere.
 *   The other modifier, Alt, Shift, and auto-repeat never act.
 * - Recall is a bare digit. Auto-repeat never acts, so holding a digit does
 *   not count as a re-tap.
 * - The physical digit row decides (`event.code`), so layouts that need Shift
 *   for digits still reach slots 1 to 9. The numpad counts too.
 *
 * Save
 * - The live selection goes to the slot, replacing whatever it held (empty,
 *   lease, soft-hold, fixed node, group).
 * - One node → `fixed`; that node leaves every other single-node slot.
 * - Two or more → `group`, members in document order. Groups may overlap
 *   each other and single-node slots, like RTS control groups.
 * - An empty selection (or one with no live node) saves nothing.
 *
 * Recall
 * - Group → select every live member and frame them together.
 * - Region or node → select it and frame it.
 * - Re-tap: the same slot, holding the same content, pressed again within
 *   REGION_RETAP_GAP_MS. Groups and regions cycle their members in document
 *   order and open each; a single node opens.
 * - An empty slot does nothing.
 *
 * Lifetime
 * - Deleted nodes leave every slot; a group empties when its last member goes.
 * - Operator slots (fixed, group) are remembered per canvas for the session;
 *   leases are recomputed from activity after a switch.
 */
import {
  HOTBAR_SLOT_COUNT,
  assignFixedSlot,
  emptyHotbarSlots,
  isOperatorSlot,
  slotMemberIds,
  type HotbarSlot,
} from "./hotbar-slots";
import {
  REGION_RETAP_GAP_MS,
  membersInDocumentOrder,
  regionDigitVerdict,
} from "./region-retap";

// --- keys --------------------------------------------------------------------

export type CommandGroupKeyEvent = {
  readonly key: string;
  readonly code?: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly repeat?: boolean;
};

export type CommandGroupKey =
  | { readonly kind: "save"; readonly slotIndex: number }
  | { readonly kind: "recall"; readonly slotIndex: number };

const DIGIT_CODE = /^(?:Digit|Numpad)([1-9])$/;

/** Slot index (0 to 8) for the physical digit, or null. */
export const slotIndexForKey = (event: Pick<CommandGroupKeyEvent, "key" | "code">): number | null => {
  const fromCode = event.code ? DIGIT_CODE.exec(event.code) : null;
  if (fromCode) return Number(fromCode[1]) - 1;
  // No physical code (synthetic events): fall back to the character.
  if (!event.code && event.key.length === 1 && event.key >= "1" && event.key <= "9") {
    return Number(event.key) - 1;
  }
  return null;
};

/** What a keydown means for command groups, or null when it is not ours. */
export const commandGroupKey = (
  event: CommandGroupKeyEvent,
  mac: boolean,
): CommandGroupKey | null => {
  if (event.repeat || event.altKey || event.shiftKey) return null;
  const slotIndex = slotIndexForKey(event);
  if (slotIndex === null) return null;
  const primary = mac ? event.metaKey : event.ctrlKey;
  const other = mac ? event.ctrlKey : event.metaKey;
  if (other) return null;
  return primary ? { kind: "save", slotIndex } : { kind: "recall", slotIndex };
};

// --- selection ---------------------------------------------------------------

/**
 * The live node selection. The multi set is authoritative only while the
 * single channel is empty or inside it (a later single write wins).
 */
export const currentSelectionIds = (
  selectedNodeId: string,
  selectedNodeIds: ReadonlyArray<string>,
): string[] => {
  if (
    selectedNodeIds.length > 1 &&
    (selectedNodeId === "" || selectedNodeIds.includes(selectedNodeId))
  ) {
    return [...new Set(selectedNodeIds)];
  }
  const single =
    selectedNodeId || (selectedNodeIds.length === 1 ? (selectedNodeIds[0] ?? "") : "");
  return single ? [single] : [];
};

// --- save --------------------------------------------------------------------

/**
 * Save `selectedIds` to `slotIndex`. Returns the next board, or null when the
 * selection holds no live node (nothing is saved and nothing changes).
 */
export const saveSelectionToSlot = (
  slots: ReadonlyArray<HotbarSlot>,
  selectedIds: ReadonlyArray<string>,
  slotIndex: number,
  documentNodeIds: ReadonlyArray<string>,
): HotbarSlot[] | null => {
  if (!isSlotIndex(slotIndex)) return null;
  const members = membersInDocumentOrder(selectedIds, documentNodeIds);
  if (members.length === 0) return null;
  if (members.length === 1) return assignFixedSlot(slots, members[0]!, slotIndex);
  const next = boardOf(slots);
  next[slotIndex] = { kind: "group", nodeIds: members };
  return next;
};

/** Swap two slots whole (chip drag). Out-of-range or same index: unchanged copy. */
export const swapHotbarSlots = (
  slots: ReadonlyArray<HotbarSlot>,
  from: number,
  to: number,
): HotbarSlot[] => {
  const next = boardOf(slots);
  if (!isSlotIndex(from) || !isSlotIndex(to) || from === to) return next;
  const moving = next[from]!;
  next[from] = next[to]!;
  next[to] = moving;
  return next;
};

/**
 * Where "assign to a free slot" lands: empty first, then an idle soft-hold,
 * then an active lease. Never an operator slot; null when all nine are.
 */
export const firstFreeSlotIndex = (slots: ReadonlyArray<HotbarSlot>): number | null => {
  const board = boardOf(slots);
  for (const kind of ["empty", "evicted", "leased"] as const) {
    const index = board.findIndex((slot) => slot.kind === kind);
    if (index >= 0) return index;
  }
  return null;
};

// --- recall ------------------------------------------------------------------

export type CommandGroupRetap = {
  readonly slotIndex: number;
  /** Content fingerprint; a re-tap only counts against the same content. */
  readonly key: string;
  readonly atMs: number;
  /** Member index after the last press; -1 = the slot itself was recalled. */
  readonly memberCursor: number;
};

export type RecallStep =
  | { readonly kind: "none" }
  | { readonly kind: "focus"; readonly nodeId: string }
  | { readonly kind: "frame-group"; readonly nodeIds: ReadonlyArray<string> }
  | { readonly kind: "open"; readonly nodeId: string };

export type RecallContext = {
  readonly documentNodeIds: ReadonlyArray<string>;
  /** Region node ids. */
  readonly regionIds: ReadonlySet<string>;
  /** Members of a region, any order. */
  readonly regionMembers: (regionId: string) => ReadonlyArray<string>;
};

/** Stable fingerprint of a slot's content ("" for empty). */
export const slotContentKey = (slot: HotbarSlot | undefined): string => {
  if (!slot || slot.kind === "empty") return "";
  return slot.kind === "group" ? `group:${slot.nodeIds.join(",")}` : `node:${slot.nodeId}`;
};

/** Decide what a bare digit does and the re-tap memory it leaves. */
export const recallCommandGroup = (
  slots: ReadonlyArray<HotbarSlot>,
  slotIndex: number,
  context: RecallContext,
  memory: CommandGroupRetap | null,
  nowMs: number,
  gapMs: number = REGION_RETAP_GAP_MS,
): { readonly step: RecallStep; readonly memory: CommandGroupRetap | null } => {
  const slot = slots[slotIndex];
  const key = slotContentKey(slot);
  if (!slot || !key) return { step: { kind: "none" }, memory: null };
  const live = new Set(context.documentNodeIds);
  const sameContent = memory !== null && memory.key === key ? memory : null;

  const cycle = (anchor: RecallStep, members: ReadonlyArray<string>) => {
    const { verdict, memory: next } = regionDigitVerdict(
      sameContent,
      slotIndex,
      nowMs,
      members.length,
      gapMs,
    );
    const step: RecallStep =
      verdict.kind === "select-member" && members[verdict.index]
        ? { kind: "open", nodeId: members[verdict.index]! }
        : anchor;
    return { step, memory: { ...next, key } };
  };

  if (slot.kind === "group") {
    const members = membersInDocumentOrder(slot.nodeIds, context.documentNodeIds);
    if (members.length === 0) return { step: { kind: "none" }, memory: null };
    return cycle({ kind: "frame-group", nodeIds: members }, members);
  }

  const nodeId = slotMemberIds(slot)[0]!;
  if (!live.has(nodeId)) return { step: { kind: "none" }, memory: null };
  if (context.regionIds.has(nodeId)) {
    const members = membersInDocumentOrder(
      context.regionMembers(nodeId),
      context.documentNodeIds,
    );
    return cycle({ kind: "focus", nodeId }, members);
  }

  const within =
    sameContent !== null &&
    sameContent.slotIndex === slotIndex &&
    nowMs - sameContent.atMs <= gapMs;
  return {
    step: within ? { kind: "open", nodeId } : { kind: "focus", nodeId },
    memory: { slotIndex, key, atMs: nowMs, memberCursor: -1 },
  };
};

// --- presentation ------------------------------------------------------------

export type SlotSummary = {
  readonly index: number;
  readonly taken: boolean;
  /** Operator-held (fixed or group); leases and soft-holds yield. */
  readonly held: boolean;
  readonly count: number;
  /** Short chip label: a title, or "first +N" for groups. "" when empty. */
  readonly label: string;
  /** Every member title, comma separated, for tooltips and menus. */
  readonly detail: string;
};

/** One line per slot for chips and the save-to-group picker. */
export const summarizeSlots = (
  slots: ReadonlyArray<HotbarSlot>,
  titleOf: (nodeId: string) => string,
): SlotSummary[] =>
  boardOf(slots).map((slot, index) => {
    const members = slotMemberIds(slot);
    const titles = members.map(titleOf);
    return {
      index,
      taken: members.length > 0,
      held: isOperatorSlot(slot),
      count: members.length,
      label: groupLabel(titles),
      detail: titles.join(", "),
    };
  });

/** "Scout" for one, "Scout +2" for three, "" for none. */
export const groupLabel = (titles: ReadonlyArray<string>): string => {
  if (titles.length === 0) return "";
  const first = titles[0] ?? "";
  return titles.length === 1 ? first : `${first} +${titles.length - 1}`;
};

/** True when the live selection is exactly the group's members. */
export const selectionIsGroup = (
  selectedIds: ReadonlyArray<string>,
  slot: HotbarSlot | undefined,
): boolean => {
  if (!slot || slot.kind !== "group") return false;
  const selected = new Set(selectedIds);
  return selected.size === slot.nodeIds.length && slot.nodeIds.every((id) => selected.has(id));
};

// --- per-canvas memory -------------------------------------------------------

/** Leases and soft-holds are derived from activity, so only operator slots carry over. */
export const operatorHeldSlots = (slots: ReadonlyArray<HotbarSlot>): HotbarSlot[] =>
  boardOf(slots).map((slot) => (isOperatorSlot(slot) ? slot : { kind: "empty" }));

export type CanvasCommandGroups = {
  readonly remember: (canvasName: string, slots: ReadonlyArray<HotbarSlot>) => void;
  /** The canvas's remembered operator slots, or an empty board. */
  readonly recall: (canvasName: string) => HotbarSlot[];
};

/** Session memory of operator slots per canvas name. Never written to disk. */
export const makeCanvasCommandGroups = (): CanvasCommandGroups => {
  const byCanvas = new Map<string, HotbarSlot[]>();
  return {
    remember: (canvasName, slots) => {
      if (!canvasName) return;
      byCanvas.set(canvasName, operatorHeldSlots(slots));
    },
    recall: (canvasName) => {
      const remembered = canvasName ? byCanvas.get(canvasName) : undefined;
      return remembered ? boardOf(remembered) : emptyHotbarSlots();
    },
  };
};

/** The app's one session memory (App restores it on canvas switch). */
export const canvasCommandGroups = makeCanvasCommandGroups();

// --- internals ---------------------------------------------------------------

const isSlotIndex = (index: number): boolean =>
  Number.isInteger(index) && index >= 0 && index < HOTBAR_SLOT_COUNT;

const boardOf = (slots: ReadonlyArray<HotbarSlot>): HotbarSlot[] => {
  const next = slots.slice(0, HOTBAR_SLOT_COUNT);
  while (next.length < HOTBAR_SLOT_COUNT) next.push({ kind: "empty" });
  return next;
};
