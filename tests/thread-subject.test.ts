import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { asNodeId } from "../src/shared/physics/schema";
import { ItemId } from "../src/shared/work-ids";
import {
  Anchor,
  type ResourceSubject,
  type ThreadSubject,
  sameSubject,
  subjectNodeOf,
  TEXT_QUOTE_MAX,
  textAnchorOf,
  threadSubjectMetadata,
  threadSubjectOf,
  pageShotOf,
  PageSubject,
} from "../src/shared/thread-subject";
import { ContentRef } from "../src/shared/wire/content-ref";

const SHOT = Schema.decodeUnknownSync(ContentRef)({ sha256: "a".repeat(64), byteLength: 10, mediaType: "image/png" });

const seat = asNodeId("agent-01M4727PH6NV810ND26XQ2WXX2");
const shelf = asNodeId("artifacts-01M5");
const page = asNodeId("page-01M5");
const artifactId = Schema.decodeSync(ItemId)("01M5ESR42S7P9YNR8FEH0TD2QC");

describe("thread subjects", () => {
  it("reads a written subject back as written, and a row with none as mailbox mail", () => {
    const subject: ResourceSubject = { kind: "artifact", nodeId: shelf, artifactId, anchor: { kind: "box", x: 10, y: 20, w: 30, h: 40 } };
    expect(threadSubjectOf({ metadata: { factoryMail: true, ...threadSubjectMetadata(subject) } })).toEqual(subject);
    expect(threadSubjectOf({ metadata: { factoryMail: true } })).toBeUndefined();
    expect(subjectNodeOf(subject)).toBe(shelf);
    expect(subjectNodeOf({ kind: "mailbox", seat })).toBe(seat);
  });

  it("reads a subject stored before the quote bound with its quote cut, so it keeps its thread", () => {
    const stored = { kind: "artifact", nodeId: shelf, artifactId, anchor: { kind: "text", quote: "q".repeat(TEXT_QUOTE_MAX + 500), offset: 4 } };
    expect(threadSubjectOf({ metadata: { threadSubject: stored } })).toEqual({
      ...stored,
      anchor: { kind: "text", quote: "q".repeat(TEXT_QUOTE_MAX), offset: 4 },
    });
  });

  it("cuts a quote at the bound without splitting a character", () => {
    const quote = `${"q".repeat(TEXT_QUOTE_MAX - 1)}😀more`;
    expect(textAnchorOf(quote).quote).toBe("q".repeat(TEXT_QUOTE_MAX - 1));
  });

  it("reads no subject from one that does not decode", () => {
    for (const held of [
      { kind: "folder", nodeId: "x" },
      { kind: "task", nodeId: "task-1" },
      { kind: "task", nodeId: "task-1", taskId: "not-a-ulid" },
      { kind: "page", nodeId: "page-1", extra: true },
      { kind: "mailbox", seat: "agent-1" },
      "task",
    ]) {
      expect(threadSubjectOf({ metadata: { threadSubject: held } }), JSON.stringify(held)).toBeUndefined();
    }
  });

  it("tells two anchors on one page apart", () => {
    const box = (w: number): ThreadSubject => ({
      kind: "page",
      nodeId: page,
      anchor: { kind: "box", x: 0, y: 0, w, h: 1, url: "https://x.example/", scroll: { x: 0, y: 0 }, shot: SHOT },
    });
    expect(sameSubject(box(1), box(1))).toBe(true);
    expect(sameSubject(box(1), box(2))).toBe(false);
    expect(sameSubject(box(1), { kind: "page", nodeId: page })).toBe(false);
  });
});

describe("anchors", () => {
  const decode = Schema.decodeUnknownSync(Anchor);

  it("takes each place a thread can hang", () => {
    for (const anchor of [
      { kind: "whole" },
      { kind: "box", x: -4, y: 0, w: 1.5, h: 2, url: "https://example.com" },
      { kind: "cells", range: "AA10:AD99" },
      { kind: "text", quote: "the box reads as your draft", offset: 0 },
      { kind: "lines", file: "src/shared/mention.ts", from: 3, to: 3 },
    ]) {
      expect(decode(anchor)).toEqual(anchor);
    }
  });

  it("refuses an anchor that names no place", () => {
    for (const anchor of [
      { kind: "box", x: Number.NaN, y: 0, w: 1, h: 1 },
      { kind: "box", x: 0, y: 0, w: -1, h: 1 },
      { kind: "text", quote: "" },
      { kind: "text", quote: "x", offset: -1 },
      { kind: "lines", file: "a.ts", from: 9, to: 3 },
      { kind: "lines", file: "a.ts", from: 0, to: 3 },
      { kind: "lines", file: "a.ts", from: 1.5, to: 3 },
      { kind: "region" },
    ]) {
      expect(() => decode(anchor), JSON.stringify(anchor)).toThrow();
    }
  });

  it("refuses misuse at compile time", () => {
    // Compiled, never run: each line is misuse tsc must refuse.
    const misuse = () => {
      // @ts-expect-error: a task subject needs its task id.
      threadSubjectMetadata({ kind: "task", nodeId: shelf });
      // @ts-expect-error: a bare string is not an ItemId.
      threadSubjectMetadata({ kind: "artifact", nodeId: shelf, artifactId: "01M5ESR42S7P9YNR8FEH0TD2QC" });
      // @ts-expect-error: a mailbox is not a resource subject, so it is never written.
      threadSubjectMetadata({ kind: "mailbox", seat });
      // @ts-expect-error: a bare string is not a NodeId.
      subjectNodeOf({ kind: "page", nodeId: "page-1" });
    };
    expect(misuse).toBeTypeOf("function");
  });
});

describe("a page's box", () => {
  const is = Schema.is(PageSubject);
  const box = (anchor: Record<string, unknown>) => ({
    kind: "page",
    nodeId: "page-1",
    anchor: { kind: "box", x: 0, y: 10, w: 20, h: 30, url: "https://x.example/a", scroll: { x: 0, y: 10 }, shot: SHOT, ...anchor },
  });

  it("is the page subject's only anchor, with its url, scroll and shot", () => {
    expect(is(box({}))).toBe(true);
    expect(is({ kind: "page", nodeId: "page-1" })).toBe(true);
    expect(is({ kind: "page", nodeId: "page-1", anchor: { kind: "cells", range: "B2" } })).toBe(false);
    expect(is({ kind: "page", nodeId: "page-1", anchor: { kind: "box", x: 0, y: 0, w: 1, h: 1 } })).toBe(false);
    expect(is(box({ shot: undefined }))).toBe(false);
    expect(is(box({ scroll: undefined }))).toBe(false);
  });

  it("names an http or https page, normalized, with no name or password, at most 16 KiB", () => {
    expect(is(box({ url: "file:///etc/passwd" }))).toBe(false);
    expect(is(box({ url: "javascript:alert(1)" }))).toBe(false);
    expect(is(box({ url: "https://user:pw@x.example/" }))).toBe(false);
    expect(is(box({ url: "HTTPS://X.example" }))).toBe(false);
    expect(is(box({ url: `https://x.example/${"a".repeat(16 * 1024)}` }))).toBe(false);
  });

  it("gives its shot only to factory mail on a page", () => {
    const row = (metadata: Record<string, unknown>) => ({ metadata });
    const subject = JSON.parse(JSON.stringify(box({}))) as unknown;
    expect(pageShotOf(row({ factoryMail: true, threadSubject: subject }))).toEqual(SHOT);
    expect(pageShotOf(row({ threadSubject: subject }))).toBeUndefined();
    expect(pageShotOf(row({ factoryMail: true, threadSubject: { kind: "page", nodeId: "page-1" } }))).toBeUndefined();
  });
});
