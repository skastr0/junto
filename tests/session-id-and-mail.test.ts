import { afterEach, describe, expect, it, vi } from "vitest";
import {
  extractSessionIdFromText,
  recordCapturedSessionId,
  getCapturedSessionId,
  resetSessionIdStoreForTest,
} from "../src/main/vellum-command/term/session-id-store";
import { launchForManagedSpawn } from "../src/main/vellum-command/term/managed-spawn-plan";
import type { CanvasDoc } from "../src/shared/canvas";
import {
  GROK_MIN_POST_SPAWN_MS,
  ManagedTerminalDrive,
  CR,
  encodeBracketedPaste,
} from "../src/main/vellum-command/term/drive";
import { makeManagedAgentNode } from "../src/renderer/lib/node-factories";

const originalVellumHome = process.env.VELLUM_COMMAND_HOME;

afterEach(() => {
  vi.useRealTimers();
  if (originalVellumHome === undefined) delete process.env.VELLUM_COMMAND_HOME;
  else process.env.VELLUM_COMMAND_HOME = originalVellumHome;
});

describe("session id parsing + authorial pin", () => {
  it("extracts only session-labeled IDs and prefers structured fields", () => {
    expect(
      extractSessionIdFromText("session 550e8400-e29b-41d4-a716-446655440000 ok"),
    ).toBe("550e8400-e29b-41d4-a716-446655440000");
    expect(
      extractSessionIdFromText("tool emitted 550e8400-e29b-41d4-a716-446655440000"),
    ).toBeUndefined();
    expect(extractSessionIdFromText("CODEX_THREAD_ID=thread_abc12345")).toBe(
      "thread_abc12345",
    );
    expect(extractSessionIdFromText("HERMES_SESSION_ID=hs_xyz99999")).toBe(
      "hs_xyz99999",
    );
    expect(
      extractSessionIdFromText(
        'unrelated 550e8400-e29b-41d4-a716-446655440000 {"session_id":"3e6433af-b0ea-5718-8d29-27a68c9839fb"}',
      ),
    ).toBe("3e6433af-b0ea-5718-8d29-27a68c9839fb");
    expect(
      extractSessionIdFromText(
        "session: 550e8400-e29b-41d4-a716-446655440000 CODEX_THREAD_ID=3e6433af-b0ea-5718-8d29-27a68c9839fb",
      ),
    ).toBe("3e6433af-b0ea-5718-8d29-27a68c9839fb");
  });

  // Table-driven coverage for every label extractSessionIdFromText accepts,
  // the quoted/unquoted and colon/equals forms the regex supports, priority
  // ordering between labels, and negative cases (short ids, label-as-substring
  // word-boundary rejection, unlabeled PTY noise). Guards the perf hoist: a
  // module-scope RegExp[] plus a pre-filter must accept and reject byte-for-
  // byte the same set as the original per-call `new RegExp` construction.
  const LABEL_CASES: ReadonlyArray<[string, string, string | undefined]> = [
    // session_id: colon/equals, quoted/unquoted forms.
    [
      "session_id quoted-label quoted-value (JSON)",
      '{"session_id":"a1b2c3d4"}',
      "a1b2c3d4",
    ],
    ["session_id unquoted colon", "session_id: a1b2c3d4", "a1b2c3d4"],
    ["session_id unquoted equals", "session_id=a1b2c3d4", "a1b2c3d4"],
    [
      "session_id quoted-label equals quoted-value",
      '"session_id"="a1b2c3d4"',
      "a1b2c3d4",
    ],
    [
      "session_id exactly 8 chars (min length boundary)",
      "session_id: abcdefgh",
      "abcdefgh",
    ],

    // sessionId (camelCase).
    [
      "sessionId quoted-label quoted-value (JSON)",
      '{"sessionId":"b2c3d4e5"}',
      "b2c3d4e5",
    ],
    ["sessionId unquoted equals", "sessionId=b2c3d4e5", "b2c3d4e5"],

    // CODEX_THREAD_ID, including case-insensitivity.
    [
      "CODEX_THREAD_ID unquoted equals",
      "CODEX_THREAD_ID=thread_abc12345",
      "thread_abc12345",
    ],
    [
      "codex_thread_id lowercase (case-insensitive)",
      "codex_thread_id=thread_abc12345",
      "thread_abc12345",
    ],

    // HERMES_SESSION_ID.
    [
      "HERMES_SESSION_ID unquoted equals",
      "HERMES_SESSION_ID=hs_xyz99999",
      "hs_xyz99999",
    ],
    [
      "HERMES_SESSION_ID quoted-label colon quoted-value",
      '"HERMES_SESSION_ID": "hs_xyz99999"',
      "hs_xyz99999",
    ],

    // thread-id (hyphen) and thread_id (underscore) are distinct labels.
    ["thread-id unquoted colon", "thread-id: c3d4e5f6", "c3d4e5f6"],
    [
      "thread-id unquoted equals quoted-value",
      'thread-id="c3d4e5f6"',
      "c3d4e5f6",
    ],
    ["thread_id unquoted colon", "thread_id: d4e5f6g7", "d4e5f6g7"],
    ["thread_id unquoted equals", "thread_id=d4e5f6g7", "d4e5f6g7"],

    // Display fallback: bare "session" / "session id" / "thread" labels.
    [
      "display fallback: session colon uuid",
      "session: 550e8400-e29b-41d4-a716-446655440000",
      "550e8400-e29b-41d4-a716-446655440000",
    ],
    ["display fallback: session id colon", "session id: e5f6g7h8", "e5f6g7h8"],
    ["display fallback: thread space", "thread e5f6g7h8", "e5f6g7h8"],
    ["display fallback: thread equals", "thread=e5f6g7h8", "e5f6g7h8"],

    // Priority ordering: earlier-checked labels win when several are present.
    [
      "priority: session_id beats thread_id",
      "thread_id=zzzzzzzz session_id=aaaaaaaa",
      "aaaaaaaa",
    ],
    [
      "priority: CODEX_THREAD_ID beats HERMES_SESSION_ID",
      "HERMES_SESSION_ID=hhhhhhhh CODEX_THREAD_ID=cccccccc",
      "cccccccc",
    ],
    [
      "priority: thread-id beats thread_id",
      "thread_id=uuuuuuuu thread-id=hhhhhhhh",
      "hhhhhhhh",
    ],

    // Negative: value under the 8-char minimum never matches.
    [
      "negative: session_id value one char short of minimum",
      "session_id: short12",
      undefined,
    ],

    // Negative: label is a substring of a larger identifier, so the \b word
    // boundary must reject it even though "session"/"thread" appears in the
    // text (proves the pre-filter is a fast reject, not a match shortcut).
    [
      "negative: session_id embedded in a larger identifier",
      "mysession_id: abcdefgh",
      undefined,
    ],
    [
      "negative: thread_id embedded in a larger identifier",
      "underthread_id: abcdefgh",
      undefined,
    ],

    // Negative: "thread" as an ordinary English word, not a label.
    [
      "negative: thread used as a plain word, no id follows",
      "this thread of conversation continues",
      undefined,
    ],

    // Negative: unlabeled UUID, still rejected (terminal output is untrusted).
    [
      "negative: bare UUID with no label",
      "tool emitted 550e8400-e29b-41d4-a716-446655440000",
      undefined,
    ],

    // Negative: PTY repaint noise containing neither "session" nor "thread"
    // anywhere, the exact shape the pre-filter exists to short-circuit.
    [
      "negative: ANSI repaint bytes with no session/thread substring",
      "\x1b[2J\x1b[H$ ls -la\ndrwxr-xr-x  5 user  staff  160 Aug 19 12:00 .\n-rw-r--r--  1 user  staff   42 Aug 19 12:00 file.txt\n",
      undefined,
    ],
  ];

  it.each(LABEL_CASES)("extractSessionIdFromText: %s", (_desc, input, expected) => {
    expect(extractSessionIdFromText(input)).toBe(expected);
  });

  const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  it("makeManagedAgentNode pins UUID sessionId for claude/grok", () => {
    for (const harness of ["claude", "grok"] as const) {
      const n = makeManagedAgentNode(0, 0, { harness, host: "local" });
      const sid = n.ether?.terminal?.sessionId;
      expect(sid).toMatch(UUID_RE);
      expect(n.ether?.terminal?.harness).toBe(harness);
      expect(n.ether?.terminal?.bindingId).toBeTruthy();
      const argv = n.ether?.terminal?.launch?.argv ?? [];
      expect(argv).toContain("--session-id");
      expect(argv).toContain(sid);
    }
  });

  it("makeManagedAgentNode does not claim a session pin for unsupported harnesses", () => {
    for (const harness of ["codex", "hermes"] as const) {
      const n = makeManagedAgentNode(0, 0, {
        harness,
        host: "local",
        ...(harness === "hermes" ? { profile: "default" } : {}),
      });
      expect(n.ether?.terminal?.sessionId).toBeUndefined();
      const argv = n.ether?.terminal?.launch?.argv ?? [];
      expect(argv).not.toContain("--session-id");
    }
  });

  it("spawn replan uses a stored authoring pin without implicitly resuming", () => {
    delete process.env.VELLUM_COMMAND_HOME;
    const node = makeManagedAgentNode(0, 0, {
      harness: "claude",
      host: "local",
    });
    const sid = node.ether!.terminal!.sessionId!;
    expect(sid).toMatch(UUID_RE);
    const doc: CanvasDoc = { nodes: [node], edges: [] };
    const { launch } = launchForManagedSpawn({
      doc,
      nodeId: node.id,
      harness: "claude",
      documentLaunch: node.ether!.terminal!.launch,
    });
    expect(launch?.argv).toBeDefined();
    const argv = launch!.argv ?? [];
    expect(argv).toContain("--session-id");
    expect(argv).toContain(sid);
    expect(argv).not.toContain("--resume");
    expect(argv).not.toContain("-r");
  });

  it("spawn replan resumes only when requested AND external harness state proves the id", () => {
    delete process.env.VELLUM_COMMAND_HOME;
    const node = makeManagedAgentNode(0, 0, {
      harness: "claude",
      host: "local",
    });
    const sid = node.ether!.terminal!.sessionId!;
    const doc: CanvasDoc = { nodes: [node], edges: [] };
    // No FS proof → pin path even with resume:true (fail open).
    const unproven = launchForManagedSpawn({
      doc,
      nodeId: node.id,
      harness: "claude",
      documentLaunch: node.ether!.terminal!.launch,
      resume: true,
    });
    expect(unproven.launch?.argv).toEqual(
      expect.arrayContaining(["--session-id", sid]),
    );
    expect(unproven.launch?.argv).not.toContain("--resume");
  });

  it("capture store holds binding→session", () => {
    resetSessionIdStoreForTest();
    recordCapturedSessionId("b1", "thread_x");
    expect(getCapturedSessionId("b1")).toBe("thread_x");
  });
});

describe("Grok post-spawn delay", () => {
  it("markSpawned delays writePrompt", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const writes: string[] = [];
    const drive = new ManagedTerminalDrive({
      pasteToCrSettleMs: 0,
      write: (_id, data) => {
        writes.push(data);
        return true;
      },
      isSeatIdle: () => true,
      now: () => Date.now(),
      stallWatch: false,
    });
    drive.markSpawned("g1", GROK_MIN_POST_SPAWN_MS);
    try {
      const pending = drive.writePrompt("g1", "hi");
      await vi.advanceTimersByTimeAsync(GROK_MIN_POST_SPAWN_MS - 1);
      expect(writes).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toEqual({
        status: "submitted", bindingGeneration: 0,
        writesBefore: 0, writesAfter: 1, pasteWrites: 1, wrotePhysicalBytes: true,
      });
      expect(writes).toEqual([encodeBracketedPaste("hi"), CR]);
    } finally {
      drive.resetForTest();
    }
  });
});
