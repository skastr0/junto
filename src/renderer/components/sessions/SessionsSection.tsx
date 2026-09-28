import { useCallback, useEffect, useState } from "react";
import { isHarnessId, templateFor } from "@shared/managed-terminal-templates";
import type { SeatSession, SeatSessionEndReason } from "@shared/seat-sessions";
import { getJuntoApi } from "../../lib/junto-api";
import { NoteMarkdown } from "../../lib/note-markdown";
import { Button, Chip } from "../ui";
import type { AgentEditorSectionProps } from "../agent-editor/sections";
import "./sessions.css";

// Sessions: every session this seat has run, newest first. Each shows when it
// started, which agent ran it, and the one-line summary from the notes its
// agent left when it handed off. The notes read here; the transcript opens in
// the file manager, where the agent itself would look.

const WHEN = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

const ENDED: Record<SeatSessionEndReason, string> = {
  offboard: "handed off",
  reseat: "agent changed",
  replaced: "replaced",
};

const harnessName = (harness: string): string =>
  isHarnessId(harness) ? templateFor(harness).displayName : harness;

type Load = { readonly state: "loading" } | { readonly state: "ready"; readonly sessions: ReadonlyArray<SeatSession> };

function SessionRow({ seatId, session }: { readonly seatId: string; readonly session: SeatSession }) {
  const [notes, setNotes] = useState<string | undefined>();
  const [problem, setProblem] = useState<string | undefined>();
  const current = session.endedAt === undefined;
  const hasNotes = session.offboardedAt !== undefined;
  const open = notes !== undefined;

  const toggleNotes = async () => {
    if (open) {
      setNotes(undefined);
      return;
    }
    const result = await getJuntoApi()?.seatSessionNotes?.(seatId, session.sessionId);
    if (result?.ok) {
      setProblem(undefined);
      setNotes(result.notes);
    } else {
      setProblem(result?.message ?? "Junto could not read these notes.");
    }
  };

  const revealTranscript = async () => {
    const result = await getJuntoApi()?.seatSessionRevealTranscript?.(seatId, session.sessionId);
    setProblem(result?.ok === false ? result.message : undefined);
  };

  return (
    <li className="seat-sessions__row" data-testid="seat-session-row" data-current={current ? "true" : undefined}>
      <div className="seat-sessions__head">
        <span className="seat-sessions__when">{WHEN.format(session.startedAt)}</span>
        <span className="seat-sessions__harness">{harnessName(session.harness)}</span>
        {current ? (
          <span className="seat-sessions__state">
            <Chip tone="green">now</Chip>
          </span>
        ) : session.endReason ? (
          <span className="seat-sessions__state seat-sessions__ended">{ENDED[session.endReason]}</span>
        ) : null}
      </div>
      <p className="seat-sessions__gist" data-empty={session.gist ? undefined : "true"}>
        {session.gist ?? (current ? "Notes appear when the agent hands off." : "No notes from this session.")}
      </p>
      <div className="seat-sessions__actions">
        <Button
          size="xs"
          variant="subtle"
          disabled={!hasNotes}
          aria-expanded={open}
          title={hasNotes ? undefined : "The agent left no notes for this session"}
          onClick={() => void toggleNotes()}
        >
          {open ? "Hide notes" : "Open notes"}
        </Button>
        <Button
          size="xs"
          variant="subtle"
          disabled={session.transcriptPath === undefined}
          title={session.transcriptPath ?? "The agent has not written a transcript for this session yet"}
          onClick={() => void revealTranscript()}
        >
          Reveal transcript
        </Button>
      </div>
      {problem ? <p className="seat-sessions__problem">{problem}</p> : null}
      {open ? (
        <div className="seat-sessions__notes note-surface" data-testid="seat-session-notes">
          <NoteMarkdown source={notes} />
        </div>
      ) : null}
    </li>
  );
}

export function SessionsSection({ seat }: AgentEditorSectionProps) {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  // A new session id on the node is a new session to list.
  const current = seat.node.ether?.terminal?.sessionId;

  const refresh = useCallback(async () => {
    const sessions = await getJuntoApi()?.seatSessionsList?.(seat.id).catch(() => undefined);
    setLoad({ state: "ready", sessions: sessions ?? [] });
  }, [seat.id]);

  useEffect(() => {
    void refresh();
  }, [refresh, current]);

  useEffect(
    () =>
      getJuntoApi()?.onSeatSessionsChanged?.((event) => {
        if (event.seatId === seat.id) void refresh();
      }),
    [refresh, seat.id],
  );

  return (
    <div className="seat-sessions" data-testid="seat-sessions-section">
      <p className="agent-editor__hint">
        Every session this seat has run, newest first. When the agent hands off with <code>junto offboard</code>, its
        notes land here, and the next session reads them as it starts.
      </p>
      {load.state === "loading" ? null : load.sessions.length === 0 ? (
        <p className="agent-editor__hint">No sessions yet. The first one appears when this seat starts.</p>
      ) : (
        <ol className="seat-sessions__list" aria-label="Sessions">
          {load.sessions.map((session) => (
            <SessionRow key={session.sessionId} seatId={seat.id} session={session} />
          ))}
        </ol>
      )}
    </div>
  );
}
