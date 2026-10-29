/**
 * The text an action writes (plan 0.11/05): multi-line where it is prose, and
 * the values its trigger carries one press away. Insert value writes
 * `{{name}}` where the caret is and leaves the caret after it, so the operator
 * carries on typing. The value is text to this field, never a control: the
 * editor never checks it here, main resolves it when the automation fires.
 */
import { useLayoutEffect, useRef } from "react";
import { claimFocus } from "../../lib/focus-ownership";
import { Dropdown, Input, Textarea } from "../ui";

/** A value the trigger carries, as the Insert value list shows it. */
export type ValueChoice = { readonly name: string; readonly words: string };

export function ActionText({
  label,
  noun,
  value,
  onValue,
  values,
  placeholder,
  multiline = true,
  describedBy,
}: {
  /** The field's own name, for a reader: "Mail text". */
  readonly label: string;
  /**
   * What the Insert value control writes into, named apart from the field: a
   * reader's control list shows both, and two names that overlap read as one
   * control twice.
   */
  readonly noun: string;
  readonly value: string;
  readonly onValue: (text: string) => void;
  readonly values: ReadonlyArray<ValueChoice>;
  readonly placeholder: string;
  /** Prose reads back over a few lines; a task's title stays one. */
  readonly multiline?: boolean;
  readonly describedBy?: string;
}) {
  const area = useRef<HTMLTextAreaElement>(null);
  const line = useRef<HTMLInputElement>(null);
  /** Where the caret goes once the draft holds the value just inserted. */
  const pending = useRef<number | undefined>(undefined);
  /** The last selection seen while the text had the keyboard. */
  const caret = useRef<{ readonly start: number; readonly end: number } | undefined>(undefined);

  // The Dropdown puts focus back on its trigger as it closes; this runs after
  // that, so the caret ends up in the text the value was written into.
  useLayoutEffect(() => {
    const at = pending.current;
    const field = area.current ?? line.current;
    if (at === undefined || field === null) return;
    pending.current = undefined;
    // focus-law: a press on Insert value returns the caret to the text it writes into.
    claimFocus(field, "gesture");
    field.setSelectionRange(at, at);
  }, [value]);

  const remember = (field: HTMLTextAreaElement | HTMLInputElement): void => {
    caret.current = { start: field.selectionStart ?? field.value.length, end: field.selectionEnd ?? field.value.length };
  };

  /**
   * A text never focused reports its selection at 0: the value goes to the
   * end then, and otherwise where the caret was left.
   */
  const place = (field: HTMLTextAreaElement | HTMLInputElement | null): { readonly start: number; readonly end: number } => {
    const length = value.length;
    if (field !== null && document.activeElement === field) {
      const start = Math.min(Math.max(field.selectionStart ?? length, 0), length);
      return { start, end: Math.min(Math.max(field.selectionEnd ?? start, start), length) };
    }
    const held = caret.current;
    if (held === undefined) return { start: length, end: length };
    return { start: Math.min(held.start, length), end: Math.min(Math.max(held.end, held.start), length) };
  };

  const insert = (name: string): void => {
    const token = `{{${name}}}`;
    const { start, end } = place(area.current ?? line.current);
    onValue(`${value.slice(0, start)}${token}${value.slice(end)}`);
    pending.current = start + token.length;
  };

  const shared = {
    value,
    "aria-label": label,
    "aria-describedby": describedBy,
    placeholder,
    spellCheck: multiline,
  } as const;

  return (
    <div className="automation-editor__text">
      {multiline ? (
        <Textarea
          dense
          ref={area}
          {...shared}
          onChange={(event) => onValue(event.target.value)}
          onSelect={(event) => remember(event.currentTarget)}
        />
      ) : (
        <Input
          dense
          ref={line}
          {...shared}
          onChange={(event) => onValue(event.target.value)}
          onSelect={(event) => remember(event.currentTarget)}
        />
      )}
      <Dropdown
        className="automation-editor__insert"
        triggerClassName="automation-editor__insert-trigger"
        menuClassName="automation-editor__insert-menu"
        // Label in Name: the visible words are "Insert value", so the name starts with them.
        aria-label={`Insert value into the ${noun}`}
        placeholder="Insert value"
        value=""
        options={values.map((choice) => ({
          value: choice.name,
          label: `{{${choice.name}}}`,
          detail: choice.words,
        }))}
        onChange={insert}
      />
    </div>
  );
}
