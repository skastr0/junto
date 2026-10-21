/**
 * Backlinks, read (plan 0.10, 03 section 3): where a seat, task, artifact or
 * page is mentioned, newest first, a page at a time, from main's
 * `work_mentions` (`window.junto.mentions`). The first page is read again
 * whenever main says a mention was added on the canvas; pages read further
 * back are kept until then.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { mentionKey, type MentionRef } from "@shared/mention";
import type { MentionCursor, MentionedIn, MentionIpcApi } from "@shared/mention-ipc";
import { getJuntoApi } from "./junto-api";

/** How many backlinks one read asks for. */
export const MENTIONED_IN_PAGE = 20;

export type MentionedInRead = {
  readonly entries: ReadonlyArray<MentionedIn>;
  /** Read; false until the first page lands, or when there is no bridge. */
  readonly loaded: boolean;
  /** More are held further back. */
  readonly more: boolean;
  readonly loadMore: () => void;
};

const mentionsApi = (): MentionIpcApi | undefined => getJuntoApi()?.mentions;

export const useMentionedIn = (canvasName: string, target: MentionRef): MentionedInRead => {
  const key = `${canvasName}\u0000${mentionKey(target)}`;
  const targetRef = useRef(target);
  targetRef.current = target;
  const [held, setHeld] = useState<{
    readonly key: string;
    readonly entries: ReadonlyArray<MentionedIn>;
    readonly next?: MentionCursor;
    readonly loaded: boolean;
  }>({ key, entries: [], loaded: false });
  // A first-page read always wins: starting and landing each begin a new
  // generation, and an earlier page read in flight across either is dropped
  // when it lands (its cursor belongs to the list the first page replaced).
  const generation = useRef(0);

  useEffect(() => {
    const api = mentionsApi();
    if (api === undefined) return;
    let live = true;
    const first = (): void => {
      const read = ++generation.current;
      void api.list(canvasName, targetRef.current, { limit: MENTIONED_IN_PAGE }).then(
        (page) => {
          if (live && read === generation.current) {
            generation.current += 1;
            setHeld({ key, entries: page.entries, loaded: true, ...(page.next === undefined ? {} : { next: page.next }) });
          }
        },
        () => undefined,
      );
    };
    first();
    const off = api.onChanged((changed) => {
      if (changed.canvasName === canvasName) first();
    });
    return () => {
      live = false;
      off();
    };
  }, [canvasName, key]);

  const current = held.key === key ? held : { key, entries: [], loaded: false };
  const next = "next" in current ? current.next : undefined;
  const loadMore = useCallback(() => {
    const api = mentionsApi();
    if (api === undefined || next === undefined) return;
    const read = generation.current;
    void api.list(canvasName, targetRef.current, { before: next, limit: MENTIONED_IN_PAGE }).then(
      (page) => {
        if (read !== generation.current) return;
        setHeld((was) =>
          was.key !== key
            ? was
            : { key, entries: [...was.entries, ...page.entries], loaded: true, ...(page.next === undefined ? {} : { next: page.next }) },
        );
      },
      () => undefined,
    );
  }, [canvasName, key, next]);

  return { entries: current.entries, loaded: current.loaded, more: next !== undefined, loadMore };
};
