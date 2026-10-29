import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ulid } from "ulid";
import { regionName } from "@shared/model/canvas";
import { titleOf } from "@shared/model/title";
import type { NodeId } from "@shared/physics/schema";
import type { ContentRef } from "@shared/wire/content-ref";
import type { SignalActionResult } from "../../lib/agent-signals-view";
import { useAttachments } from "../../lib/operator-attachments";
import {
  forgetWorkDrafts,
  replyRefusalOf,
  keepWorkDraft,
  proofLinksOf,
  wordProgressOf,
  wordProgressWords,
  workDraftOf,
  type SignalForm,
  type WorkReply,
} from "../../lib/signal-work";
import { useCanvas } from "../../lib/use-model";
import { LiveMarkdownField } from "../artifacts/lazy-editors";
import { AttachButton, AttachmentTray } from "../attachments/AttachmentTray";
import { Button, ConfirmDialog, Input, Textarea } from "../ui";
import { useSignalAction } from "./SignalReply";
import "./signal-work.css";

type FormOf<K extends SignalForm["kind"]> = Extract<SignalForm, { readonly kind: K }>;

/** A well-formed id for asking the rule ahead of a hand-in; the rule does not read it. */
const RULING_PROBE = "00000000000000000000000000";

/**
 * The operator's work, done in the signal (plan 0.11/07, N3). An artifact
 * form is a document written here, in the editor documents use, with its
 * word condition filling as the operator writes; it is handed in once the
 * condition holds and becomes the document in its Artifacts node. A proof
 * form is what was done, with links and files. Writing not handed in is
 * kept while the window runs. A secret form (with the vault) takes a value
 * that goes to the vault and nowhere else: the field is never held, and is
 * emptied after each try. Dismissing work is deliberate: it asks first, and
 * the work closes undone.
 */
export function SignalWorkForm({
  signalId,
  canvasName,
  text,
  form,
  asker,
  handIn,
  putSecret,
  dismiss,
  onDone,
}: {
  readonly signalId: string;
  readonly canvasName: string;
  /** The signal's own sentence: what the work is. */
  readonly text: string;
  readonly form: FormOf<"artifact"> | FormOf<"proof"> | FormOf<"secret">;
  /** Who raised it, the seat or the automation, as the card names it: a secret form says who asks. */
  readonly asker: string;
  readonly handIn: (signalId: string, reply: WorkReply) => Promise<SignalActionResult>;
  readonly putSecret: (signalId: string, value: string) => Promise<SignalActionResult>;
  readonly dismiss: (signalId: string) => Promise<SignalActionResult>;
  readonly onDone: () => void;
}) {
  const [asking, setAsking] = useState(false);
  const { pending, error, act } = useSignalAction(() => {
    forgetWorkDrafts(signalId);
    onDone();
  });
  // One id per hand-in attempt: a retry after a failure that did land is not a second document.
  const [replyId] = useState(() => ulid());
  const send = (reply: WorkReply): void => {
    if (pending === null) void act("", () => handIn(signalId, reply));
  };
  const dismissal = (
    <>
      {/* aria-disabled, not disabled, so focus stays on it while a hand-in is in flight. */}
      <Button
        size="xs"
        variant="subtle"
        aria-disabled={pending !== null || undefined}
        onClick={() => {
          if (pending === null) setAsking(true);
        }}
      >
        Dismiss
      </Button>
      {asking ? (
        <ConfirmDialog
          title="Dismiss this work?"
          confirmLabel="Dismiss, not done"
          cancelLabel="Keep it"
          busy={pending !== null}
          onCancel={() => setAsking(false)}
          onConfirm={() => {
            setAsking(false);
            void act("", () => dismiss(signalId));
          }}
        >
          {`"${text}" closes without being done. What you wrote here is not kept.`}
        </ConfirmDialog>
      ) : null}
    </>
  );
  const failure = error ? (
    <p className="signal-work__error" role="alert">
      {error}
    </p>
  ) : null;
  if (form.kind === "secret") {
    return (
      <SecretWork
        form={form}
        canvasName={canvasName}
        asker={asker}
        busy={pending !== null}
        dismissal={dismissal}
        failure={failure}
        onPut={(value) => {
          if (pending === null) void act("", () => putSecret(signalId, value));
        }}
      />
    );
  }
  return form.kind === "artifact" ? (
    <ArtifactWork
      signalId={signalId}
      canvasName={canvasName}
      form={form}
      busy={pending !== null}
      dismissal={dismissal}
      failure={failure}
      onHandIn={(markdown) => send({ kind: "artifact", markdown, replyId })}
    />
  ) : (
    <ProofWork
      signalId={signalId}
      canvasName={canvasName}
      busy={pending !== null}
      dismissal={dismissal}
      failure={failure}
      onHandIn={(proof) => send({ kind: "proof", ...proof, replyId })}
    />
  );
}

function SecretWork({
  form,
  canvasName,
  asker,
  busy,
  dismissal,
  failure,
  onPut,
}: {
  readonly form: FormOf<"secret">;
  readonly canvasName: string;
  readonly asker: string;
  readonly busy: boolean;
  readonly dismissal: ReactNode;
  readonly failure: ReactNode;
  readonly onPut: (value: string) => void;
}) {
  // The value lives in the field alone: never in state, a draft or the view.
  const field = useRef<HTMLInputElement>(null);
  const [typed, setTyped] = useState(false);
  // Each try gets a new field: emptying one leaves its own undo able to bring the value back.
  const [attempt, setAttempt] = useState(0);
  // Enter in the field sent it: the new field takes the focus the old one had, so the next try is where the operator is.
  const refocus = useRef(false);
  useEffect(() => {
    if (!refocus.current) return;
    refocus.current = false;
    field.current?.focus();
  }, [attempt]);
  const canvas = useCanvas(canvasName);
  const region = canvas.nodes.get(form.regionId as NodeId);
  const where = region?.kind === "region" ? regionName(region) : "a region out of reach";
  const noteId = useId();
  const put = (): void => {
    const input = field.current;
    if (input === null || input.value === "" || busy) return;
    const value = input.value;
    // Emptied as it goes, whatever comes back.
    input.value = "";
    setTyped(false);
    refocus.current = document.activeElement === input;
    setAttempt((count) => count + 1);
    onPut(value);
  };
  return (
    <div className="signal-work" data-testid="signal-work-form" data-form="secret">
      <p className="signal-work__where">
        {asker} asks for <span className="signal-work__title">{form.name}</span>, declared in {where}, for {form.machine}.
      </p>
      <p id={noteId} className="signal-work__where">
        It goes into the vault and nowhere else: not this signal, its answer or any log.
      </p>
      <Input
        key={attempt}
        ref={field}
        dense
        type="password"
        // "new-password", which a browser honours for a password field where "off" may not: nothing offered, nothing saved.
        autoComplete="new-password"
        // And the password managers' own opt-outs: no saved login filled in, no offer to save the value.
        data-1p-ignore="true"
        data-lpignore="true"
        spellCheck={false}
        aria-label={`Value of ${form.name}`}
        aria-describedby={noteId}
        placeholder="Paste the value"
        onChange={(event) => setTyped(event.target.value !== "")}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            put();
          }
        }}
      />
      {failure}
      <div className="signal-work__actions">
        {dismissal}
        <Button size="xs" variant="primary" aria-disabled={!typed || busy} title={typed ? `Set ${form.name} in the vault` : "Paste the value first"} onClick={put}>
          Set secret
        </Button>
      </div>
    </div>
  );
}

function ArtifactWork({
  signalId,
  canvasName,
  form,
  busy,
  dismissal,
  failure,
  onHandIn,
}: {
  readonly signalId: string;
  readonly canvasName: string;
  readonly form: FormOf<"artifact">;
  readonly busy: boolean;
  readonly dismissal: ReactNode;
  readonly failure: ReactNode;
  readonly onHandIn: (markdown: string) => void;
}) {
  const canvas = useCanvas(canvasName);
  const shelf = canvas.nodes.get(form.nodeId as NodeId);
  const [opened] = useState(() => workDraftOf(signalId));
  const [markdown, setMarkdown] = useState(opened);
  const progress = useMemo(() => wordProgressOf(markdown, form.minWords), [markdown, form.minWords]);
  const counted = wordProgressWords(progress);
  const short = progress.min - progress.words;
  const fill = Math.min(1, progress.words / progress.min);
  const countId = useId();
  const refusalId = useId();
  // Main's own rule, asked before Hand in goes: past the word count, a document too long is refused too.
  const refusal = progress.met ? replyRefusalOf(form, { kind: "artifact", markdown, replyId: RULING_PROBE }) : undefined;
  const ready = progress.met && refusal === undefined;
  return (
    <div className="signal-work" data-testid="signal-work-form" data-form="artifact">
      <p className="signal-work__where">
        Becomes <span className="signal-work__title">{form.title}</span>
        {shelf ? ` in ${titleOf(shelf)}` : " in an Artifacts node out of reach"}
        {form.labels.length > 0 ? `, labelled ${form.labels.join(", ")}` : null}
      </p>
      <LiveMarkdownField
        className="signal-work__field"
        value={opened}
        label="Your writing"
        surfaceLabel={`${form.title}, your writing`}
        placeholder="Write here. It becomes the document when you hand it in."
        onChange={(next) => {
          setMarkdown(next);
          keepWorkDraft(signalId, next);
        }}
      />
      <div className="signal-work__progress" data-met={progress.met || undefined}>
        {progress.min > 1 ? (
          <div
            className="signal-work__meter"
            role="progressbar"
            aria-label="Words written"
            aria-valuemin={0}
            aria-valuemax={progress.min}
            aria-valuenow={Math.min(progress.words, progress.min)}
            aria-valuetext={counted}
            style={{ "--signal-work-fill": fill } as CSSProperties}
          >
            <span className="signal-work__meter-fill" />
          </div>
        ) : null}
        <span id={countId} className="signal-work__count">
          {counted}
        </span>
      </div>
      {/* Said once, as the condition comes to hold, not on every word. */}
      <span className="sr-only" role="status">
        {progress.met && progress.min > 1 ? "Enough words to hand in." : ""}
      </span>
      {refusal === undefined ? null : (
        <p id={refusalId} className="signal-work__error">
          {refusal}
        </p>
      )}
      {failure}
      <div className="signal-work__actions">
        {dismissal}
        <Button
          size="xs"
          variant="primary"
          aria-disabled={!ready || busy}
          // Why it waits is beside it, the count or main's refusal: a reader hears it on the button.
          aria-describedby={ready ? undefined : progress.met ? refusalId : countId}
          title={
            ready
              ? "Hand in: the writing becomes the document, and the work is done"
              : (refusal ?? `${short} more ${short === 1 ? "word" : "words"} to hand in`)
          }
          onClick={() => {
            if (ready && !busy) onHandIn(markdown);
          }}
        >
          Hand in
        </Button>
      </div>
    </div>
  );
}

function ProofWork({
  signalId,
  canvasName,
  busy,
  dismissal,
  failure,
  onHandIn,
}: {
  readonly signalId: string;
  readonly canvasName: string;
  readonly busy: boolean;
  readonly dismissal: ReactNode;
  readonly failure: ReactNode;
  readonly onHandIn: (proof: { readonly text: string; readonly links: ReadonlyArray<string>; readonly files: ReadonlyArray<ContentRef> }) => void;
}) {
  const [text, setText] = useState(() => workDraftOf(signalId, "proof-text"));
  const [typedLinks, setTypedLinks] = useState(() => workDraftOf(signalId, "proof-links"));
  const whyId = useId();
  const attachments = useAttachments(canvasName);
  const { links, problem } = proofLinksOf(typedLinks);
  const files = attachments.ready ?? [];
  const filesIn = attachments.ready !== undefined;
  // Main's own rule: proof needs a sentence saying what it shows, with its links admitted.
  const refusal = problem === undefined ? replyRefusalOf({ kind: "proof" }, { kind: "proof", text, links, replyId: RULING_PROBE }) : undefined;
  const ready = problem === undefined && refusal === undefined && filesIn && !busy;
  const why = problem ?? (!filesIn ? "Waiting for the files to attach" : refusal);
  return (
    <div className="signal-work" data-testid="signal-work-form" data-form="proof" {...attachments.dropTarget}>
      <Textarea
        dense
        rows={3}
        value={text}
        aria-label="What you did"
        placeholder="What you did"
        onChange={(event) => {
          setText(event.target.value);
          keepWorkDraft(signalId, event.target.value, "proof-text");
        }}
      />
      <Textarea
        dense
        rows={2}
        value={typedLinks}
        spellCheck={false}
        aria-label="Links, one per line"
        aria-invalid={problem !== undefined || undefined}
        placeholder="Links, one per line"
        onChange={(event) => {
          setTypedLinks(event.target.value);
          keepWorkDraft(signalId, event.target.value, "proof-links");
        }}
      />
      {problem ? (
        <p className="signal-work__error" role="alert">
          {problem}
        </p>
      ) : null}
      <AttachmentTray attachments={attachments} />
      {failure}
      {/* Why Hand in waits, for a reader on the button; the links' own problem is said above. */}
      <span id={whyId} className="sr-only">
        {problem === undefined ? (why ?? "") : ""}
      </span>
      <div className="signal-work__actions">
        <span className="mr-auto flex">
          <AttachButton attachments={attachments} disabled={busy} />
        </span>
        {dismissal}
        <Button
          size="xs"
          variant="primary"
          aria-disabled={!ready}
          aria-describedby={ready || problem !== undefined ? undefined : whyId}
          title={why ?? "Hand in: the proof is kept on the signal, and the work is done"}
          onClick={() => {
            // The tray keeps its files until the hand-in lands: a refusal leaves them to send again.
            if (ready) onHandIn({ text: text.trim(), links, files });
          }}
        >
          Hand in
        </Button>
      </div>
    </div>
  );
}
