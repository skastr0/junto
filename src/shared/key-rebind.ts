/**
 * Changing a shortcut's chord: what a newly pressed chord means for the
 * stored overrides. Pure; the shortcuts page shows the verdict and writes
 * the overrides it carries.
 */
import {
  KEY_TABLE,
  chordsFor,
  chordsOverlap,
  isBareChord,
  keyConflicts,
  reservedReason,
  type KeyOverrides,
  type ShortcutDef,
  type ShortcutId,
} from "./key-table";

export type RebindVerdict =
  /** Free to use: these are the overrides to store. */
  | { readonly kind: "ok"; readonly overrides: KeyOverrides }
  /** Not allowed, and why in a few words. Nothing is stored. */
  | { readonly kind: "refused"; readonly why: string }
  /** Another shortcut answers it in the same place; storing these leaves that one with no key. */
  | { readonly kind: "taken"; readonly by: ShortcutId; readonly overrides: KeyOverrides };

const sameChords = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean =>
  a.length === b.length && a.every((chord, index) => chord === b[index]);

const defaultsOf = (def: ShortcutDef, mac: boolean): ReadonlyArray<string> => (mac ? def.mac : def.other);

/** Overrides with this shortcut on `chords`; a shortcut on its defaults stores nothing. */
const withChords = (
  overrides: KeyOverrides,
  def: ShortcutDef,
  chords: ReadonlyArray<string>,
  mac: boolean,
): KeyOverrides => {
  const { [def.id]: _own, ...rest } = overrides;
  return sameChords(chords, defaultsOf(def, mac)) ? rest : { ...rest, [def.id]: chords };
};

// A row written with "Digit" answers the whole digit row: a pressed digit
// stands for all nine.
const asWritten = (def: ShortcutDef, chord: string, mac: boolean): string => {
  const usesDigits = defaultsOf(def, mac).some((own) => own.endsWith("Digit"));
  return usesDigits ? chord.replace(/(^|\+)[1-9]$/, "$1Digit") : chord;
};

const typedWhere = (def: ShortcutDef, mac: boolean): boolean =>
  (mac ? def.where : (def.whereOther ?? def.where)).some(
    (context) => context === "terminal" || context === "field",
  );

/** What pressing `pressed` means while recording a new chord for `id`. */
export const proposeRebind = (
  id: ShortcutId,
  pressed: string,
  mac: boolean,
  overrides: KeyOverrides = {},
  table: ReadonlyArray<ShortcutDef> = KEY_TABLE,
): RebindVerdict => {
  const def = table.find((row) => row.id === id);
  if (!def) return { kind: "refused", why: "Unknown shortcut" };
  if (def.fixed !== undefined) return { kind: "refused", why: def.fixed };
  const chord = asWritten(def, pressed, mac);
  const reserved = reservedReason(chord, mac);
  if (reserved !== null) return { kind: "refused", why: reserved };
  if (def.needsCmd && !chord.split("+").slice(0, -1).includes("Cmd")) {
    return { kind: "refused", why: "Needs Cmd: letting Cmd go opens the agent" };
  }
  if (isBareChord(chord) && typedWhere(def, mac)) {
    return { kind: "refused", why: "A key without Cmd would be typed into the terminal" };
  }
  const next = withChords(overrides, def, [chord], mac);
  const clash = keyConflicts(mac, next, table).find((conflict) => conflict.ids.includes(id));
  if (!clash) return { kind: "ok", overrides: next };
  const by = clash.ids[0] === id ? clash.ids[1] : clash.ids[0];
  const other = table.find((row) => row.id === by)!;
  if (other.fixed !== undefined) return { kind: "refused", why: `Used by ${other.does.toLowerCase()}` };
  // Replacing takes the chord from the other shortcut and leaves its others.
  const left = chordsFor(other, mac, next).filter((own) => !chordsOverlap(own, chord));
  return { kind: "taken", by, overrides: withChords(next, other, left, mac) };
};

/** Overrides with this shortcut cleared to no key at all. */
export const clearChords = (
  id: ShortcutId,
  mac: boolean,
  overrides: KeyOverrides = {},
  table: ReadonlyArray<ShortcutDef> = KEY_TABLE,
): KeyOverrides => {
  const def = table.find((row) => row.id === id);
  return def && def.fixed === undefined ? withChords(overrides, def, [], mac) : overrides;
};

/** Overrides with this shortcut back on its default. */
export const resetChords = (id: ShortcutId, overrides: KeyOverrides = {}): KeyOverrides => {
  const { [id]: _own, ...rest } = overrides;
  return rest;
};

/** True when the operator changed this shortcut. */
export const isRebound = (id: ShortcutId, overrides: KeyOverrides = {}): boolean => overrides[id] !== undefined;
