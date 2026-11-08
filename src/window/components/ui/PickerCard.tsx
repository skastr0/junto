import { useEffect, useRef, useState, type ReactNode } from "react";
import { MoreHorizontal, Plus } from "lucide-react";
import type { Side } from "../../lib/menu-placement";
import { claimFocus } from "../../lib/focus-ownership";
import { Button } from "./Button";
import { Input } from "./Field";
import { IconButton } from "./IconButton";
import { Popover } from "./Popover";
import "./picker-card.css";

/**
 * The add picker's one card. Profiles, Create profile, squads, and the node
 * catalog all render their choices through it, so every choice has the same
 * size, the same art slot, the same title and subtitle type, and the same
 * menu. A section supplies the art (a face, stacked faces, a node icon) and
 * the words; it never styles a card of its own.
 */
export type PickerCardKind = "profile" | "create" | "squad" | "catalog";

export function PickerCardGrid({
  label,
  className,
  children,
}: {
  readonly label?: string;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  return (
    <ul className={`picker-card-grid${className ? ` ${className}` : ""}`} aria-label={label}>
      {children}
    </ul>
  );
}

export type PickerCardMenu = {
  /** "Manage squad Review", for the menu button. */
  readonly label: string;
  /** Tooltip naming what the menu offers. */
  readonly title: string;
  /** Opens the menu against the whole card. */
  readonly onOpen: (card: HTMLElement) => void;
};

export function PickerCard({
  kind,
  art,
  title,
  lead,
  meta,
  body,
  quiet = false,
  label,
  onActivate,
  menu,
}: {
  readonly kind: PickerCardKind;
  /** Drawn in the card's fixed square slot. */
  readonly art: ReactNode;
  readonly title: string;
  /** Subtitle start, in ink (a harness, a team size). */
  readonly lead?: string;
  /** Subtitle rest, dimmed (the dials, the connections). */
  readonly meta?: string;
  /** Up to two lines: a soul, a purpose. */
  readonly body?: string;
  /** The body is a placeholder, not content. */
  readonly quiet?: boolean;
  /** Accessible name when the visible words are not enough. */
  readonly label?: string;
  readonly onActivate: () => void;
  readonly menu?: PickerCardMenu;
}) {
  const cardRef = useRef<HTMLLIElement>(null);
  const openMenu = (): void => {
    if (cardRef.current) menu?.onOpen(cardRef.current);
  };
  return (
    <li ref={cardRef} className="picker-card" data-picker-card={kind}>
      <button
        type="button"
        className="picker-card__hit"
        aria-label={label}
        onClick={onActivate}
        onContextMenu={
          menu
            ? (event) => {
                event.preventDefault();
                event.stopPropagation();
                openMenu();
              }
            : undefined
        }
      >
        <span className="picker-card__art" aria-hidden>{art}</span>
        <span className="picker-card__text">
          <span className="picker-card__title">{title}</span>
          {lead || meta ? (
            <span className="picker-card__sub">
              {lead ? <span className="picker-card__lead">{lead}</span> : null}
              {meta ? <span className="picker-card__meta">{meta}</span> : null}
            </span>
          ) : null}
          {body ? (
            <span className="picker-card__body" data-quiet={quiet ? "true" : undefined}>{body}</span>
          ) : null}
        </span>
      </button>
      {menu ? (
        <IconButton aria-label={menu.label} title={menu.title} className="picker-card__more" onClick={openMenu}>
          <MoreHorizontal size={14} />
        </IconButton>
      ) : null}
    </li>
  );
}

/** Art for a card that makes something new: an empty dashed ring with a plus. */
export function PickerCardAddArt() {
  return (
    <span className="picker-card__add">
      <Plus size={20} strokeWidth={1.7} />
    </span>
  );
}

// Below the card, else above it: the menu never covers the card it manages
// or the card beside it.
const MANAGE_SIDES: ReadonlyArray<Side> = ["below", "above"];

/**
 * A card's menu: rename it in place, or delete it after a second press. The
 * one manage menu every saved thing in the picker uses.
 */
export function PickerCardManage({
  noun,
  name,
  maxLength,
  anchor,
  onClose,
  onRename,
  onDelete,
  testId,
}: {
  /** "profile", "squad". */
  readonly noun: string;
  readonly name: string;
  readonly maxLength: number;
  readonly anchor: HTMLElement;
  readonly onClose: () => void;
  /** Resolves "" on success, else the reason. */
  readonly onRename: (name: string) => Promise<string>;
  readonly onDelete: () => Promise<string>;
  readonly testId?: string;
}) {
  const [draft, setDraft] = useState(name);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    claimFocus(inputRef.current, "open", { select: true });
  }, []);

  const settle = (reason: string): void => {
    if (reason) setError(reason);
    else onClose();
  };

  const rename = async (): Promise<void> => {
    if (draft.trim() === name) return onClose();
    settle(await onRename(draft));
  };

  return (
    <Popover
      anchor={anchor}
      onClose={onClose}
      label={`Manage ${noun} ${name}`}
      width={288}
      sides={MANAGE_SIDES}
      {...(testId ? { testId } : {})}
    >
      <form
        className="picker-manage"
        onSubmit={(event) => {
          event.preventDefault();
          void rename();
        }}
      >
        <Input
          ref={inputRef}
          value={draft}
          maxLength={maxLength}
          onChange={(event) => {
            setDraft(event.target.value);
            setError("");
          }}
          aria-label={`${noun[0]!.toUpperCase()}${noun.slice(1)} name`}
        />
        {confirmDelete ? (
          <>
            <p className="picker-manage__ask">Delete {name} for good? Seats already placed stay.</p>
            <div className="picker-manage__row" data-confirm="true">
              <Button size="xs" variant="subtle" onClick={() => setConfirmDelete(false)}>Keep</Button>
              <Button size="xs" variant="danger" onClick={() => void onDelete().then(settle)}>
                Delete {name}
              </Button>
            </div>
          </>
        ) : (
          <div className="picker-manage__row">
            <Button size="xs" type="submit" disabled={!draft.trim()}>Rename</Button>
            <Button size="xs" variant="subtle" onClick={() => setConfirmDelete(true)}>Delete {noun}</Button>
          </div>
        )}
        {error ? <p className="picker-manage__error" role="alert">{error}</p> : null}
      </form>
    </Popover>
  );
}
