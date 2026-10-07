/**
 * The size of a session, as tokens. Every transcript here is written into a
 * temp folder in the harness's own layout; nothing under the operator's home
 * is read.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SESSION_SIZE_BYTES_PER_TOKEN,
  SESSION_SIZE_TAIL_BYTES,
  sessionSizeOf,
  sessionTranscriptOf,
} from "../src/main/junto/term/session-size";
import { harnessSessionLocation } from "../src/main/junto/term/session-existence";
import { HARNESS_IDS } from "../src/shared/managed-terminal-templates";

const homes: string[] = [];
const home = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "junto-session-size-"));
  homes.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const write = (path: string, content: string): string => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
};
const lines = (...records: unknown[]): string =>
  records.map((record) => JSON.stringify(record)).join("\n") + "\n";
/** Filler that is not a usage record, to push earlier records out of the tail. */
const filler = (bytes: number): string =>
  lines({ type: "user", message: { role: "user", content: "x".repeat(bytes) } });

const UUID = "01a0e983-fee2-7ff2-97db-b10259aa4d84";

describe("recorded context size: what an uncached wake re-sends", () => {
  it("claude: the latest assistant turn's input, cache and output, ignoring sub-agent turns", () => {
    const h = home();
    const path = write(
      join(h, ".claude", "projects", "-work-repo", `${UUID}.jsonl`),
      lines(
        { type: "assistant", message: { usage: { input_tokens: 10, cache_read_input_tokens: 1_000, cache_creation_input_tokens: 0, output_tokens: 5 } } },
        { type: "user", message: { role: "user", content: "next" } },
        { type: "assistant", message: { usage: { input_tokens: 12, cache_read_input_tokens: 150_000, cache_creation_input_tokens: 3_000, output_tokens: 800 } } },
        // A sub-agent's turn is not the seat's context.
        { type: "assistant", isSidechain: true, message: { usage: { input_tokens: 5, cache_read_input_tokens: 9, cache_creation_input_tokens: 0, output_tokens: 1 } } },
        { type: "user", message: { role: "user", content: "last" } },
      ),
    );
    expect(sessionSizeOf({ harness: "claude", sessionId: UUID, cwd: "/work/repo", home: h })).toEqual({
      tokens: 153_812,
      transcriptPath: path,
      basis: "recorded",
    });
  });

  it("claude after its own compaction: the size is the compacted context, not the file", () => {
    const h = home();
    write(
      join(h, ".claude", "projects", "-work-repo", `${UUID}.jsonl`),
      filler(400_000) +
        lines({ type: "assistant", message: { usage: { input_tokens: 4, cache_read_input_tokens: 20_000, cache_creation_input_tokens: 0, output_tokens: 100 } } }),
    );
    expect(sessionSizeOf({ harness: "claude", sessionId: UUID, home: h })?.tokens).toBe(20_104);
  });

  it("codex: the last token count's total for the last call", () => {
    const h = home();
    const path = write(
      join(h, ".codex", "sessions", "2026", "10", "06", `rollout-2026-10-06T01-54-32-${UUID}.jsonl`),
      lines(
        { type: "session_meta", payload: { id: UUID } },
        { type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { total_tokens: 40_000 }, total_token_usage: { total_tokens: 900_000 } } } },
        { type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { total_tokens: 61_500 }, total_token_usage: { total_tokens: 961_500 } } } },
        { type: "response_item", payload: { role: "assistant" } },
      ),
    );
    expect(sessionSizeOf({ harness: "codex", sessionId: UUID, home: h })).toEqual({
      tokens: 61_500,
      transcriptPath: path,
      basis: "recorded",
    });
  });

  it.each([
    ["pi", (h: string) => join(h, ".pi", "agent", "sessions", "--work-repo--", `2026-10-03T19-18-00-387Z_${UUID}.jsonl`)],
    ["prime-agent", (h: string) => join(h, ".prime", "agent", "sessions", `${UUID}.jsonl`)],
    ["omp", (h: string) => join(h, ".omp", "agent", "sessions", "--work-repo--", `2026-09-14T15-56-12-043Z_${UUID}.jsonl`)],
  ] as const)("%s: the last assistant message's total", (harness, at) => {
    const h = home();
    const path = write(
      at(h),
      lines(
        { type: "session", id: UUID },
        { type: "message", message: { role: "assistant", usage: { totalTokens: 9_000 } } },
        { type: "message", message: { role: "assistant", usage: { totalTokens: 72_345 } } },
        { type: "message", message: { role: "toolResult" } },
      ),
    );
    expect(sessionSizeOf({ harness, sessionId: UUID, cwd: "/work/repo", home: h })).toEqual({
      tokens: 72_345,
      transcriptPath: path,
      basis: "recorded",
    });
  });

  it("prime-agent: the transcript file wins over the sidecar folder of the same name", () => {
    const h = home();
    const root = join(h, ".prime", "agent", "sessions");
    mkdirSync(join(root, UUID, "artifacts"), { recursive: true });
    const path = write(join(root, `${UUID}.jsonl`), lines({ type: "message", message: { usage: { totalTokens: 10 } } }));
    expect(harnessSessionLocation({ harness: "prime-agent", sessionId: UUID, home: h })).toBe(path);
  });

  it("kimi: the last step's usage, summed, from the wire log inside the session folder", () => {
    const h = home();
    const id = `session_${UUID}`;
    const path = write(
      join(h, ".kimi-code", "sessions", "wd_repo_1", id, "agents", "main", "wire.jsonl"),
      lines(
        { type: "context.append_loop_event", event: { type: "step.end", usage: { inputOther: 100, inputCacheRead: 5_000, inputCacheCreation: 0, output: 50 } } },
        { type: "context.append_loop_event", event: { type: "step.end", usage: { inputOther: 300, inputCacheRead: 80_000, inputCacheCreation: 2_000, output: 700 } } },
        { type: "context.append_message", message: { role: "user" } },
      ),
    );
    expect(sessionSizeOf({ harness: "kimi", sessionId: id, home: h })).toEqual({
      tokens: 83_000,
      transcriptPath: path,
      basis: "recorded",
    });
  });

  it("muse: the last model call's input and output", () => {
    const h = home();
    const path = write(
      join(h, ".local", "share", "muse", "sessions", "2026", "10", "06", UUID, "session.jsonl"),
      lines(
        { payload: { event: { usage: { input_tokens: 1_000, cached_tokens: 900, output_tokens: 10 } } } },
        { payload: { event: { usage: { input_tokens: 45_000, cached_tokens: 44_000, output_tokens: 250 } } } },
      ),
    );
    expect(sessionSizeOf({ harness: "muse", sessionId: UUID, home: h })).toEqual({
      tokens: 45_250,
      transcriptPath: path,
      basis: "recorded",
    });
  });

  it("grok: the total the harness reports beside each update", () => {
    const h = home();
    const dir = join(h, ".grok", "sessions", encodeURIComponent("/work/repo"), UUID);
    const path = write(join(dir, "chat_history.jsonl"), lines({ type: "user" }, { type: "assistant" }));
    write(
      join(dir, "updates.jsonl"),
      lines({ params: { _meta: { totalTokens: 20_000 } } }, { params: { _meta: { totalTokens: 131_072 } } }, { params: { update: {} } }),
    );
    expect(sessionSizeOf({ harness: "grok", sessionId: UUID, cwd: "/work/repo", home: h })).toEqual({
      tokens: 131_072,
      transcriptPath: path,
      basis: "recorded",
    });
  });

  it("amp: the last inference's total input and output, from the local thread file", () => {
    const h = home();
    const id = `T-${UUID}`;
    const path = write(
      join(h, ".local", "share", "amp", "threads", `${id}.json`),
      JSON.stringify({
        id,
        messages: [
          { role: "assistant", usage: { totalInputTokens: 30_000, outputTokens: 100 } },
          { role: "assistant", usage: { totalInputTokens: 88_000, outputTokens: 420 } },
        ],
      }),
    );
    expect(harnessSessionLocation({ harness: "amp", sessionId: id, home: h })).toBe(path);
    expect(sessionSizeOf({ harness: "amp", sessionId: id, home: h })).toEqual({
      tokens: 88_420,
      transcriptPath: path,
      basis: "recorded",
    });
  });

  it("reads only the tail: a record further back than the tail is not found, and the size falls back to an estimate", () => {
    const h = home();
    const path = write(
      join(h, ".claude", "projects", "-work-repo", `${UUID}.jsonl`),
      lines({ type: "assistant", message: { usage: { input_tokens: 1, cache_read_input_tokens: 999_999, cache_creation_input_tokens: 0, output_tokens: 1 } } }) +
        filler(SESSION_SIZE_TAIL_BYTES + 10_000),
    );
    const size = sessionSizeOf({ harness: "claude", sessionId: UUID, home: h });
    expect(size?.basis).toBe("estimated");
    expect(size?.transcriptPath).toBe(path);
    // Bytes over the stated constant for this format.
    expect(size?.tokens).toBeGreaterThan(SESSION_SIZE_TAIL_BYTES / SESSION_SIZE_BYTES_PER_TOKEN.claude! - 1);
    expect(size?.tokens).toBeLessThan((SESSION_SIZE_TAIL_BYTES + 20_000) / SESSION_SIZE_BYTES_PER_TOKEN.claude! + 1);
  });
});

describe("estimated size: transcript bytes over a stated constant", () => {
  it("antigravity: its transcript file", () => {
    const h = home();
    const path = write(
      join(h, ".gemini", "antigravity-cli", "brain", UUID, ".system_generated", "logs", "transcript.jsonl"),
      "y".repeat(60_000),
    );
    expect(sessionSizeOf({ harness: "agy", sessionId: UUID, home: h })).toEqual({
      tokens: Math.round(60_000 / SESSION_SIZE_BYTES_PER_TOKEN.agy!),
      transcriptPath: path,
      basis: "estimated",
    });
  });

  it("a transcript with no usage record in it is estimated, for every recorded format", () => {
    const h = home();
    const path = write(
      join(h, ".codex", "sessions", "2026", "10", "06", `rollout-2026-10-06T01-54-32-${UUID}.jsonl`),
      "z".repeat(50_000),
    );
    expect(sessionSizeOf({ harness: "codex", sessionId: UUID, home: h })).toEqual({
      tokens: Math.round(50_000 / SESSION_SIZE_BYTES_PER_TOKEN.codex!),
      transcriptPath: path,
      basis: "estimated",
    });
  });

  const hermesDb = (h: string): string => {
    const path = join(h, ".hermes", "state.db");
    mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    db.exec(
      "CREATE TABLE sessions (id TEXT PRIMARY KEY); CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, content TEXT, tool_calls TEXT, reasoning TEXT, active INTEGER);",
    );
    db.prepare("INSERT INTO sessions (id) VALUES (?)").run("20261006_101500_ab12cd");
    const add = db.prepare("INSERT INTO messages (session_id, content, tool_calls, reasoning, active) VALUES (?, ?, ?, ?, ?)");
    add.run("20261006_101500_ab12cd", "a".repeat(30_000), "b".repeat(8_000), "c".repeat(2_000), 1);
    // Dropped from the model's context by the harness's own compaction.
    add.run("20261006_101500_ab12cd", "d".repeat(500_000), null, null, 0);
    add.run("20261006_999999_ffffff", "e".repeat(700_000), null, null, 1);
    db.close();
    return path;
  };

  it("hermes: this session's live messages in its database, never the whole database", () => {
    const h = home();
    const path = hermesDb(h);
    expect(sessionSizeOf({ harness: "hermes", sessionId: "20261006_101500_ab12cd", home: h })).toEqual({
      tokens: Math.round(40_000 / SESSION_SIZE_BYTES_PER_TOKEN.hermes!),
      transcriptPath: path,
      basis: "estimated",
    });
    expect(sessionSizeOf({ harness: "hermes", sessionId: "20261006_000000_000000", home: h })).toBeUndefined();
  });

  it("devin: this session's messages in its database", () => {
    const h = home();
    const path = join(h, ".local", "share", "devin", "cli", "sessions.db");
    mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    db.exec(
      "CREATE TABLE sessions (id TEXT PRIMARY KEY); CREATE TABLE message_nodes (row_id INTEGER PRIMARY KEY, session_id TEXT, chat_message TEXT);",
    );
    db.prepare("INSERT INTO sessions (id) VALUES (?)").run("brave-otter");
    const add = db.prepare("INSERT INTO message_nodes (session_id, chat_message) VALUES (?, ?)");
    add.run("brave-otter", "m".repeat(90_000));
    add.run("other-session", "n".repeat(900_000));
    db.close();
    expect(sessionSizeOf({ harness: "devin", sessionId: "brave-otter", home: h })).toEqual({
      tokens: Math.round(90_000 / SESSION_SIZE_BYTES_PER_TOKEN.devin!),
      transcriptPath: path,
      basis: "estimated",
    });
  });
});

describe("unknown rather than a guess", () => {
  it("is undefined when the transcript cannot be located", () => {
    const h = home();
    for (const harness of HARNESS_IDS) {
      expect(sessionSizeOf({ harness, sessionId: UUID, cwd: "/work/repo", home: h }), harness).toBeUndefined();
      expect(sessionTranscriptOf({ harness, sessionId: UUID, cwd: "/work/repo", home: h }), harness).toBeUndefined();
    }
    expect(sessionSizeOf({ harness: "not-a-harness", sessionId: UUID, home: h })).toBeUndefined();
    expect(sessionSizeOf({ harness: "claude", sessionId: "  ", home: h })).toBeUndefined();
  });

  it("cursor and fx are located but not sized: their files are not the conversation", () => {
    const h = home();
    const chat = join(h, ".cursor", "chats", "ws1", UUID);
    write(join(chat, "meta.json"), "{}");
    const store = write(join(chat, "store.db"), "b".repeat(5_000_000));
    expect(sessionTranscriptOf({ harness: "cursor", sessionId: UUID, home: h })).toBe(store);
    expect(sessionSizeOf({ harness: "cursor", sessionId: UUID, home: h })).toBeUndefined();

    const fxId = "1787761861883-1787761861883720000-7afaf80c8f5acd35";
    const events = write(join(h, ".fx", "sessions", fxId, "events.jsonl"), "e".repeat(5_000_000));
    expect(sessionTranscriptOf({ harness: "fx", sessionId: fxId, home: h })).toBe(events);
    expect(sessionSizeOf({ harness: "fx", sessionId: fxId, home: h })).toBeUndefined();
  });

  it("never throws on a transcript it cannot parse", () => {
    const h = home();
    write(join(h, ".claude", "projects", "-work-repo", `${UUID}.jsonl`), "{not json\n\u0000\u0001\n");
    expect(sessionSizeOf({ harness: "claude", sessionId: UUID, home: h })?.basis).toBe("estimated");
  });

  it("states a bytes-per-token constant for every format it estimates", () => {
    for (const harness of ["claude", "codex", "pi", "prime-agent", "omp", "kimi", "muse", "grok", "amp", "agy", "hermes", "devin"]) {
      expect(SESSION_SIZE_BYTES_PER_TOKEN[harness], harness).toBeGreaterThan(0);
    }
    expect(SESSION_SIZE_BYTES_PER_TOKEN.cursor).toBeUndefined();
    expect(SESSION_SIZE_BYTES_PER_TOKEN.fx).toBeUndefined();
  });
});
