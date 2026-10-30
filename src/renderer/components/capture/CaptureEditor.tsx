import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { Undo2 } from "lucide-react";
import {
  type ArtifactBody,
  type ArtifactEdit,
  type ArtifactOp,
  type ArtifactVersion,
  emptyBody,
  FIRST_ARTIFACT_VERSION,
  padOf,
  type TextPatch,
} from "@shared/artifact";
import type { MentionOf } from "@shared/mention";
import type { NodeId } from "@shared/physics/schema";
import type { ArtifactHead } from "@shared/resource-ipc";
import { type ItemId, mintItemId } from "@shared/resource-command";
import { applyArtifactOp, type ArtifactRuling, refusalLine, useHeadBody, useNodeArtifacts } from "../../lib/artifacts-source";
import { useArtifactsInReach } from "../../lib/artifacts-in-reach";
import { useResourcesInReach, useSeatsInReach } from "../../lib/mention-sources";
import { mentionItemsOf, useCanvasArtifacts } from "../../lib/mention-items";
import { useCanvasTasks } from "../../lib/tasks-source";
import { nodeAt } from "../../lib/use-model";
import { titleOf } from "@shared/model/title";
import { Button, Dropdown } from "../ui";
import { ArtifactPadEditor } from "../artifacts/ArtifactPadEditor";
import { FilePreview, LinkPreview } from "../artifacts/ArtifactPreview";
import { ArtifactSheetEditor, type SheetCellLinks } from "../artifacts/ArtifactSheetEditor";
import type { DocumentMentions, DocumentPlaceHandle } from "../artifacts/DocumentEditor";
import { DocumentEditor } from "../artifacts/lazy-editors";
import {
  CAPTURE_TYPES,
  type CaptureType,
  captureTitleOf,
  captureTypeName,
  convertCapture,
  isCaptureType,
  isEmptyCapture,
  UNTITLED_CAPTURE,
} from "./capture-model";
import { captureDraftOf, captureDraftWriter } from "./capture-draft";
import "../artifacts/artifacts.css";
import "./capture-editor.css";

/** What the right half writes: a new capture, or an artifact edited in place. */
export type CaptureOpen =
  | { readonly kind: "new"; readonly key: number }
  | { readonly kind: "artifact"; readonly nodeId: NodeId; readonly artifactId: ItemId };

/** The artifact a capture is, where it is now. */
export type CaptureRef = { readonly nodeId: NodeId; readonly artifactId: ItemId };
export type CaptureArtifactRef = CaptureRef;

/** Puts every word written on disk and answers the artifact they landed in; null while they rest in the kept draft. Never rejects. */
export type CaptureFlush = () => Promise<CaptureArtifactRef | null>;

/** Where the operator was in the writing, for the desk's view state. */
export type CaptureView = {
  /** The caret offset and scroll of the writing; null while no document editor is in. */
  readonly read: () => { readonly caret: number | null; readonly scroll: number } | null;
  /** Put them back once the body is in; asked before that, it waits for it. */
  readonly restore: (view: { readonly caret: number; readonly scroll: number }) => void;
};

/** One type switch, as undo takes it back: the type it left and the artifact it archived, if one was made. */
type Switch = { readonly from: CaptureType; readonly archived: CaptureRef | null };

/** The version a capture not yet made is written against: one before its first. */
const UNMADE = (FIRST_ARTIFACT_VERSION - 1) as ArtifactVersion;

const NO_INBOX = "There is no Inbox yet, so this is kept as a draft. Pick one in Settings and it is saved there.";

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
 * keystroke with words; the rest saves at each rest and on close. Every
 * change is also kept on disk as the canvas's draft (capture-draft.ts), so
 * words written before there is an Inbox, or still resting, survive a close,
 * a quit or a kill, and come back as the writing opens. Its title is its
 * first line, shown once, in the writing. The head says where it lives and
 * switches an Inbox capture to a pad or a sheet (capture-model.ts: a new
 * artifact made from its words, the old one archived, and the undo beside it
 * puts the old one back). Moving it is the desk's Move to column; the writing
 * follows it to its new node.
 *
 * Seats are unchanged: what a document may mention is reach from the node it
 * is on, as in the node.
 */
export function CaptureEditor({
  canvasName,
  inbox,
  open,
  onArtifact,
  flushRef,
  viewRef,
}: {
  readonly canvasName: string;
  /** The canvas's Inbox (Q4, `useCaptureInbox`); a new capture with none is kept as a draft, never guessed. */
  readonly inbox: NodeId | undefined;
  readonly open: CaptureOpen;
  readonly onArtifact?: (ref: CaptureRef | null) => void;
  /** Set to this writing's flush while it is mounted, and to the last one's answer after. */
  readonly flushRef?: MutableRefObject<CaptureFlush | null>;
  readonly viewRef?: MutableRefObject<CaptureView | null>;
}) {
  // An artifact is the same writing wherever it is moved to: only its id keys it.
  const key = open.kind === "new" ? `new\u0000${String(open.key)}` : open.artifactId;
  // A new `open` is a new capture: nothing of the last one's state carries over.
  return (
    <CaptureWriter key={key} canvasName={canvasName} inbox={inbox} open={open} onArtifact={onArtifact} flushRef={flushRef} viewRef={viewRef} />
  );
}

function CaptureWriter({
  canvasName,
  inbox,
  open,
  onArtifact,
  flushRef,
  viewRef,
}: {
  readonly canvasName: string;
  readonly inbox: NodeId | undefined;
  readonly open: CaptureOpen;
  readonly onArtifact: ((ref: CaptureRef | null) => void) | undefined;
  readonly flushRef: MutableRefObject<CaptureFlush | null> | undefined;
  readonly viewRef: MutableRefObject<CaptureView | null> | undefined;
}) {
  const [current, setCurrentState] = useState<CaptureRef | null>(open.kind === "artifact" ? { nodeId: open.nodeId, artifactId: open.artifactId } : null);
  /** Read ahead of a re-render: a write chained after a create must find it. */
  const currentRef = useRef(current);
  /** The body this window last made, shown until its head is listed, so the editor never remounts on a create. */
  const [madeBody, setMadeBody] = useState<ArtifactBody | null>(null);
  /** Its title, shown until the head lists, so the field never blanks after a switch. */
  const [madeTitle, setMadeTitle] = useState<string | null>(null);
  const setCurrent = (next: CaptureRef | null, made: ArtifactBody | null = null, title: string | null = null): void => {
    currentRef.current = next;
    setCurrentState(next);
    setMadeBody(made);
    setMadeTitle(title);
    onArtifact?.(next);
  };
  /** The type a capture not yet made starts as. */
  const [startType, setStartType] = useState<CaptureType>("document");
  const [switches, setSwitches] = useState<ReadonlyArray<Switch>>([]);
  const [line, setLine] = useState<string | null>(null);
  /** The capture is kept: said once, quietly, until the next keystroke. */
  const [saved, setSaved] = useState(false);

  const node = current?.nodeId ?? inbox;
  const heads = useNodeArtifacts(canvasName, (node ?? "") as NodeId);
  const head = current === null ? undefined : heads.find((one) => one.artifact.artifactId === current.artifactId);
  const listedBody = useHeadBody(canvasName, head ?? NO_HEAD);
  const body: ArtifactBody | null = current === null ? emptyBody(startType) : head !== undefined ? listedBody : madeBody;

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

  /** The words kept on disk at every change; `kept` counts the changes, so a save knows whether it caught the last. */
  const drafts = useMemo(() => captureDraftWriter(canvasName), [canvasName]);
  const kept = useRef(0);
  /** A kept draft of this writing, read once as it opens: the words a close, a quit or a kill left unsent. */
  const [unsent] = useState<string | undefined>(() => {
    const held = captureDraftOf(canvasName);
    if (held === undefined || held.text.trim() === "") return undefined;
    const mine = open.kind === "new" ? held.of === null : held.of === open.artifactId;
    return mine ? held.text : undefined;
  });
  // The words brought back are the draft until the first keystroke.
  if (unsent !== undefined && kept.current === 0 && draft.current.text === "") {
    draft.current = { of: open.kind === "artifact" ? open.artifactId : null, text: unsent };
  }
  /** Clear the kept draft once a save holds every word written: nothing was typed since `at`. */
  const settle = (at: number): void => {
    if (kept.current === at) drafts.write(null);
  };

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
    // The head says a capture is kept; a refusal says why instead.
    setSaved(ruling.kind === "applied" || ruling.kind === "queued");
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

  const titleFor = (made: ArtifactBody): string => (made.type === "document" ? captureTitleOf(made.markdown) : undefined) || UNTITLED_CAPTURE;

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
    setCurrent(ref, made, title);
    return ref;
  };

  /** The title follows the first line: retitle when a saved draft changes it. */
  const followTitle = (text: string): void => {
    const ref = currentRef.current;
    if (ref === null || follows.current !== true) return;
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
  const patchDocument = (base: ArtifactVersion, patches: ReadonlyArray<TextPatch>): Promise<string | null> => {
    // The editor sends the draft as it stands: no change after this one is in it.
    const at = kept.current;
    return queue(async () => {
      const ref = currentRef.current;
      if (ref === null || base === UNMADE) {
        const text = spliced("", patches);
        const made = await make({ type: "document", markdown: text });
        if (typeof made === "string") return made;
        settle(at);
        return null;
      }
      const ruling = await apply(ref, { op: "edit", edit: { kind: "patch", type: "document", baseVersion: base, patches: [...patches] } });
      landed(ruling);
      const refused = refusalLine(ruling);
      if (refused === null) {
        followTitle(wordsNow());
        settle(at);
      }
      return refused;
    });
  };

  const type = head?.artifact.type ?? (current === null ? startType : (madeBody?.type ?? startType));
  const readOnly = head?.artifact.archived === true;

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
      // The title last written, not the head this click saw: a retitle queued just before may not have listed yet.
      const title = lastTitle.current || head?.artifact.title || titleFor(words);
      const created = await apply(made, {
        op: "create",
        title,
        body: converted,
        ...(head === undefined || head.artifact.labels.length === 0 ? {} : { labels: [...head.artifact.labels] }),
      });
      if (created.kind === "refused") return;
      // Made before the old one is archived: a refusal between leaves both, never neither.
      await apply(ref, { op: "archive" });
      setSwitches((all) => [...all, { from, archived: ref }]);
      headVersion.current = FIRST_ARTIFACT_VERSION;
      lastTitle.current = title;
      setCurrent(made, converted, title);
    });
  };

  const undo = async (): Promise<void> => {
    const last = switches[switches.length - 1];
    if (last === undefined) return;
    await queue(async () => {
      const now = currentRef.current;
      // The old one comes back first: a refusal here leaves everything as it was, and Back can be pressed again.
      if (last.archived !== null) {
        const restored = await apply(last.archived, { op: "restore" });
        if (restored.kind === "refused") return;
      }
      // Then what the switch made, with anything written in it since, is archived. Refused, both stay
      // live, never neither; the old one is back either way, so the switch is spent.
      if (now !== null) await apply(now, { op: "archive" });
      lastTitle.current = undefined;
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

  // The writing follows its artifact: moved from the desk's Move to column, or by anyone, it keeps writing there.
  const everything = useCanvasArtifacts(canvasName);
  const listedAt = current === null ? undefined : everything.find((one) => one.artifact.artifactId === current.artifactId)?.artifact.nodeId;
  useEffect(() => {
    if (current === null || listedAt === undefined || listedAt === current.nodeId) return;
    setCurrent({ nodeId: listedAt as NodeId, artifactId: current.artifactId }, body, head?.artifact.title ?? lastTitle.current ?? null);
    // setCurrent is this render's; the move is the only cause.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listedAt]);

  // Words kept while there was no Inbox are saved the moment there is one.
  useEffect(() => {
    if (inbox !== undefined && currentRef.current === null && draft.current.text.trim() !== "") void saveDocument.current?.();
  }, [inbox]);

  // The flush the desk awaits, and once this writing is gone, its last answer.
  useEffect(() => {
    if (flushRef === undefined) return;
    const flush: CaptureFlush = async () => {
      try {
        await saveDocument.current?.();
        await chain.current;
      } catch {
        // A refused or unanswered save keeps the words in the draft; the answer says where they are.
      }
      await drafts.settled();
      return currentRef.current;
    };
    flushRef.current = flush;
    return () => {
      // Closing sent what was unsent; the answer waits for that send to land.
      const closing = chain.current;
      flushRef.current = async () => {
        await closing.catch(() => undefined);
        await drafts.settled();
        return currentRef.current;
      };
    };
  });

  // Where the operator was in the writing: read now, or put back once the engine is in.
  const place = useRef<DocumentPlaceHandle | null>(null);
  const pendingPlace = useRef<{ readonly caret: number; readonly scroll: number } | null>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (viewRef === undefined) return;
    viewRef.current = {
      read: () => place.current?.read() ?? null,
      restore: (view) => {
        if (place.current?.restore(view) === true) return;
        pendingPlace.current = view;
      },
    };
    return () => {
      viewRef.current = null;
    };
  });
  useEffect(() => {
    const surface = surfaceRef.current;
    if (surface === null) return;
    const tryPlace = (): boolean => {
      const view = pendingPlace.current;
      if (view === null) return true;
      if (place.current?.restore(view) !== true) return false;
      pendingPlace.current = null;
      return true;
    };
    if (tryPlace()) return;
    // The engine loads lazily: the place waits for its lines to exist.
    const observer = new MutationObserver(() => {
      if (tryPlace()) observer.disconnect();
    });
    observer.observe(surface, { childList: true, subtree: true });
    return () => observer.disconnect();
  });

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
            placeRef={place}
            unsent={unsent}
            placeholder="Write it down. The first line becomes the title."
            onDraft={(text) => {
              draft.current = { of: currentRef.current?.artifactId ?? null, text };
              kept.current += 1;
              const ref = currentRef.current;
              drafts.write({
                of: ref?.artifactId ?? null,
                node: ref?.nodeId ?? null,
                text,
                base: ref === null || headVersion.current === UNMADE ? null : headVersion.current,
                at: Date.now(),
              });
              setSaved(false);
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
  const where = (() => {
    const at = current?.nodeId ?? inbox;
    if (at === undefined) return "No Inbox yet";
    if (at === inbox) return "Inbox";
    const node = nodeAt(canvasName, at);
    return node === undefined ? "Inbox" : titleOf(node);
  })();
  return (
    <div className="capture-editor">
      {/* Where it lives, its type, and that it is kept: the title is its first line, in the writing, once. */}
      <header className="artifact-head capture-editor__head">
        <span className="capture-editor__where">{where}</span>
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
        {saved ? (
          <span className="capture-editor__saved" role="status">
            Saved
          </span>
        ) : null}
      </header>
      {line ? (
        <p className="capture-editor__line" role="status">
          {line}
        </p>
      ) : null}
      <div className="capture-editor__surface" data-capture-entry="" ref={surfaceRef}>
        {/* One editor per type and switch: a create never remounts it, a switch always does. */}
        <div key={`${type}\u0000${String(switches.length)}`} className="capture-editor__fill">
          {editor}
        </div>
      </div>
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
