/**
 * ARIA wiring for a text field that drives a listbox (house `Combobox`,
 * `MentionCombobox`): which attributes the field, the list and each option
 * carry, from one state. Pure, so the semantics are tested without a tree.
 *
 * The laws it encodes:
 * - The field keeps DOM focus; the highlight is `aria-activedescendant`.
 * - An option's id comes from its key, never its index, so a list that
 *   refills under the same index never points the reader at another row.
 * - The field names no option and no list it is not showing.
 */

/** How the field completes: a list only, or a list plus inline ghost text. */
export type ListboxAutocomplete = "list" | "both";

/**
 * Where the list lives. `popup` opens and closes under the field (mentions);
 * `inline` is always on screen beside it (folder picker).
 */
export type ListboxPresentation = "popup" | "inline";

/**
 * What `aria-selected` means. `highlight`: the list has no committed choice,
 * so the highlighted row is the selected one (mention lists). `committed`:
 * the option the field's value already names (house Combobox).
 */
export type ListboxSelection =
  | { readonly kind: "highlight" }
  | { readonly kind: "committed"; readonly key: string | undefined };

export type ListboxAriaState = {
  readonly baseId: string;
  readonly presentation: ListboxPresentation;
  readonly autocomplete: ListboxAutocomplete;
  /** The list is on screen. Always true for `inline` unless a status replaces it. */
  readonly open: boolean;
  /** Keys of the options shown, in order. */
  readonly keys: readonly string[];
  readonly activeKey: string | undefined;
  readonly selection: ListboxSelection;
};

export type ComboboxFieldAria = {
  readonly role: "combobox";
  readonly "aria-autocomplete": ListboxAutocomplete;
  readonly "aria-haspopup"?: "listbox";
  readonly "aria-expanded": boolean;
  readonly "aria-controls": string | undefined;
  readonly "aria-activedescendant": string | undefined;
};

export type ListboxAria = {
  readonly id: string;
  readonly role: "listbox";
};

export type ListboxOptionAria = {
  readonly id: string;
  readonly role: "option";
  readonly "aria-selected": boolean;
};

export const listboxId = (baseId: string): string => `${baseId}-list`;

/**
 * Injective key to id-safe text: letters, digits and `-` pass through, every
 * other code unit becomes `_` plus four hex digits. Two keys never share an id.
 */
const idSafe = (key: string): string => {
  let out = "";
  for (let index = 0; index < key.length; index += 1) {
    const char = key[index] as string;
    out += /[A-Za-z0-9-]/.test(char)
      ? char
      : `_${key.charCodeAt(index).toString(16).padStart(4, "0")}`;
  }
  return out;
};

export const optionId = (baseId: string, key: string): string =>
  `${baseId}-opt-${idSafe(key)}`;

/** The active key, only while the list shows it. */
const shownActiveKey = (state: ListboxAriaState): string | undefined =>
  state.open && state.activeKey !== undefined && state.keys.includes(state.activeKey)
    ? state.activeKey
    : undefined;

export const comboboxFieldAria = (state: ListboxAriaState): ComboboxFieldAria => {
  const active = shownActiveKey(state);
  const expanded =
    state.presentation === "popup" ? state.open : state.open && state.keys.length > 0;
  return {
    role: "combobox",
    "aria-autocomplete": state.autocomplete,
    ...(state.presentation === "popup" ? { "aria-haspopup": "listbox" as const } : {}),
    "aria-expanded": expanded,
    "aria-controls": state.open ? listboxId(state.baseId) : undefined,
    "aria-activedescendant": active === undefined ? undefined : optionId(state.baseId, active),
  };
};

export const listboxAria = (state: Pick<ListboxAriaState, "baseId">): ListboxAria => ({
  id: listboxId(state.baseId),
  role: "listbox",
});

export const optionAria = (state: ListboxAriaState, key: string): ListboxOptionAria => {
  const selection = state.selection;
  let selected: boolean;
  switch (selection.kind) {
    case "highlight":
      selected = shownActiveKey(state) === key;
      break;
    case "committed":
      selected = selection.key === key;
      break;
  }
  return { id: optionId(state.baseId, key), role: "option", "aria-selected": selected };
};

/** Singular and plural nouns for the result count, e.g. seat and seats. */
export type ListboxNoun = { readonly one: string; readonly other: string };

/**
 * Text for a polite live region when the query changes: the count, or that
 * nothing matched. Empty while the list is closed, so a closed list is silent.
 */
export const listboxAnnouncement = ({
  open,
  count,
  noun,
}: {
  readonly open: boolean;
  readonly count: number;
  readonly noun: ListboxNoun;
}): string => {
  if (!open) return "";
  if (count === 0) return "No matches";
  return `${count} ${count === 1 ? noun.one : noun.other}`;
};
