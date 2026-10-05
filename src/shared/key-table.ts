/**
 * The key table: every keyboard shortcut in Junto, as data. The dispatcher
 * (renderer lib/key-dispatcher) resolves keydowns against it, and the help
 * and the shortcuts settings page read the same rows.
 *
 * Chords
 * - A chord is a string: modifiers in the order Cmd, Ctrl, Alt, Shift, then
 *   one key, joined by "+" ("Cmd+K", "Cmd+Shift+Backquote", "Slash").
 * - "Digit" stands for any of 1 to 9; the resolver says which.
 * - Digits and the backtick are read from the physical key, so layouts that
 *   need Shift for them still reach the chord. Everything else is read from
 *   the character the layout types.
 *
 * Where a shortcut is live
 * - canvas: the canvas has the keyboard, nothing is being typed.
 * - terminal: focus is in a terminal.
 * - field: focus is in any other field the operator types in.
 * - working: a working modal or Settings is open, focus is not in a field.
 * - operator: an operator modal (search, the needs-you feed) is open.
 *
 * Laws the resolver holds for every row
 * - A chord with no Cmd, Ctrl or Alt is a typed character: it never fires
 *   while the operator is typing, a terminal included.
 * - On macOS the app's chords are Cmd chords. Control belongs to the shell.
 * - Elsewhere there is no Cmd: today's Control chords are kept as they were.
 */

export type KeyContext = "canvas" | "terminal" | "field" | "working" | "operator";

export const KEY_CONTEXTS: ReadonlyArray<KeyContext> = [
  "canvas",
  "terminal",
  "field",
  "working",
  "operator",
];

const EVERYWHERE = KEY_CONTEXTS;
const NOT_TYPING: ReadonlyArray<KeyContext> = ["canvas", "working", "operator"];

export type ShortcutArea =
  | "Search and needs you"
  | "Command groups"
  | "Agents"
  | "Canvas";

export type ShortcutId =
  | "search.open"
  | "search.slash"
  | "feed.open"
  | "groups.assign"
  | "groups.recall"
  | "alerts.next"
  | "mirrors.next"
  | "mirrors.previous"
  | "canvas.undo"
  | "canvas.redo";

export type ShortcutDef = {
  readonly id: ShortcutId;
  readonly area: ShortcutArea;
  /** What it does, in product words. */
  readonly does: string;
  /** Default chords on macOS. */
  readonly mac: ReadonlyArray<string>;
  /** Default chords elsewhere. */
  readonly other: ReadonlyArray<string>;
  readonly where: ReadonlyArray<KeyContext>;
  /** Where it is live off macOS, when that differs. */
  readonly whereOther?: ReadonlyArray<KeyContext>;
};

export const KEY_TABLE: ReadonlyArray<ShortcutDef> = [
  {
    id: "search.open",
    area: "Search and needs you",
    does: "Open search, or close it when it is open",
    mac: ["Cmd+K"],
    other: ["Ctrl+K"],
    where: EVERYWHERE,
    // Ctrl+K in a shell kills to the end of the line.
    whereOther: ["canvas", "field", "working", "operator"],
  },
  {
    id: "search.slash",
    area: "Search and needs you",
    does: "Open search",
    mac: ["Slash"],
    other: ["Slash"],
    where: NOT_TYPING,
  },
  {
    id: "feed.open",
    area: "Search and needs you",
    does: "Open the needs-you feed, or close it when it is open",
    mac: ["Cmd+I"],
    other: ["Ctrl+I"],
    where: EVERYWHERE,
    whereOther: ["canvas", "field", "working", "operator"],
  },
  {
    id: "groups.assign",
    area: "Command groups",
    does: "Save the selection as command group 1 to 9",
    mac: ["Cmd+Digit"],
    other: ["Ctrl+Digit"],
    where: ["canvas"],
  },
  {
    id: "groups.recall",
    area: "Command groups",
    does: "Go to command group 1 to 9; press again to step through its agents",
    mac: ["Digit"],
    other: ["Digit"],
    where: ["canvas"],
  },
  {
    id: "alerts.next",
    area: "Agents",
    does: "Go to the next agent that raised an alert",
    mac: ["Space", "Backquote"],
    other: ["Space", "Backquote"],
    where: ["canvas", "working"],
  },
  {
    id: "mirrors.next",
    area: "Agents",
    does: "Go to the next connected agent terminal",
    mac: ["Cmd+BracketRight"],
    other: [],
    where: EVERYWHERE,
  },
  {
    id: "mirrors.previous",
    area: "Agents",
    does: "Go to the previous connected agent terminal",
    mac: ["Cmd+BracketLeft"],
    other: [],
    where: EVERYWHERE,
  },
  {
    id: "canvas.undo",
    area: "Canvas",
    does: "Undo the last canvas change",
    mac: ["Cmd+Z"],
    other: ["Ctrl+Z"],
    where: ["canvas", "working"],
  },
  {
    id: "canvas.redo",
    area: "Canvas",
    does: "Redo the canvas change that was undone",
    mac: ["Cmd+Shift+Z"],
    other: ["Ctrl+Shift+Z"],
    where: ["canvas", "working"],
  },
];

/**
 * Chords Junto never binds and a rebind must refuse: the system's, the
 * field's own editing keys, and the ones held back for later.
 */
export const RESERVED_CHORDS: ReadonlyArray<{ readonly chord: string; readonly why: string }> = [
  { chord: "Cmd+Q", why: "macOS quits the app" },
  { chord: "Cmd+H", why: "macOS hides the app" },
  { chord: "Cmd+M", why: "macOS minimizes the window" },
  { chord: "Cmd+Tab", why: "macOS switches apps" },
  { chord: "Cmd+Space", why: "macOS opens Spotlight" },
  { chord: "Cmd+C", why: "Copy" },
  { chord: "Cmd+V", why: "Paste" },
  { chord: "Cmd+X", why: "Cut" },
  { chord: "Cmd+A", why: "Select all" },
  { chord: "Cmd+O", why: "Held for a later Junto shortcut" },
  { chord: "Cmd+P", why: "Held for a later Junto shortcut" },
];

// --- chords ------------------------------------------------------------------

export type KeyEventLike = {
  readonly key: string;
  readonly code?: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
};

const DIGIT_CODE = /^(?:Digit|Numpad)([1-9])$/;

const NAMED_KEYS: Readonly<Record<string, string>> = {
  " ": "Space",
  Spacebar: "Space",
  "/": "Slash",
  "[": "BracketLeft",
  "]": "BracketRight",
  "`": "Backquote",
};

// Characters some layouts only reach with Shift: Shift is not part of them.
const SHIFT_BLIND = new Set(["Slash"]);

const MODIFIER_KEYS = new Set(["Meta", "Control", "Alt", "Shift", "CapsLock", "Fn"]);

/** The digit (1 to 9) a keydown names, from the physical key, or null. */
export const digitOfKey = (event: Pick<KeyEventLike, "key" | "code">): number | null => {
  const fromCode = event.code ? DIGIT_CODE.exec(event.code) : null;
  if (fromCode) return Number(fromCode[1]);
  // No physical code (synthetic events): fall back to the character.
  if (!event.code && event.key.length === 1 && event.key >= "1" && event.key <= "9") {
    return Number(event.key);
  }
  return null;
};

const keyNameOf = (event: Pick<KeyEventLike, "key" | "code">): string | null => {
  if (MODIFIER_KEYS.has(event.key)) return null;
  const digit = digitOfKey(event);
  if (digit !== null) return String(digit);
  if (event.code === "Backquote") return "Backquote";
  if (event.code === "Space") return "Space";
  const named = NAMED_KEYS[event.key];
  if (named) return named;
  return event.key.length === 1 ? event.key.toUpperCase() : event.key;
};

/** The chord a keydown is, or null for a modifier pressed alone. */
export const chordOfKey = (event: KeyEventLike): string | null => {
  const name = keyNameOf(event);
  if (name === null) return null;
  const parts: string[] = [];
  if (event.metaKey) parts.push("Cmd");
  if (event.ctrlKey) parts.push("Ctrl");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey && !SHIFT_BLIND.has(name)) parts.push("Shift");
  parts.push(name);
  return parts.join("+");
};

/** True when the chord would type a character: no Cmd, Ctrl or Alt in it. */
export const isBareChord = (chord: string): boolean =>
  !chord
    .split("+")
    .slice(0, -1)
    .some((part) => part === "Cmd" || part === "Ctrl" || part === "Alt");

const digitFamily = (chord: string): string | null => {
  const at = chord.lastIndexOf("+");
  const key = chord.slice(at + 1);
  return key.length === 1 && key >= "1" && key <= "9" ? `${chord.slice(0, at + 1)}Digit` : null;
};

// --- resolve -----------------------------------------------------------------

export type KeyOverrides = Readonly<Partial<Record<ShortcutId, ReadonlyArray<string>>>>;

/** The chords a shortcut answers to here: the operator's own, else the default. */
export const chordsFor = (
  def: ShortcutDef,
  mac: boolean,
  overrides: KeyOverrides = {},
): ReadonlyArray<string> => overrides[def.id] ?? (mac ? def.mac : def.other);

const liveIn = (def: ShortcutDef, mac: boolean): ReadonlyArray<KeyContext> =>
  mac ? def.where : (def.whereOther ?? def.where);

export type KeySituation = {
  readonly mac: boolean;
  readonly context: KeyContext;
  /** Focus is in a field the operator types in (terminals included). */
  readonly typing: boolean;
};

export type KeyHit = {
  readonly id: ShortcutId;
  /** 1 to 9, for a chord written with "Digit". */
  readonly digit?: number;
};

/** The shortcut a chord means in this situation, or null when it is not ours. */
export const resolveChord = (
  chord: string,
  situation: KeySituation,
  overrides: KeyOverrides = {},
  table: ReadonlyArray<ShortcutDef> = KEY_TABLE,
): KeyHit | null => {
  if (situation.typing && isBareChord(chord)) return null;
  const family = digitFamily(chord);
  for (const def of table) {
    if (!liveIn(def, situation.mac).includes(situation.context)) continue;
    const chords = chordsFor(def, situation.mac, overrides);
    if (chords.includes(chord)) return { id: def.id };
    if (family !== null && chords.includes(family)) {
      return { id: def.id, digit: Number(chord.slice(chord.lastIndexOf("+") + 1)) };
    }
  }
  return null;
};

/** The shortcut a keydown means in this situation, or null. */
export const resolveKey = (
  event: KeyEventLike,
  situation: KeySituation,
  overrides: KeyOverrides = {},
  table: ReadonlyArray<ShortcutDef> = KEY_TABLE,
): KeyHit | null => {
  const chord = chordOfKey(event);
  return chord === null ? null : resolveChord(chord, situation, overrides, table);
};

// --- conflicts ---------------------------------------------------------------

export type KeyConflict = {
  readonly chord: string;
  readonly context: KeyContext;
  readonly ids: readonly [ShortcutId, ShortcutId];
};

const covers = (a: string, b: string): boolean => a === b || digitFamily(b) === a || digitFamily(a) === b;

/** Two shortcuts that would answer the same chord in the same place. */
export const keyConflicts = (
  mac: boolean,
  overrides: KeyOverrides = {},
  table: ReadonlyArray<ShortcutDef> = KEY_TABLE,
): KeyConflict[] => {
  const out: KeyConflict[] = [];
  table.forEach((a, index) => {
    for (const b of table.slice(index + 1)) {
      const shared = liveIn(a, mac).filter((context) => liveIn(b, mac).includes(context));
      if (shared.length === 0) continue;
      for (const chord of chordsFor(a, mac, overrides)) {
        if (!chordsFor(b, mac, overrides).some((other) => covers(chord, other))) continue;
        for (const context of shared) out.push({ chord, context, ids: [a.id, b.id] });
      }
    }
  });
  return out;
};

/** Why a chord cannot be bound, or null when it is free to bind. */
export const reservedReason = (chord: string, mac: boolean): string | null => {
  const held = RESERVED_CHORDS.find((entry) => entry.chord === chord);
  if (held) return held.why;
  if (mac && /(?:^|\+)Ctrl\+/.test(chord)) return "Control belongs to the terminal";
  return null;
};

// --- display -----------------------------------------------------------------

const MAC_GLYPH: Readonly<Record<string, string>> = { Cmd: "⌘", Ctrl: "⌃", Alt: "⌥", Shift: "⇧" };

const KEY_LABEL: Readonly<Record<string, string>> = {
  Backquote: "`",
  Slash: "/",
  BracketLeft: "[",
  BracketRight: "]",
  Digit: "1 to 9",
  Enter: "↵",
  Escape: "Esc",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
};

/** A chord as the key caps to show, in order. */
export const chordKeyCaps = (chord: string, mac: boolean): string[] =>
  chord.split("+").map((part) => (mac ? MAC_GLYPH[part] : undefined) ?? KEY_LABEL[part] ?? part);
