/**
 * A file's comments (0.11 F7): the rail that lists its threads, and the rows
 * drawn between the code editor's lines for a thread.
 *
 * One rail composer takes every comment on the open file: a press on the
 * gutter's plus puts a lines anchor in it, a box drawn on an image or a PDF
 * page puts a page box in it, and with neither it comments on the whole file.
 * One thread is one row (`thread:<id>`) after the last line it hangs on, a
 * glance that brings the thread up in the rail; the row follows its line as
 * text is typed above it, because the thread's place is read again from its
 * quote on every edit (`file-comments.ts`).
 */
import { MessageSquare } from "lucide-react";
import type { MentionRef } from "@shared/mention";
import type { NodeKind } from "@shared/model/kinds";
import type { NodeId } from "@shared/physics/schema";
import type { Anchor, FilePlaceAnchor } from "@shared/thread-subject";
import type { MentionCandidate } from "../../lib/mention-draft";
import { postFileComment, type SubjectThread } from "../../lib/subject-threads-source";
import { filePlaceOf, placeLabel, type FileThreadPlace } from "../../lib/file-comments";
import { ArtifactComments, ARTIFACT_RAIL_WORDS, type CommentsRailWords } from "../artifacts/ArtifactComments";
import "./file-comments.css";

/**
 * A file's rail words: the file, its places as they stand in the text now (a
 * thread that moved says where it moved to), and the seats in its folder.
 */
export const fileRailWords = (placeOf: (anchor: Anchor | undefined) => FileThreadPlace, paged: boolean): CommentsRailWords => ({
  ...ARTIFACT_RAIL_WORDS,
  subject: "file",
  reach: "this folder",
  place: (anchor) => placeLabel(placeOf(anchor), paged),
});

/** Everything a file's comments read and write. */
export type FileCommentContext = {
  readonly canvasName: string;
  readonly nodeId: NodeId;
  readonly path: string;
  /** The file's text as it stands: a thread's place is read from it. */
  readonly text: string;
  /** The file is read as pages (a PDF): its boxes are on numbered pages, not on an image. */
  readonly paged: boolean;
  readonly now: number;
  readonly seatName?: (nodeId: string) => string | undefined;
  readonly mentionable: ReadonlyArray<MentionCandidate>;
  readonly nodeKindOf: (nodeId: NodeId) => NodeKind | undefined;
  readonly onOpenMention: (ref: MentionRef) => void;
};

/** A place on a file, from its anchor and the file's text as it stands. */
export const filePlaceIn = (context: FileCommentContext, anchor: Anchor | undefined): FileThreadPlace =>
  filePlaceOf(anchor, context.text);

/**
 * The comments rail of a file: its threads in time order, each named by where
 * it hangs now, one composer for a comment on the place the operator picked
 * (lines, a box, or the whole file), and the folder's seats as the mentions a
 * comment may name.
 */
export function FileCommentsRail({
  context,
  threads,
  draft,
  onPosted,
  onCleared,
  onClose,
}: {
  readonly context: FileCommentContext;
  readonly threads: ReadonlyArray<SubjectThread>;
  /** The place a press picked, waiting for its comment; absent, the whole file. */
  readonly draft?: FilePlaceAnchor | undefined;
  /** A comment landed: the draft is spent. */
  readonly onPosted: () => void;
  readonly onCleared: () => void;
  readonly onClose: () => void;
}) {
  return (
    <div className="file-comments-rail">
      <ArtifactComments
        canvasName={context.canvasName}
        mentionable={context.mentionable}
        threads={threads}
        nodeKindOf={context.nodeKindOf}
        onOpenMention={context.onOpenMention}
        seatName={context.seatName}
        draftAnchor={draft}
        now={context.now}
        words={fileRailWords((anchor) => filePlaceIn(context, anchor), context.paged)}
        onStart={async (text, anchor) => {
          const refused = await postFileComment(
            context.canvasName,
            { kind: "file", nodeId: context.nodeId, path: context.path },
            { text, ...(anchor === undefined ? {} : { anchor }) },
          );
          if (refused === null) onPosted();
          return refused;
        }}
        onReply={(threadId, text) =>
          postFileComment(context.canvasName, { kind: "file", nodeId: context.nodeId, path: context.path }, { text, threadId })
        }
        onClearAnchor={onCleared}
        onCollapse={onClose}
      />
    </div>
  );
}

/**
 * A thread drawn after its last line: a glance that says where it hangs and
 * how much is said there, and that brings the thread up in the rail when
 * pressed. Reading and answering happen in the rail, one place for both.
 */
export function FileThreadRow({
  thread,
  place,
  onOpen,
}: {
  readonly thread: SubjectThread;
  readonly place: FileThreadPlace;
  readonly onOpen: () => void;
}) {
  const first = thread.posts[0];
  return (
    <button type="button" className="file-comment-row" data-testid="file-comment-row" data-thread-id={thread.threadId} onClick={onOpen}>
      <span className="file-comment-row__head">
        <MessageSquare size={12} aria-hidden />
        <span className="file-comment-row__place">{placeLabel(place)}</span>
        <span className="file-comment-row__count">
          {thread.posts.length} {thread.posts.length === 1 ? "comment" : "comments"}
        </span>
      </span>
      {first === undefined ? null : <span className="file-comment-row__text">{first.text}</span>}
    </button>
  );
}
