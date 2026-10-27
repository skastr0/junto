/**
 * The subject comment contract: a comment names its resource and, beside it,
 * an anchor narrowed to that kind, so an anchor that does not fit fails tsc.
 */
import { Schema } from "effect";
import { describe, expect, expectTypeOf, it } from "vitest";
import { ContentRef } from "../src/shared/wire/content-ref";
import type { MailMessageId } from "../src/shared/crew";
import { asNodeId } from "../src/shared/physics/schema";
import {
  commentSubjectOf,
  commentThreadOf,
  subjectCommentId,
  subjectReplyOf,
  type CommentAnchorFor,
  type PageBoxRequest,
  type SubjectCommentInput,
} from "../src/shared/subject-comment";
import type { ArtifactPlaceAnchor, FilePlaceAnchor } from "../src/shared/thread-subject";
import { isMailMessageId } from "../src/shared/crew";
import { ItemId, OpId } from "../src/shared/work-ids";

const NODE = asNodeId("node-1");
const ID = ItemId.make("01M5ESKX20QX0HA3Y6SHEPXBCX");
const OP = OpId.make("01M5ESMJV6GNZ0891YFFWS0S3P");
const actor = { kind: "operator" } as const;
const base = { text: "looks off", actor, opId: OP };

describe("subject comment contract", () => {
  it("carries the anchor into the subject, and a whole resource as none", () => {
    expect(commentSubjectOf({ ...base, subject: { kind: "artifact", nodeId: NODE, artifactId: ID }, anchor: { kind: "cells", range: "B2" } }))
      .toEqual({ kind: "artifact", nodeId: NODE, artifactId: ID, anchor: { kind: "cells", range: "B2" } });
    expect(commentSubjectOf({ ...base, subject: { kind: "page", nodeId: NODE } })).toEqual({ kind: "page", nodeId: NODE });
    expect(commentSubjectOf({ ...base, subject: { kind: "task", nodeId: NODE, taskId: ID } })).toEqual({ kind: "task", nodeId: NODE, taskId: ID });
    expect(commentSubjectOf({ ...base, subject: { kind: "file", nodeId: NODE, path: "src/a.ts" }, anchor: { kind: "lines", file: "src/a.ts", from: 2, to: 3 } }))
      .toEqual({ kind: "file", nodeId: NODE, path: "src/a.ts", anchor: { kind: "lines", file: "src/a.ts", from: 2, to: 3 } });
    expect(commentSubjectOf({ ...base, subject: { kind: "file", nodeId: NODE, path: "docs/a.pdf" }, anchor: { kind: "pageBox", page: 2, x: 0, y: 0, w: 0.5, h: 0.25 } }))
      .toEqual({ kind: "file", nodeId: NODE, path: "docs/a.pdf", anchor: { kind: "pageBox", page: 2, x: 0, y: 0, w: 0.5, h: 0.25 } });
  });

  it("posts a reply in a subject thread as a comment on that kind, without the thread's anchor", () => {
    const write = { ...base, threadId: "thread-1" as MailMessageId };
    expect(subjectReplyOf({ kind: "task", nodeId: NODE, taskId: ID }, write).subject).toEqual({ kind: "task", nodeId: NODE, taskId: ID });
    expect(subjectReplyOf({ kind: "artifact", nodeId: NODE, artifactId: ID, anchor: { kind: "cells", range: "B2" } }, write))
      .toEqual({ ...write, subject: { kind: "artifact", nodeId: NODE, artifactId: ID } });
    expect(subjectReplyOf({ kind: "page", nodeId: NODE }, write).subject).toEqual({ kind: "page", nodeId: NODE });
    // A file reply keeps the file's path: it is how the thread finds its file again.
    expect(subjectReplyOf({ kind: "file", nodeId: NODE, path: "src/a.ts", anchor: { kind: "lines", file: "src/a.ts", from: 2, to: 3 } }, write))
      .toEqual({ ...write, subject: { kind: "file", nodeId: NODE, path: "src/a.ts" } });
    const shot = Schema.decodeUnknownSync(ContentRef)({ sha256: "a".repeat(64), byteLength: 10, mediaType: "image/png" });
    const box = { kind: "box", x: 0, y: 0, w: 1, h: 1, url: "https://x.example/", scroll: { x: 0, y: 0 }, shot } as const;
    expect(subjectReplyOf({ kind: "page", nodeId: NODE, anchor: box }, write)).toEqual({ ...write, subject: { kind: "page", nodeId: NODE } });
  });

  it("derives the comment's id from (installation, opId), and its thread from the subject", () => {
    const input: SubjectCommentInput = { ...base, subject: { kind: "page", nodeId: NODE } };
    const id = subjectCommentId("inst-1", input);
    expect(isMailMessageId(id)).toBe(true);
    expect(subjectCommentId("inst-1", input)).toBe(id);
    expect(subjectCommentId("inst-2", input)).not.toBe(id);
    expect(commentThreadOf(input, id)).toBe(id);
    expect(commentThreadOf({ ...input, threadId: "01M5ESQ6X9VS1GKZHNAS6BKJ49" as MailMessageId }, id)).toBe("01M5ESQ6X9VS1GKZHNAS6BKJ49");
    expect(commentThreadOf({ ...base, subject: { kind: "task", nodeId: NODE, taskId: ID } }, id)).toBe(ID);
  });

  it("types: an anchor that does not fit its subject does not compile", () => {
    expectTypeOf<CommentAnchorFor<"task">>().toBeNever();
    expectTypeOf<CommentAnchorFor<"artifact">>().toEqualTypeOf<ArtifactPlaceAnchor>();
    expectTypeOf<CommentAnchorFor<"page">>().toEqualTypeOf<PageBoxRequest>();
    expectTypeOf<CommentAnchorFor<"file">>().toEqualTypeOf<FilePlaceAnchor>();
    const misuse = (): ReadonlyArray<SubjectCommentInput> => [
      // @ts-expect-error a task is commented whole
      { ...base, subject: { kind: "task", nodeId: NODE, taskId: ID }, anchor: { kind: "cells", range: "B2" } },
      // @ts-expect-error an artifact is never anchored to lines
      { ...base, subject: { kind: "artifact", nodeId: NODE, artifactId: ID }, anchor: { kind: "lines", file: "a", from: 1, to: 1 } },
      // @ts-expect-error a file's lines are its own, never a browser page's url box
      { ...base, subject: { kind: "file", nodeId: NODE, path: "a.ts" }, anchor: { kind: "box", x: 0, y: 0, w: 1, h: 1 } },
      // @ts-expect-error the whole resource is no anchor
      { ...base, subject: { kind: "page", nodeId: NODE }, anchor: { kind: "whole" } },
      // @ts-expect-error the anchor rides beside the subject, not in it
      { ...base, subject: { kind: "page", nodeId: NODE, anchor: { kind: "cells", range: "B2" } } },
      // @ts-expect-error a comment needs its opId
      { text: "x", actor, subject: { kind: "page", nodeId: NODE } },
    ];
    expect(misuse).toBeTypeOf("function");
  });
});
