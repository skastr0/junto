import { useCallback, useMemo, useRef, useState } from "react";
import { FolderInput, Undo2 } from "lucide-react";
import {
  type ArtifactBody,
  type ArtifactEdit,
  type ArtifactOp,
  type ArtifactVersion,
  artifactText,
  emptyBody,
  FIRST_ARTIFACT_VERSION,
  padOf,
  type TextPatch,
} from "@shared/artifact";
import { captureRoutes, routeReasonLine } from "@shared/capture-routes";
import type { MentionOf } from "@shared/mention";
import type { NodeId } from "@shared/physics/schema";
import type { ArtifactHead } from "@shared/resource-ipc";
import { type ItemId, mintItemId } from "@shared/resource-command";
import { applyArtifactOp, type ArtifactRuling, refusalLine, useHeadBody, useNodeArtifacts } from "../../lib/artifacts-source";
import { useArtifactsInReach } from "../../lib/artifacts-in-reach";
import { useResourcesInReach, useSeatsInReach } from "../../lib/mention-sources";
import { mentionItemsOf, useCanvasArtifacts } from "../../lib/mention-items";
import { useCanvasTasks } from "../../lib/tasks-source";
import { nodeAt, useCanvas } from "../../lib/use-model";
import { releaseFocus } from "../../lib/focus-ownership";
import { Button, Dropdown, ResourceGlyphMark } from "../ui";
import { ArtifactMoveDialog } from "../artifacts/ArtifactMove";
import { movedLine } from "../artifacts/artifact-move-model";
import { ArtifactPadEditor } from "../artifacts/ArtifactPadEditor";
import { FilePreview, LinkPreview } from "../artifacts/ArtifactPreview";
import { ArtifactSheetEditor, type SheetCellLinks } from "../artifacts/ArtifactSheetEditor";
import type { DocumentMentions } from "../artifacts/DocumentEditor";
import { DocumentEditor } from "../artifacts/lazy-editors";
import { CAPTURE_TYPES, type CaptureType, captureTitleOf, captureTypeName, convertCapture, isCaptureType, isEmptyCapture, UNTITLED_CAPTURE } from "./capture-model";
import "../artifacts/artifacts.css";
import "./capture-editor.css";

/** What the right half writes: a new capture, or an artifact edited in place. */
export type CaptureOpen =
  | { readonly kind: "new"; readonly key: number }
  | { readonly kind: "artifact"; readonly nodeId: NodeId; readonly artifactId: ItemId };

/** The artifact a capture is, where it is now. */
export type CaptureRef = { readonly nodeId: NodeId; readonly artifactId: ItemId };

/** One type switch, as undo takes it back: the type it left and the artifact it archived, if one was made. */
type Switch = { readonly from: CaptureType; readonly archived: CaptureRef | null };

/** The version a capture not yet made is written against: one before its first. */
const UNMADE = (FIRST_ARTIFACT_VERSION - 1) as ArtifactVersion;

const NO_INBOX = "Pick an Inbox in Settings first: there is nowhere for this capture to go.";

/** A head to read when there is none: its body is held, so nothing is fetched for it. */
const NO_HEAD = {
  artifact: { artifactId: "", version: FIRST_ARTIFACT_VERSION },
  body: { type: "document", markdown: "" },
  bodyRef: null,
} as unknown as ArtifactHead;

/** `patches` applied to `text`, in order. */
const spliced = (text: string, patches: ReadonlyArray<TextPatch>): string =>
  patches.reduce((out, patch) => out.slice(0, patch.at) + patch.insert + out.slice(patch.at + patch.remove), text);

/**
 * Quick capture's right half (docs/plans/0.11/11-quick-capture.md, Q2 and
 * Q5), on the seam the surface (Q1) holds: `open` says what to write, and
 * `onArtifact` says which artifact it is, each time that changes.
 *
 * A new capture is a document in the canvas's Inbox from its first
 * keystroke with words; the rest saves at each rest and on close, so nothing
 * written is lost. Its title is its first line until one is typed. The
 * header switches an Inbox capture to a pad or a sheet (capture-model.ts: a
 * new artifact made from its words, the old one archived, and the undo
 * beside it puts the old one back), and moves it with Move to, its suggested
 * nodes first.
 *
 * Seats are unchanged: what a document may mention is reach from the node it
 * is on, as in the node.
 */
export function CaptureEditor({
  canvasName,
  inbox,
  open,
  onArtifact,
}: {
  readonly canvasName: string;
  /** The canvas's Inbox (Q4, `useCaptureInbox`); a new capture with none is refused, never guessed. */
  readonly inbox: NodeId | undefined;
  readonly open: CaptureOpen;
  readonly onArtifact?: (ref: CaptureRef | null) => void;
}) {
  const key = open.kind === "new" ? `new\u0000${String(open.key)}` : `${open.nodeId}\u0000${open.artifactId}`;
  // A new `open` is a new capture: nothing of the last one's state carries over.
  return <CaptureWriter key={key} canvasName={canvasName} inbox={inbox} open={open} onArtifact={onArtifact} />;
}

function CaptureWriter({
  canvasName,
  inbox,
  open,
  onArtifact,
}: {
  readonly canvasName: string;
  readonly inbox: NodeId | undefined;
  readonly open: CaptureOpen;
  readonly onArtifact: ((ref: CaptureRef | null) => void) | undefined;
}) {
  const [current, setCurrentState] = useState<CaptureRef | null>(open.kind === "artifact" ? { nodeId: open.nodeId, artifactId: open.artifactId } : null);
  /** Read ahead of a re-render: a write chained after a create must find it. */
  const currentRef = useRef(current);
  /** The body this window last made, shown until its head is listed, so the editor never remounts on a create. */
  const [madeBody, setMadeBody] = useState<ArtifactBody | null>(null);
  const setCurrent = (next: CaptureRef | null, made: ArtifactBody | null = null): void => {
    currentRef.current = next;
    setCurrentState(next);
    setMadeBody(made);
    onArtifact?.(next);
  };
  /** The type a capture not yet made starts as. */
  const [startType, setStartType] = useState<CaptureType>("document");
  const [switches, setSwitches] = useState<ReadonlyArray<Switch>>([]);
  const [line, setLine] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);

  const node = current?.nodeId ?? inbox;
  const heads = useNodeArtifacts(canvasName, (node ?? "") as NodeId);
  const head = current === null ? undefined : heads.find((one) => one.artifact.artifactId === current.artifactId);
  const listedBody = useHeadBody(canvasName, head ?? NO_HEAD);
  const body: ArtifactBody | null = current === null ? emptyBody(startType) : head !== undefined ? listedBody : madeBody;

  /** The title as the operator is typing it; null while none is being typed. */
  const [typedTitle, setTypedTitleState] = useState<string | null>(null);
  const typed = useRef<string | null>(null);
  const setTypedTitle = (next: string | null): void => {
    typed.current = next;
    setTypedTitleState(next);
  };
  /** Whether the title follows the first line: a new capture's does; an artifact read in place, while its title is its first line. */
  const follows = useRef<boolean | null>(open.kind === "new" ? true : null);
  /** The title last written, so an unchanged first line writes nothing. */
  const lastTitle = useRef<string | undefined>(undefined);
  /** The newest draft of a document, and the artifact it is of: a draft of another one is never read for this one. */
  const draft = useRef<{ readonly of: ItemId | null; readonly text: string }>({ of: null, text: "" });
  const saveDocument = useRef<(() => Promise<string | null>) | null>(null);
  /** The document's words as the operator sees them now. */
  const wordsNow = (): string =>
    draft.current.of === currentRef.current?.artifactId ? draft.current.text : body?.type === "document" ? body.markdown : "";

  if (follows.current === null && head !== undefined && listedBody !== null) {
    follows.current = listedBody.type === "document" && head.artifact.title === (captureTitleOf(listedBody.markdown) ?? UNTITLED_CAPTURE);
    lastTitle.current = head.artifact.title;
  }

  /** Writes run one after another, so a create always lands before the write behind it. */
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const queue = <T,>(run: () => Promise<T>): Promise<T> => {
    const next = chain.current.then(run, run);
    chain.current = next.catch(() => undefined);
    return next;
  };

  const apply = async (ref: CaptureRef, op: ArtifactOp): Promise<ArtifactRuling> => {
    const ruling = await applyArtifactOp(canvasName, ref.nodeId, ref.artifactId, op);
    if (op.op !== "edit") setLine(refusalLine(ruling));
    return ruling;
  };

  /** The head an edit is written against, moved by each landed edit before the re-render. */
  const headVersion = useRef<ArtifactVersion>(UNMADE);
  if (head !== undefined && head.artifact.version > headVersion.current) headVersion.current = head.artifact.version as ArtifactVersion;
  const landed = (ruling: ArtifactRuling): void => {
    if (ruling.kind === "queued") headVersion.current = (headVersion.current + 1) as ArtifactVersion;
    if (ruling.kind !== "applied") return;
    for (const fact of ruling.facts) {
      if (fact.fact === "artifact.edited" && fact.version > headVersion.current) headVersion.current = fact.version;
    }
  };

  const titleFor = (made: ArtifactBody): string =>
    typed.current?.trim() || (made.type === "document" ? captureTitleOf(made.markdown) : undefined) || UNTITLED_CAPTURE;

  /** Make the capture in the Inbox with this body: its ref, or the refusal in words. */
  const make = async (made: ArtifactBody): Promise<CaptureRef | string> => {
    if (inbox === undefined) {
      setLine(NO_INBOX);
      return NO_INBOX;
    }
    const ref = { nodeId: inbox, artifactId: mintItemId() };
    const title = titleFor(made);
    const ruling = await apply(ref, { op: "create", title, body: made });
    if (ruling.kind === "refused") return ruling.error.message;
    headVersion.current = FIRST_ARTIFACT_VERSION;
    lastTitle.current = title;
    if (typed.current?.trim()) follows.current = false;
    setCurrent(ref, made);
    return ref;
  };

  /** The title follows the first line: retitle when a saved draft changes it. */
  const followTitle = (text: string): void => {
    const ref = currentRef.current;
    if (ref === null || follows.current !== true || typed.current !== null) return;
    const next = captureTitleOf(text) ?? UNTITLED_CAPTURE;
    if (next === lastTitle.current) return;
    lastTitle.current = next;
    void queue(() => apply(ref, { op: "retitle", title: next }));
  };

  /** A pad's or a sheet's edit, making the capture first, empty, when it is not made yet; a refusal line, or null. */
  const edit = (type: "pad" | "sheet", write: (base: ArtifactVersion) => ArtifactEdit): Promise<string | null> =>
    queue(async () => {
      let ref = currentRef.current;
      if (ref === null) {
        const made = await make(emptyBody(type));
        if (typeof made === "string") return made;
        ref = made;
      }
      const ruling = await apply(ref, { op: "edit", edit: write(headVersion.current) });
      landed(ruling);
      return refusalLine(ruling);
    });

  /** A document's splices: the first makes the capture, from exactly the text they write. */
  const patchDocument = (base: ArtifactVersion, patches: ReadonlyArray<TextPatch>): Promise<string | null> =>
    queue(async () => {
      const ref = currentRef.current;
      if (ref === null || base === UNMADE) {
        const text = spliced("", patches);
        const made = await make({ type: "document", markdown: text });
        return typeof made === "string" ? made : null;
      }
      const ruling = await apply(ref, { op: "edit", edit: { kind: "patch", type: "document", baseVersion: base, patches: [...patches] } });
      landed(ruling);
      const refused = refusalLine(ruling);
      if (refused === null) followTitle(wordsNow());
      return refused;
    });

  const type = head?.artifact.type ?? (current === null ? startType : (madeBody?.type ?? startType));
  const readOnly = head?.artifact.archived === true;

  const commitTitle = (): void => {
    const next = typed.current;
    if (next === null) return;
    const ref = currentRef.current;
    if (next.trim() === "") {
      // Cleared: the title goes back to following the first line.
      setTypedTitle(null);
      follows.current = true;
      followTitle(wordsNow());
      return;
    }
    follows.current = false;
    setTypedTitle(null);
    if (ref !== null && next.trim() !== lastTitle.current) {
      lastTitle.current = next.trim();
      void queue(() => apply(ref, { op: "retitle", title: next.trim() }));
    } else if (ref === null) {
      // Not made yet: the create takes it.
      typed.current = next;
    }
  };

  /** Whether the header offers the type switch: a capture in the Inbox, or one not made yet. */
  const switchable = !readOnly && isCaptureType(type) && (current === null || current.nodeId === inbox);

  const switchTo = async (to: CaptureType): Promise<void> => {
    const from = type;
    if (to === from || !isCaptureType(from)) return;
    if (currentRef.current === null) {
      setStartType(to);
      setSwitches((all) => [...all, { from, archived: null }]);
      return;
    }
    // What still rests in the draft is saved first, so the old one keeps every word.
    if (from === "document") await saveDocument.current?.();
    await queue(async () => {
      const ref = currentRef.current;
      const words: ArtifactBody | null = from === "document" ? { type: "document", markdown: wordsNow() } : body;
      if (ref === null || words === null) return;
      if (isEmptyCapture(words)) {
        const archived = await apply(ref, { op: "archive" });
        if (archived.kind === "refused") return;
        setStartType(to);
        setSwitches((all) => [...all, { from, archived: ref }]);
        headVersion.current = UNMADE;
        setCurrent(null);
        return;
      }
      const made = { nodeId: ref.nodeId, artifactId: mintItemId() };
      const converted = convertCapture(words, to);
      const created = await apply(made, {
        op: "create",
        title: head?.artifact.title ?? titleFor(words),
        body: converted,
        ...(head === undefined || head.artifact.labels.length === 0 ? {} : { labels: [...head.artifact.labels] }),
      });
      if (created.kind === "refused") return;
      // Made before the old one is archived: a refusal between leaves both, never neither.
      await apply(ref, { op: "archive" });
      setSwitches((all) => [...all, { from, archived: ref }]);
      headVersion.current = FIRST_ARTIFACT_VERSION;
      setCurrent(made, converted);
    });
  };

  const undo = async (): Promise<void> => {
    const last = switches[switches.length - 1];
    if (last === undefined) return;
    await queue(async () => {
      const now = currentRef.current;
      // What the switch made, with anything written in it since, is archived; the old one comes back.
      if (now !== null) {
        const archived = await apply(now, { op: "archive" });
        if (archived.kind === "refused") return;
      }
      if (last.archived !== null) {
        const restored = await apply(last.archived, { op: "restore" });
        if (restored.kind === "refused") return;
      }
      setSwitches((all) => all.slice(0, -1));
      setStartType(last.from);
      headVersion.current = UNMADE;
      setCurrent(last.archived);
    });
  };

  const mentions = useCaptureMentions(canvasName, (node ?? "") as NodeId, current?.artifactId ?? null);
  const sheetLinks = useMemo<SheetCellLinks | undefined>(
    () => (mentions.links === undefined ? undefined : { canvasName, links: mentions.links, nodeKindOf: mentions.nodeKindOf }),
    [canvasName, mentions],
  );

  const canvas = useCanvas(canvasName);
  const everything = useCanvasArtifacts(canvasName);
  // Read as Move to opens, from the words as they stand then.
  const suggestions = useMemo(() => {
    if (!moving || current === null || head === undefined || body === null) return [];
    const others = everything.map(({ artifact, body: theirs }) => ({
      artifactId: artifact.artifactId,
      nodeId: artifact.nodeId,
      title: artifact.title,
      text: theirs === null ? "" : artifactText(theirs),
      labels: artifact.labels,
      archived: artifact.archived,
    }));
    const text = body.type === "document" ? wordsNow() : artifactText(body);
    const mine = { artifactId: current.artifactId, nodeId: current.nodeId, title: head.artifact.title, text, labels: head.artifact.labels, archived: false };
    return captureRoutes(canvas, mine, others).map((route) => ({ nodeId: route.nodeId, why: routeReasonLine(route.reasons[0]!) }));
    // wordsNow reads refs: the moment Move to opens is what counts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moving, current, head, body, everything, canvas]);

  const editor = (() => {
    if (body === null) return <p className="capture-editor__wait">{head === undefined ? "Finding it." : "Loading this version."}</p>;
    switch (body.type) {
      case "document":
        return (
          <DocumentEditor
            title={head?.artifact.title ?? "New capture"}
            body={body}
            version={(head?.artifact.version as ArtifactVersion | undefined) ?? (current === null ? UNMADE : FIRST_ARTIFACT_VERSION)}
            readOnly={readOnly}
            mentions={mentions}
            saveRef={saveDocument}
            onDraft={(text) => {
              draft.current = { of: currentRef.current?.artifactId ?? null, text };
              // The first keystroke with words makes the capture at once; the rest waits for a rest.
              return currentRef.current === null && text.trim() !== "";
            }}
            onPatch={patchDocument}
          />
        );
      case "sheet":
        return (
          <ArtifactSheetEditor
            title={head?.artifact.title ?? "New capture"}
            grid={body.grid}
            readOnly={readOnly}
            onPatch={(patches) => edit("sheet", (baseVersion) => ({ kind: "patch", type: "sheet", baseVersion, patches: [...patches] }))}
            cellLinks={sheetLinks}
          />
        );
      case "pad":
        return (
          <ArtifactPadEditor
            canvasName={canvasName}
            pad={padOf(body)}
            readOnly={readOnly}
            onPatch={(patches) => edit("pad", (baseVersion) => ({ kind: "patch", type: "pad", baseVersion, patches: [...patches] }))}
            mentions={mentions}
          />
        );
      case "link":
        return <LinkPreview body={body} />;
      case "file":
        return <FilePreview body={body} />;
    }
  })();

  const last = switches[switches.length - 1];
  return (
    <div className="capture-editor">
      <header className="artifact-head capture-editor__head">
        <ResourceGlyphMark kind="artifact" artifactType={type} size={14} />
        <input
          className="artifact-head__title"
          aria-label="Title"
          placeholder="Title from the first line"
          value={typedTitle ?? (head?.artifact.title ?? (typed.current ?? ""))}
          readOnly={readOnly}
          onChange={(event) => setTypedTitle(event.target.value)}
          onBlur={commitTitle}
          onKeyDown={(event) => {
            if (event.key === "Enter") releaseFocus(event.currentTarget, "gesture");
            if (event.key === "Escape" && typedTitle !== null) {
              // Escape puts the title back; only the next one closes the surface.
              event.stopPropagation();
              setTypedTitle(null);
            }
          }}
        />
        {switchable ? (
          <Dropdown
            aria-label="Type"
            className="capture-editor__type"
            value={type}
            options={CAPTURE_TYPES.map((one) => ({ value: one, label: captureTypeName(one) }))}
            onChange={(value) => {
              if (isCaptureType(value)) void switchTo(value);
            }}
          />
        ) : null}
        {last !== undefined ? (
          <Button size="sm" variant="subtle" onClick={() => void undo()}>
            <Undo2 size={13} aria-hidden />
            Back to {captureTypeName(last.from).toLowerCase()}
          </Button>
        ) : null}
        {current !== null && head !== undefined && !readOnly ? (
          <Button size="sm" variant="chrome" onClick={() => setMoving(true)}>
            <FolderInput size={13} aria-hidden />
            Move to…
          </Button>
        ) : null}
      </header>
      {line ? (
        <p className="capture-editor__line" role="status">
          {line}
        </p>
      ) : null}
      <div className="capture-editor__surface" data-capture-entry="">
        {/* One editor per type and switch: a create never remounts it, a switch always does. */}
        <div key={`${type}\u0000${String(switches.length)}`} className="capture-editor__fill">
          {editor}
        </div>
      </div>
      {moving && current !== null && head !== undefined ? (
        <ArtifactMoveDialog
          canvasName={canvasName}
          from={current.nodeId}
          artifacts={[{ artifactId: current.artifactId, title: head.artifact.title }]}
          suggestions={suggestions}
          onCancel={() => setMoving(false)}
          onDone={(done) => {
            setMoving(false);
            setLine(movedLine(done.titles, done.queued, done.to.title));
            setCurrent({ nodeId: done.to.id, artifactId: current.artifactId });
          }}
        />
      ) : null}
    </div>
  );
}

/** What a capture may mention and link: reach from the node it is on, as in the node. */
const useCaptureMentions = (canvasName: string, nodeId: NodeId, artifactId: ItemId | null): DocumentMentions => {
  const mentionable = useSeatsInReach(canvasName, nodeId);
  const tasks = useCanvasTasks(canvasName);
  const everything = useCanvasArtifacts(canvasName);
  const items = useMemo(() => mentionItemsOf(tasks, everything), [tasks, everything]);
  const resources = useResourcesInReach(canvasName, nodeId, items);
  const inReach = useArtifactsInReach(canvasName, nodeId);
  const linkable = useMemo(() => inReach.filter((other) => other.ref.artifactId !== artifactId), [inReach, artifactId]);
  // A `[[` title that names nothing becomes an empty document beside the capture.
  const create = useCallback(
    async (title: string): Promise<MentionOf<"artifact"> | null> => {
      const made = mintItemId();
      const ruling = await applyArtifactOp(canvasName, nodeId, made, { op: "create", title, body: { type: "document", markdown: "" } });
      return ruling.kind === "refused" ? null : { kind: "artifact", nodeId, artifactId: made };
    },
    [canvasName, nodeId],
  );
  return useMemo<DocumentMentions>(
    () => ({
      canvasName,
      candidates: [...mentionable, ...resources],
      nodeKindOf: (id) => nodeAt(canvasName, id)?.kind,
      links: { artifacts: linkable, create },
    }),
    [canvasName, mentionable, resources, linkable, create],
  );
};
