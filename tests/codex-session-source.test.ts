/**
 * Where a Codex seat's session id may come from. On 2026-10-09 a Codex seat
 * ran `junto onboard`, whose output names the seat's past session; the screen
 * reader took `"session_id":"01a11910-f9f3-7392-b27` from it, cut short, and
 * the rollout proof passed it because a cut-short id is still part of the
 * past rollout's file name. The seat was stored on a session Codex never had.
 * Codex's id now comes only from its own store, and only a whole id is proven.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { printedSessionIdOf } from "../src/main/junto/term/harness-record";
import { extractSessionIdFromText } from "../src/main/junto/term/session-id-store";
import { __setSessionExistenceHomeForTest, harnessSessionExists } from "../src/main/junto/term/session-existence";

const PAST = "01a11910-f9f3-7392-b27b-5fec896a6d87";
/** What the reader took: the past id, cut where the screen cut it. */
const CUT = "01a11910-f9f3-7392-b27";
/** The onboard output the seat's agent ran, as its terminal showed it. */
const ONBOARD = `{"ok":true,"command":"onboard","data":{"previous_session_without_notes":{"session_id":"${CUT}`;

const homes: string[] = [];

afterEach(() => {
  __setSessionExistenceHomeForTest(undefined);
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("a Codex seat's session id", () => {
  it("is never read from its screen, where tool output names other sessions", () => {
    // The generic reader would take it; Codex's own does not.
    expect(extractSessionIdFromText(ONBOARD)).toBe(CUT);
    expect(printedSessionIdOf("codex", ONBOARD)).toBeUndefined();
    expect(printedSessionIdOf("codex", `{"session_id":"${PAST}"}`)).toBeUndefined();
    expect(printedSessionIdOf("codex", `CODEX_THREAD_ID=${PAST}`)).toBeUndefined();
  });

  it("is proven only whole: a cut-short id is part of a rollout's name, not a session", () => {
    const home = mkdtempSync(join(tmpdir(), "junto-codex-source-"));
    homes.push(home);
    const day = join(home, ".codex", "sessions", "2026", "10", "07");
    mkdirSync(day, { recursive: true });
    writeFileSync(join(day, `rollout-2026-10-07T22-11-45-${PAST}.jsonl`), "");
    __setSessionExistenceHomeForTest(home);
    expect(harnessSessionExists({ harness: "codex", sessionId: PAST })).toBe(true);
    expect(harnessSessionExists({ harness: "codex", sessionId: CUT })).toBe(false);
    expect(harnessSessionExists({ harness: "codex", sessionId: "2026-10-07T22-11-45" })).toBe(false);
  });
});
