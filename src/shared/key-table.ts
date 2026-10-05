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
 * - switcher: the urgency switcher is up, which means Cmd is being held.
 *
 * Laws the resolver holds for every row
 * - A chord with no Cmd, Ctrl or Alt is a typed character: it never fires
 *   while the operator is typing, a terminal included.
 * - On macOS the app's chords are Cmd chords. Control belongs to the shell.
 * - Elsewhere there is no Cmd: today's Control chords are kept as they were.
 */

export type KeyContext = "canvas" | "terminal" | "field" | "working" | "operator" | "switcher";

export const KEY_CONTEXTS: ReadonlyArray<KeyContext> = [
  "canvas",
  "terminal",
  "field",
  "working",
  "operator",
  "switcher",
];

// The switcher is not part of "everywhere": while it is up, its own rows
// decide what each key means.
const EVERYWHERE: ReadonlyArray<KeyContext> = ["canvas", "terminal", "field", "working", "operator"];
const NOT_TYPING: ReadonlyArray<KeyContext> = ["canvas", "working", "operator"];

/** Where the shortcuts page lists a shortcut: by where its chord works. */
export type ShortcutArea = "Anywhere" | "Search and feed" | "Canvas" | "Agent and terminal";

export const SHORTCUT_AREAS: ReadonlyArray<ShortcutArea> = [
  "Anywhere",
  "Search and feed",
  "Canvas",
  "Agent and terminal",
];

export type ShortcutId =
  | "search.open"
  | "search.slash"
  | "feed.open"
  | "groups.assign"
  | "groups.recall"
  | "groups.jump"
  | "alerts.next"
  | "git.review"
  | "urgency.next"
  | "urgency.previous"
  | "switcher.next"
  | "switcher.previous"
  | "switcher.commit"
  | "switcher.cancel"
  | "mirrors.next"
  | "mirrors.previous"
  | "canvas.undo"
  | "canvas.redo"
  | "canvas.zoomIn"
  | "canvas.zoomOut"
  | "canvas.zoomReset"
  | "front.close";

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
  /** Acts again on every auto-repeat while the chord is held. */
  readonly repeats?: true;
  /** Also runs when this modifier is let go. */
  readonly onRelease?: "Cmd";
  /** Its chord must hold Cmd: letting Cmd go is what opens the chosen agent. */
  readonly needsCmd?: true;
  /** Why the chord cannot be changed, in a few words. Absent: it can. */
  readonly fixed?: string;
};

export const KEY_TABLE: ReadonlyArray<ShortcutDef> = [
  {
    id: "search.open",
    area: "Search and feed",
    does: "Open search, or close it when it is open",
    mac: ["Cmd+K"],
    other: ["Ctrl+K"],
    where: EVERYWHERE,
    // Ctrl+K in a shell kills to the end of the line.
    whereOther: ["canvas", "field", "working", "operator"],
  },
  {
    id: "search.slash",
    area: "Search and feed",
    does: "Open search",
    mac: ["Slash"],
    other: ["Slash"],
    where: NOT_TYPING,
  },
  {
    id: "feed.open",
    area: "Search and feed",
    does: "Open the needs-you feed, or close it when it is open",
    mac: ["Cmd+I"],
    other: ["Ctrl+I"],
    where: EVERYWHERE,
    whereOther: ["canvas", "field", "working", "operator"],
  },
  {
    id: "groups.assign",
    area: "Canvas",
    does: "Save the selection as command group 1 to 9",
    mac: ["Cmd+Digit"],
    other: ["Ctrl+Digit"],
    where: ["canvas"],
  },
  {
    id: "groups.recall",
    area: "Canvas",
    does: "Go to command group 1 to 9; press again to step through its agents",
    mac: ["Digit"],
    other: ["Digit"],
    where: ["canvas"],
  },
  {
    id: "groups.jump",
    area: "Agent and terminal",
    does: "Jump to command group 1 to 9; press again for its next agent",
    mac: ["Cmd+Digit"],
    // Off macOS there is no Cmd, and Ctrl plus a digit is the shell's.
    other: [],
    where: ["terminal", "field", "working"],
  },
  {
    id: "alerts.next",
    area: "Canvas",
    does: "Go to the next agent that raised an alert",
    mac: ["Space", "Backquote"],
    other: ["Space", "Backquote"],
    where: ["canvas", "working"],
  },
  {
    id: "urgency.next",
    area: "Anywhere",
    does: "Step to the agent that most needs you: hold Cmd, tap to step, let go to open it",
    mac: ["Cmd+Backquote"],
    other: [],
    where: ["canvas", "terminal", "field", "working", "switcher"],
    repeats: true,
    needsCmd: true,
  },
  {
    id: "urgency.previous",
    area: "Anywhere",
    does: "Step back through the agents that need you",
    mac: ["Cmd+Shift+Backquote"],
    other: [],
    where: ["canvas", "terminal", "field", "working", "switcher"],
    repeats: true,
    needsCmd: true,
  },
  // While the switcher is up Cmd is held, so its keys are Cmd chords.
  {
    id: "switcher.next",
    area: "Agent and terminal",
    does: "In the switcher, move to the next agent",
    mac: ["Cmd+ArrowDown", "Cmd+ArrowRight", "Cmd+J", "Cmd+L"],
    other: [],
    where: ["switcher"],
    fixed: "Cmd is held while the switcher is up",
    repeats: true,
  },
  {
    id: "switcher.previous",
    area: "Agent and terminal",
    does: "In the switcher, move to the previous agent",
    mac: ["Cmd+ArrowUp", "Cmd+ArrowLeft", "Cmd+K", "Cmd+H"],
    other: [],
    where: ["switcher"],
    fixed: "Cmd is held while the switcher is up",
    repeats: true,
  },
  {
    id: "switcher.commit",
    area: "Agent and terminal",
    does: "In the switcher, open the chosen agent",
    mac: ["Cmd+Enter"],
    other: [],
    where: ["switcher"],
    fixed: "Cmd is held while the switcher is up",
    onRelease: "Cmd",
  },
  {
    id: "switcher.cancel",
    area: "Agent and terminal",
    does: "In the switcher, close it and stay where you were",
    mac: ["Cmd+Escape"],
    other: [],
    where: ["switcher"],
    fixed: "Cmd is held while the switcher is up",
  },
  {
    id: "git.review",
    area: "Agent and terminal",
    does: "Open the git review for the agent in front, or close it",
    mac: ["Cmd+G"],
    other: [],
    where: ["terminal", "field", "working"],
  },
  {
    id: "mirrors.next",
    area: "Anywhere",
    does: "Go to the next connected agent terminal",
    mac: ["Cmd+BracketRight"],
    other: [],
    where: EVERYWHERE,
  },
  {
    id: "mirrors.previous",
    area: "Anywhere",
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
  // Zoom moves the canvas camera, never the size of the whole interface.
  {
    id: "canvas.zoomIn",
    area: "Canvas",
    does: "Zoom the canvas in",
    mac: ["Cmd+Equal", "Cmd+Plus"],
    other: [],
    where: ["canvas"],
  },
  {
    id: "canvas.zoomOut",
    area: "Canvas",
    does: "Zoom the canvas out",
    mac: ["Cmd+Minus"],
    other: [],
    where: ["canvas"],
  },
  {
    id: "canvas.zoomReset",
    area: "Canvas",
    does: "Show the canvas at 100 percent",
    mac: ["Cmd+0"],
    other: [],
    where: ["canvas"],
  },
  {
    id: "front.close",
    area: "Anywhere",
    does: "Close what is in front, one layer at a time; with nothing open, close the window",
    mac: ["Cmd+W"],
    // Ctrl+W deletes a word in the shell.
    other: [],
    where: EVERYWHERE,
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
  "=": "Equal",
  "+": "Plus",
  "-": "Minus",
};

// Characters some layouts only reach with Shift: Shift is not part of them.
const SHIFT_BLIND = new Set(["Slash", "Plus"]);

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

export type KeyOverrides = Readonly<Record<string, ReadonlyArray<string>>>;

/**
 * The chords a shortcut answers to here: the operator's own, else the
 * default. A stored chord the system or the terminal owns is never answered,
 * whatever wrote it.
 */
export const chordsFor = (
  def: ShortcutDef,
  mac: boolean,
  overrides: KeyOverrides = {},
): ReadonlyArray<string> => {
  const own = def.fixed === undefined ? overrides[def.id] : undefined;
  return own ? own.filter((chord) => reservedReason(chord, mac) === null) : mac ? def.mac : def.other;
};

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

/** The shortcut that runs when a held modifier is let go here, or null. */
export const resolveRelease = (
  modifier: "Cmd",
  situation: KeySituation,
  table: ReadonlyArray<ShortcutDef> = KEY_TABLE,
): KeyHit | null => {
  const def = table.find(
    (row) => row.onRelease === modifier && liveIn(row, situation.mac).includes(situation.context),
  );
  return def ? { id: def.id } : null;
};

/** True when the shortcut acts again on auto-repeat. */
export const shortcutRepeats = (
  id: ShortcutId,
  table: ReadonlyArray<ShortcutDef> = KEY_TABLE,
): boolean => table.find((row) => row.id === id)?.repeats === true;

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

/** Two chords one keydown could mean: the same, or a digit and the digit row. */
export const chordsOverlap = (a: string, b: string): boolean =>
  a === b || digitFamily(b) === a || digitFamily(a) === b;

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
        if (!chordsFor(b, mac, overrides).some((other) => chordsOverlap(chord, other))) continue;
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

// --- the app menu ------------------------------------------------------------

const MENU_KEY: Readonly<Record<string, string>> = {
  Backquote: "`",
  Slash: "/",
  BracketLeft: "[",
  BracketRight: "]",
  Equal: "=",
  Minus: "-",
};

const MENU_MODIFIER = { Cmd: "meta", Ctrl: "control", Alt: "alt", Shift: "shift" } as const;

export type MenuKey = {
  /** The chord as an Electron accelerator. */
  readonly accelerator: string;
  /** The same chord as an input event, to hand it to the page. */
  readonly keyCode: string;
  readonly modifiers: ReadonlyArray<(typeof MENU_MODIFIER)[keyof typeof MENU_MODIFIER]>;
};

/** A chord as the macOS menu bar writes and sends it; null for a digit row. */
export const menuKeyOf = (chord: string): MenuKey | null => {
  const parts = chord.split("+");
  const name = parts[parts.length - 1]!;
  if (name === "Digit") return null;
  const key = MENU_KEY[name] ?? name;
  const held = parts.slice(0, -1) as ReadonlyArray<keyof typeof MENU_MODIFIER>;
  return {
    accelerator: [...held, key].join("+"),
    keyCode: key.length === 1 ? key.toLowerCase() : key,
    modifiers: held.map((part) => MENU_MODIFIER[part]),
  };
};

// --- display -----------------------------------------------------------------

const MAC_GLYPH: Readonly<Record<string, string>> = { Cmd: "⌘", Ctrl: "⌃", Alt: "⌥", Shift: "⇧" };

const KEY_LABEL: Readonly<Record<string, string>> = {
  Backquote: "`",
  Slash: "/",
  BracketLeft: "[",
  BracketRight: "]",
  Equal: "=",
  Plus: "+",
  Minus: "-",
  Digit: "1 to 9",
  Enter: "↵",
  Escape: "Esc",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
};

const KEY_SPOKEN: Readonly<Record<string, string>> = {
  Backquote: "backtick",
  Slash: "slash",
  BracketLeft: "left bracket",
  BracketRight: "right bracket",
  Equal: "equals",
  Plus: "plus",
  Minus: "minus",
  Digit: "1 to 9",
  ArrowUp: "up arrow",
  ArrowDown: "down arrow",
  ArrowLeft: "left arrow",
  ArrowRight: "right arrow",
};

/** A chord said aloud: "Command Shift K". */
export const chordSpoken = (chord: string): string =>
  chord
    .split("+")
    .map((part) => (part === "Cmd" ? "Command" : part === "Ctrl" ? "Control" : part === "Alt" ? "Option" : KEY_SPOKEN[part] ?? part))
    .join(" ");

/** A chord as the key caps to show, in order. */
export const chordKeyCaps = (chord: string, mac: boolean): string[] =>
  chord.split("+").map((part) => (mac ? MAC_GLYPH[part] : undefined) ?? KEY_LABEL[part] ?? part);
