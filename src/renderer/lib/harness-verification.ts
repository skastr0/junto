/**
 * Whether a seat's harness is a version Junto was verified on, read from the
 * inventory of the seat's own machine (never this window's): each machine's
 * core scans its installs against the record's verified range.
 *
 * One answer per machine is kept and shared by every seat card on it, asked
 * again at most once a minute while a card shows it. A machine that cannot
 * answer (another machine, until the link's inventory channel lands) keeps
 * no answer, and its seats say nothing about their version.
 *
 * An unverified harness is not broken: it still launches. The note is quiet
 * ink, never an attention colour.
 */
import { useEffect } from "react";
import { observable } from "@legendapp/state";
import { use$ } from "@legendapp/state/react";
import { Result } from "effect";
import type { InventoryVerification } from "@shared/harness-domain";
import { harnessMachineSource } from "./harness-machine-source";

export type HarnessVersionReading = {
  readonly verification: InventoryVerification;
  /** The installed version as the machine read it. */
  readonly version?: string;
};

/** Machine name, then harness id. */
export const harnessVerification$ = observable<
  Record<string, Record<string, HarnessVersionReading> | undefined>
>({});

export const ASK_AGAIN_AFTER_MS = 60_000;
const askedAt = new Map<string, number>();
const NO_MACHINE = "__junto-no-machine__";

/** Ask a machine for its inventory, unless it was asked within the last minute. */
export const askHarnessVerification = (machine: string, now: number = Date.now()): void => {
  const last = askedAt.get(machine);
  if (last !== undefined && now - last < ASK_AGAIN_AFTER_MS) return;
  askedAt.set(machine, now);
  void harnessMachineSource()
    .inventory(machine)
    .then((answer) => {
      // A refusal keeps the last answer: a machine that went quiet is still the version it was.
      if (!Result.isSuccess(answer)) return;
      const readings: Record<string, HarnessVersionReading> = {};
      for (const row of answer.success.harnesses) {
        if (!row.installed || row.verification === undefined) continue;
        readings[row.harness] = {
          verification: row.verification,
          ...(row.version === undefined ? {} : { version: row.version }),
        };
      }
      harnessVerification$[machine].set(readings);
    })
    .catch(() => undefined);
};

/** Tests only: forget every answer and every ask. */
export const resetHarnessVerification = (): void => {
  askedAt.clear();
  harnessVerification$.set({});
};

/** The seat's harness version reading on its machine, once that machine has answered. */
export const useHarnessVersion = (
  machine: string | undefined,
  harness: string | undefined,
): HarnessVersionReading | undefined => {
  const readings = use$(harnessVerification$[machine || NO_MACHINE]);
  useEffect(() => {
    if (!machine) return;
    askHarnessVerification(machine);
    const timer = setInterval(() => askHarnessVerification(machine), ASK_AGAIN_AFTER_MS);
    return () => clearInterval(timer);
  }, [machine]);
  return harness === undefined ? undefined : readings?.[harness];
};

export type HarnessVersionNote = {
  /** The chip's word. */
  readonly label: string;
  /** What was tested, in a sentence: the chip's hover and spoken label. */
  readonly title: string;
};

/** What a seat says about its harness version: nothing for a verified one. */
export const harnessVersionNote = (reading: HarnessVersionReading | undefined): HarnessVersionNote | undefined => {
  if (reading === undefined) return undefined;
  const { verdict, from, through } = reading.verification;
  if (verdict === "verified") return undefined;
  const tested =
    verdict === "newer"
      ? `Newer than tested (verified through ${through})`
      : verdict === "older"
        ? `Older than tested (verified from ${from})`
        : `Version not read (verified ${from} through ${through})`;
  const installed = reading.version?.trim() ? ` This machine has ${reading.version.trim()}.` : "";
  return { label: "unverified", title: `${tested}.${installed} It still launches.` };
};
