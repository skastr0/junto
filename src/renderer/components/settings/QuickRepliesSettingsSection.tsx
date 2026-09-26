/**
 * Settings -> Quick replies: the one-click answers offered on open agent
 * signals (feed cards and the seat sidebar). Every edit writes the whole list
 * through settingsPatch, so the StateEngine row stays the only copy; a row
 * holds its own text only while it is being typed.
 */
import { use$ } from "@legendapp/state/react";
import { ArrowDown, ArrowUp, Plus, X } from "lucide-react";
import { useEffect, useState } from "react";
import { QUICK_REPLY_BOUNDS, feedSettings, sanitizeQuickReplies } from "@shared/settings";
import { moveQuickReply } from "../../lib/quick-replies";
import { patchSettings } from "../../lib/settings-state";
import { state$ } from "../../lib/state";
import { Button, IconButton, Input } from "../ui";
import "../signals/quick-replies.css";

const save = (replies: ReadonlyArray<string>): Promise<boolean> =>
  patchSettings({ feed: { quickReplies: sanitizeQuickReplies(replies) } });

function ReplyRow({
  text,
  index,
  count,
  replies,
}: {
  readonly text: string;
  readonly index: number;
  readonly count: number;
  readonly replies: ReadonlyArray<string>;
}) {
  const [draft, setDraft] = useState<string>();
  useEffect(() => setDraft(undefined), [text]);

  const commit = (): void => {
    if (draft === undefined) return;
    const next = draft.trim();
    // An emptied row keeps its reply; removing is the X.
    if (next.length === 0 || next === text) {
      setDraft(undefined);
      return;
    }
    void save(replies.map((reply, at) => (at === index ? next : reply))).then((ok) => {
      if (!ok) setDraft(undefined);
    });
  };

  return (
    <li className="quick-replies-settings__row">
      <span className="quick-replies-settings__key" title={index < 9 ? `Key ${index + 1} on the selected feed card` : undefined}>
        {index < 9 ? index + 1 : ""}
      </span>
      <Input
        value={draft ?? text}
        maxLength={QUICK_REPLY_BOUNDS.maxChars}
        aria-label={`Quick reply ${index + 1}`}
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
          onClick={() => void save(moveQuickReply(replies, index, -1))}
        >
          <ArrowUp size={13} />
        </IconButton>
        <IconButton
          size="sm"
          aria-label={`Move "${text}" down`}
          disabled={index === count - 1}
          onClick={() => void save(moveQuickReply(replies, index, 1))}
        >
          <ArrowDown size={13} />
        </IconButton>
        <IconButton
          size="sm"
          tone="danger"
          aria-label={`Remove "${text}"`}
          onClick={() => void save(replies.filter((_, at) => at !== index))}
        >
          <X size={13} />
        </IconButton>
      </span>
    </li>
  );
}

export function QuickRepliesSettingsSection() {
  const replies = use$(() => feedSettings(state$.settings.get()).quickReplies);
  const [draft, setDraft] = useState("");
  const full = replies.length >= QUICK_REPLY_BOUNDS.maxCount;
  const text = draft.replace(/\s+/g, " ").trim();
  const duplicate = replies.some((reply) => reply.toLowerCase() === text.toLowerCase());
  const canAdd = !full && text.length > 0 && !duplicate;

  const add = (): void => {
    if (!canAdd) return;
    void save([...replies, text]).then((ok) => {
      if (ok) setDraft("");
    });
  };

  return (
    <div className="settings-section quick-replies-settings" data-testid="settings-quick-replies-section">
      <p className="settings-note quick-replies-settings__intro">
        Offered as one-click answers when an agent is waiting on you, on feed cards and in the seat sidebar.
        Each is sent to the agent as your reply. On the selected feed card, keys 1 to 9 send them.
      </p>
      {replies.length === 0 ? (
        <p className="settings-note">No quick replies. Add one below.</p>
      ) : (
        <ol className="quick-replies-settings__list">
          {replies.map((reply, index) => (
            <ReplyRow key={reply} text={reply} index={index} count={replies.length} replies={replies} />
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
          placeholder={full ? `The list holds ${QUICK_REPLY_BOUNDS.maxCount} replies` : "Add a quick reply"}
          disabled={full}
          aria-label="New quick reply"
          onChange={(event) => setDraft(event.target.value)}
        />
        <Button type="submit" size="md" variant="chrome" disabled={!canAdd}>
          <Plus size={13} aria-hidden />
          Add
        </Button>
      </form>
      <p className="settings-note">
        {duplicate && text.length > 0
          ? "That reply is already in the list."
          : `${replies.length} of ${QUICK_REPLY_BOUNDS.maxCount}, one line each, up to ${QUICK_REPLY_BOUNDS.maxChars} characters.`}
      </p>
    </div>
  );
}
