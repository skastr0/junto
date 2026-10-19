/**
 * Settings -> Quick replies: the one-click answers offered on open agent
 * signals (feed cards and the seat sidebar), and next to them the quiet notes
 * that answer a signal without waking the seat. Both lists share one editor.
 * Every edit writes the whole list through settingsPatch, so the StateEngine
 * row stays the only copy; a row holds its own text only while it is being
 * typed.
 */
import { use$ } from "@legendapp/state/react";
import { ArrowDown, ArrowUp, Plus, X } from "lucide-react";
import { useEffect, useState } from "react";
import { QUICK_REPLY_BOUNDS, feedSettings, quietNotesOf, sanitizeQuickReplies } from "@shared/settings";
import { moveQuickReply } from "../../lib/quick-replies";
import { patchSettings } from "../../lib/settings-state";
import { state$ } from "../../lib/state";
import { Button, IconButton, Input } from "../ui";
import { SettingGroup } from "./FieldRow";
import "../signals/quick-replies.css";

/** What differs between the two lists; the editor is the same. */
interface ListKind {
  readonly title: string;
  readonly noun: string;
  readonly plural: string;
  readonly many: string;
  readonly keyPrefix: string;
  readonly testId: string;
  readonly save: (items: ReadonlyArray<string>) => Promise<boolean>;
}

const QUICK_REPLIES: ListKind = {
  title: "Quick replies",
  noun: "quick reply",
  plural: "replies",
  many: "quick replies",
  keyPrefix: "",
  testId: "settings-quick-replies-section",
  save: (items) => patchSettings({ feed: { quickReplies: sanitizeQuickReplies(items) } }),
};

const QUIET_NOTES: ListKind = {
  title: "Quiet notes",
  noun: "quiet note",
  plural: "notes",
  many: "quiet notes",
  keyPrefix: "Shift+",
  testId: "settings-quiet-notes-section",
  save: (items) => patchSettings({ feed: { quietNotes: sanitizeQuickReplies(items) } }),
};

const capitalized = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

function ItemRow({
  kind,
  text,
  index,
  items,
}: {
  readonly kind: ListKind;
  readonly text: string;
  readonly index: number;
  readonly items: ReadonlyArray<string>;
}) {
  const [draft, setDraft] = useState<string>();
  useEffect(() => setDraft(undefined), [text]);

  const commit = (): void => {
    if (draft === undefined) return;
    const next = draft.trim();
    // An emptied row keeps its text; removing is the X.
    if (next.length === 0 || next === text) {
      setDraft(undefined);
      return;
    }
    void kind.save(items.map((item, at) => (at === index ? next : item))).then((ok) => {
      if (!ok) setDraft(undefined);
    });
  };

  return (
    <li className="quick-replies-settings__row">
      <span
        className="quick-replies-settings__key"
        title={index < 9 ? `${kind.keyPrefix}${index + 1} on the selected feed card` : undefined}
      >
        {index < 9 ? `${kind.keyPrefix === "" ? "" : "⇧"}${index + 1}` : ""}
      </span>
      <Input
        value={draft ?? text}
        maxLength={QUICK_REPLY_BOUNDS.maxChars}
        aria-label={`${capitalized(kind.noun)} ${index + 1}`}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          } else if (event.key === "Escape" && draft !== undefined) {
            event.preventDefault();
            event.stopPropagation();
            setDraft(undefined);
          }
        }}
      />
      <span className="quick-replies-settings__tools">
        <IconButton
          size="sm"
          aria-label={`Move "${text}" up`}
          disabled={index === 0}
          onClick={() => void kind.save(moveQuickReply(items, index, -1))}
        >
          <ArrowUp size={13} />
        </IconButton>
        <IconButton
          size="sm"
          aria-label={`Move "${text}" down`}
          disabled={index === items.length - 1}
          onClick={() => void kind.save(moveQuickReply(items, index, 1))}
        >
          <ArrowDown size={13} />
        </IconButton>
        <IconButton
          size="sm"
          tone="danger"
          aria-label={`Remove "${text}"`}
          onClick={() => void kind.save(items.filter((_, at) => at !== index))}
        >
          <X size={13} />
        </IconButton>
      </span>
    </li>
  );
}

function ListEditor({
  kind,
  items,
  intro,
}: {
  readonly kind: ListKind;
  readonly items: ReadonlyArray<string>;
  readonly intro: string;
}) {
  const [draft, setDraft] = useState("");
  const full = items.length >= QUICK_REPLY_BOUNDS.maxCount;
  const text = draft.replace(/\s+/g, " ").trim();
  const duplicate = items.some((item) => item.toLowerCase() === text.toLowerCase());
  const canAdd = !full && text.length > 0 && !duplicate;

  const add = (): void => {
    if (!canAdd) return;
    void kind.save([...items, text]).then((ok) => {
      if (ok) setDraft("");
    });
  };

  return (
    <div className="settings-section quick-replies-settings" data-testid={kind.testId} data-setting={kind.title}>
      <p className="settings-note quick-replies-settings__intro">{intro}</p>
      {items.length === 0 ? (
        <p className="settings-note">No {kind.many}. Add one below.</p>
      ) : (
        <ol className="quick-replies-settings__list">
          {items.map((item, index) => (
            <ItemRow key={item} kind={kind} text={item} index={index} items={items} />
          ))}
        </ol>
      )}
      <form
        className="quick-replies-settings__add"
        onSubmit={(event) => {
          event.preventDefault();
          add();
        }}
      >
        <Input
          value={draft}
          maxLength={QUICK_REPLY_BOUNDS.maxChars}
          placeholder={full ? `The list holds ${QUICK_REPLY_BOUNDS.maxCount} ${kind.plural}` : `Add a ${kind.noun}`}
          disabled={full}
          aria-label={`New ${kind.noun}`}
          onChange={(event) => setDraft(event.target.value)}
        />
        <Button type="submit" size="md" variant="chrome" disabled={!canAdd}>
          <Plus size={13} aria-hidden />
          Add
        </Button>
      </form>
      <p className="settings-note">
        {duplicate && text.length > 0
          ? `That ${kind.noun} is already in the list.`
          : `${items.length} of ${QUICK_REPLY_BOUNDS.maxCount}`}
      </p>
    </div>
  );
}

export function QuickRepliesSettingsSection() {
  const replies = use$(() => feedSettings(state$.settings.get()).quickReplies);
  const notes = use$(() => quietNotesOf(state$.settings.get()));

  return (
    <>
      <SettingGroup title={QUICK_REPLIES.title}>
        <ListEditor
          kind={QUICK_REPLIES}
          items={replies}
          intro="One-click answers when an agent is waiting on you. Keys 1 to 9 send them."
        />
      </SettingGroup>
      <SettingGroup title={QUIET_NOTES.title}>
        <ListEditor
          kind={QUIET_NOTES}
          items={notes}
          intro="Shift+1 to 9 sends them. They answer the signal without waking the seat."
        />
      </SettingGroup>
    </>
  );
}
