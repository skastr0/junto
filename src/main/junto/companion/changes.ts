/**
 * The companion's change clock. Every source that can change what a phone
 * shows (canvas documents, seat state, signals, Jev readings, preambles, mail
 * delivery, pause, the desktop's report) bumps it; `junto companion-stdio`
 * long-polls it and refetches only what its phone follows.
 *
 * Signals ride along as payload: each upsert is kept in a bounded ring so a
 * poll can say exactly which signals changed since its cursor, whoever
 * changed them. The cursor carries this process's boot id, so a cursor from
 * before an app restart reads as a reset, never as "nothing changed".
 */

import { randomBytes } from "node:crypto";
import type { AgentSignal } from "@shared/agent-signals";

const SIGNAL_RING = 256;
/** Bursts (a canvas write touches several planes) coalesce into one wake. */
const COALESCE_MS = 120;

export type CompanionChanges = {
  readonly bump: () => void;
  readonly noteSignal: (signal: AgentSignal) => void;
  readonly wait: (
    cursor: string | undefined,
    waitMs: number,
  ) => Promise<{
    readonly cursor: string;
    readonly changed: boolean;
    readonly signals: ReadonlyArray<AgentSignal>;
    readonly reset: boolean;
  }>;
};

export const makeCompanionChanges = (): CompanionChanges => {
  const boot = randomBytes(6).toString("hex");
  let seq = 0;
  const ring: Array<{ readonly seq: number; readonly signal: AgentSignal }> = [];
  let waiters: Array<() => void> = [];
  let timer: ReturnType<typeof setTimeout> | undefined;

  const wake = (): void => {
    if (timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      const current = waiters;
      waiters = [];
      for (const resolve of current) resolve();
    }, COALESCE_MS);
  };
  const bump = (): void => {
    seq += 1;
    wake();
  };
  const cursorOf = (value: number): string => `${boot}:${value}`;
  const parse = (cursor: string | undefined): number | undefined => {
    const match = /^([0-9a-f]+):(\d+)$/u.exec(cursor ?? "");
    return match && match[1] === boot ? Number(match[2]) : undefined;
  };

  return {
    bump,
    noteSignal: (signal) => {
      seq += 1;
      ring.push({ seq, signal });
      if (ring.length > SIGNAL_RING) ring.splice(0, ring.length - SIGNAL_RING);
      wake();
    },
    wait: async (cursor, waitMs) => {
      const since = parse(cursor);
      // Unknown, foreign or too old for the ring: start over from now.
      const oldest = ring[0]?.seq ?? seq;
      if (since === undefined || since > seq || (since < oldest - 1 && ring.length === SIGNAL_RING)) {
        return { cursor: cursorOf(seq), changed: false, signals: [], reset: cursor !== undefined };
      }
      if (since === seq) {
        await new Promise<void>((resolve) => {
          const done = (): void => {
            clearTimeout(timeout);
            resolve();
          };
          const timeout = setTimeout(() => {
            waiters = waiters.filter((waiter) => waiter !== done);
            resolve();
          }, waitMs);
          waiters.push(done);
        });
      }
      const now = seq;
      return {
        cursor: cursorOf(now),
        changed: now !== since,
        signals: ring.filter((entry) => entry.seq > since && entry.seq <= now).map((entry) => entry.signal),
        reset: false,
      };
    },
  };
};
