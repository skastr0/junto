import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { ulid } from "ulid";
import { titleOf } from "@shared/model/title";
import type { NodeId } from "@shared/physics/schema";
import type { ContentRef } from "@shared/wire/content-ref";
import type { SignalActionResult } from "../../lib/agent-signals-view";
import { useAttachments } from "../../lib/operator-attachments";
import {
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
import { Button, ConfirmDialog, Textarea } from "../ui";
import { useSignalAction } from "./SignalReply";
import "./signal-work.css";

type FormOf<K extends SignalForm["kind"]> = Extract<SignalForm, { readonly kind: K }>;

/**
 * The operator's work, done in the signal (plan 0.11/07, N3). An artifact
 * form is a document written here, in the editor documents use, with its
 * word condition filling as the operator writes; it is handed in once the
 * condition holds and becomes the document in its Artifacts node. A proof
 * form is what was done, with links and files. Writing not handed in is
 * kept while the window runs. Dismissing work is deliberate: it asks first,
 * and the work closes undone.
 */
export function SignalWorkForm({
  signalId,
  canvasName,
  text,
  form,
  handIn,
  dismiss,
  onDone,
}: {
  readonly signalId: string;
  readonly canvasName: string;
  /** The signal's own sentence: what the work is. */
  readonly text: string;
  readonly form: FormOf<"artifact"> | FormOf<"proof">;
  readonly handIn: (signalId: string, reply: WorkReply) => Promise<SignalActionResult>;
  readonly dismiss: (signalId: string) => Promise<SignalActionResult>;
  readonly onDone: () => void;
}) {
  const [asking, setAsking] = useState(false);
  const { pending, error, act } = useSignalAction(() => {
    keepWorkDraft(signalId, "");
    onDone();
  });
  // One id per hand-in attempt: a retry after a failure that did land is not a second document.
  const [replyId] = useState(() => ulid());
  const send = (reply: WorkReply): void => {
    if (pending === null) void act("", () => handIn(signalId, reply));
  };
  const dismissal = (
    <>
      <Button size="xs" variant="subtle" disabled={pending !== null} onClick={() => setAsking(true)}>
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
      canvasName={canvasName}
      busy={pending !== null}
      dismissal={dismissal}
      failure={failure}
      onHandIn={(proof) => send({ kind: "proof", ...proof, replyId })}
    />
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
  return (
    <div className="signal-work" data-testid="signal-work-form" data-form="artifact">
      <p className="signal-work__where">
        Becomes <span className="signal-work__title">{form.title}</span>
        {shelf ? ` in ${titleOf(shelf)}` : null}
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
        <span className="signal-work__count">{counted}</span>
      </div>
      {/* Said once, as the condition comes to hold, not on every word. */}
      <span className="sr-only" role="status">
        {progress.met && progress.min > 1 ? "Enough words to hand in." : ""}
      </span>
      {failure}
      <div className="signal-work__actions">
        {dismissal}
        <Button
          size="xs"
          variant="primary"
          aria-disabled={!progress.met || busy}
          title={progress.met ? "Hand in: the writing becomes the document, and the work is done" : `${short} more ${short === 1 ? "word" : "words"} to hand in`}
          onClick={() => {
            if (progress.met && !busy) onHandIn(markdown);
          }}
        >
          Hand in
        </Button>
      </div>
    </div>
  );
}

function ProofWork({
  canvasName,
  busy,
  dismissal,
  failure,
  onHandIn,
}: {
  readonly canvasName: string;
  readonly busy: boolean;
  readonly dismissal: ReactNode;
  readonly failure: ReactNode;
  readonly onHandIn: (proof: { readonly text: string; readonly links: ReadonlyArray<string>; readonly files: ReadonlyArray<ContentRef> }) => void;
}) {
  const [text, setText] = useState("");
  const [typedLinks, setTypedLinks] = useState("");
  const attachments = useAttachments(canvasName);
  const { links, problem } = proofLinksOf(typedLinks);
  const files = attachments.ready ?? [];
  const filesIn = attachments.ready !== undefined;
  const something = text.trim() !== "" || links.length > 0 || files.length > 0;
  const ready = something && problem === undefined && filesIn && !busy;
  const why = problem ?? (!filesIn ? "Waiting for the files to attach" : something ? undefined : "Say what you did, or add a link or a file");
  return (
    <div className="signal-work" data-testid="signal-work-form" data-form="proof" {...attachments.dropTarget}>
      <Textarea
        dense
        rows={3}
        value={text}
        aria-label="What you did"
        placeholder="What you did"
        onChange={(event) => setText(event.target.value)}
      />
      <Textarea
        dense
        rows={2}
        value={typedLinks}
        spellCheck={false}
        aria-label="Links, one per line"
        aria-invalid={problem !== undefined || undefined}
        placeholder="Links, one per line"
        onChange={(event) => setTypedLinks(event.target.value)}
      />
      {problem ? (
        <p className="signal-work__error" role="alert">
          {problem}
        </p>
      ) : null}
      <AttachmentTray attachments={attachments} />
      {failure}
      <div className="signal-work__actions">
        <span className="mr-auto flex">
          <AttachButton attachments={attachments} disabled={busy} />
        </span>
        {dismissal}
        <Button
          size="xs"
          variant="primary"
          aria-disabled={!ready}
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
