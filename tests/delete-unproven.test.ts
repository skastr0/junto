/**
 * The Delete anyway words: a remote seat's machine could not prove the stop.
 * Copy and order are remote-design's, docs/plans/0.11/machines-attention-look.md
 * section 4. Each pair names the machine and the seat, says why, and says what
 * Delete anyway does there; no line promises a later stop.
 */
import { describe, expect, it } from "vitest";
import { unprovenStopLines, type UnprovenStop } from "../src/window/lib/delete-unproven";

const stop = (seat: string, reason: UnprovenStop["reason"], machine = "Studio", asleep = false): UnprovenStop => ({
  machine,
  seat,
  reason,
  asleep,
});

describe("Delete anyway words", () => {
  it("names the seat, the machine and why, then what Delete anyway does there", () => {
    expect(unprovenStopLines([stop("quasar-lead", "unreachable")])).toEqual([
      "Junto cannot reach Studio, so it could not stop quasar-lead there.",
      "Delete anyway removes it here, and it may keep running on Studio.",
    ]);
  });

  it("says asleep in place of unreachable or timeout when the machine is asleep", () => {
    expect(unprovenStopLines([stop("quasar-lead", "unreachable", "Studio", true)])).toEqual([
      "Studio is asleep, so Junto could not stop quasar-lead there.",
      "Delete anyway removes it here, and it may keep running on Studio.",
    ]);
    expect(unprovenStopLines([stop("quasar-lead", "timeout", "Studio", true)])[0]).toBe(
      "Studio is asleep, so Junto could not stop quasar-lead there.",
    );
  });

  it("names one, two or three seats and counts the rest from four, never saying and 1 more", () => {
    const lineOf = (count: number): string =>
      unprovenStopLines(Array.from({ length: count }, (_, n) => stop(`s${n + 1}`, "unreachable")))[0]!;
    expect(lineOf(1)).toBe("Junto cannot reach Studio, so it could not stop s1 there.");
    expect(lineOf(2)).toBe("Junto cannot reach Studio, so it could not stop s1 and s2 there.");
    expect(lineOf(3)).toBe("Junto cannot reach Studio, so it could not stop s1, s2 and s3 there.");
    expect(lineOf(4)).toBe("Junto cannot reach Studio, so it could not stop s1, s2 and 2 more there.");
    expect(lineOf(5)).toBe("Junto cannot reach Studio, so it could not stop s1, s2 and 3 more there.");
  });

  it("lists up to three seats on one machine and reason, then counts the rest", () => {
    const stops = ["a", "b", "c", "d"].map((seat) => stop(seat, "unreachable"));
    expect(unprovenStopLines(stops)).toEqual([
      "Junto cannot reach Studio, so it could not stop a, b and 2 more there.",
      "Delete anyway removes them here, and they may keep running on Studio.",
    ]);
  });

  it("orders pairs epoch-changed, refused, timeout, unreachable, asleep, then by machine label", () => {
    const stops = [
      stop("mini-seat", "unreachable", "Zeta"),
      stop("timeout-seat", "timeout", "Atlas"),
      stop("refused-seat", "refused", "Atlas"),
      stop("epoch-seat", "epoch-changed", "Studio"),
    ];
    const lines = unprovenStopLines(stops);
    expect(lines.filter((_, at) => at % 2 === 0)).toEqual([
      "epoch-seat restarted on Studio while Junto was stopping it.",
      "Atlas would not stop refused-seat.",
      "Atlas did not answer in time, so Junto could not stop timeout-seat there.",
      "Junto cannot reach Zeta, so it could not stop mini-seat there.",
    ]);
  });

  it("gives one machine with two reasons a pair of lines each", () => {
    expect(unprovenStopLines([stop("a", "refused"), stop("a", "epoch-changed")])).toEqual([
      "a restarted on Studio while Junto was stopping it.",
      "Delete anyway removes it here, and it may keep running on Studio.",
      "Studio would not stop a.",
      "Delete anyway removes it here, and it may keep running on Studio.",
    ]);
  });
});
