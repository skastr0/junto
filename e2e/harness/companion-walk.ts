/**
 * The phone's artifact and thread walk (0.11.3), one script for two hosts: the
 * real app (a paired `companion-stdio --device` relay) and the demo
 * (`companion-stdio --demo`, no Mac). Every request, response and event line
 * is written down in order, with nothing a fixture should not carry (no key,
 * no device id, no host list), so app-artifacts can replay the file.
 *
 * A step that needs the desktop (a desktop edit, a seat that mails) is
 * `na` where the host has none, never silently green.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mentionHref } from "../../src/shared/wire/mention";
import { asNodeId } from "../../src/shared/model";

export type Frame = Record<string, any>;

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const ulid = (): string => {
  let t = Date.now();
  let time = "";
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32]! + time;
    t = Math.floor(t / 32);
  }
  const bytes = randomBytes(16);
  let random = "";
  for (let i = 0; i < 16; i++) random += CROCKFORD[bytes[i]! % 32];
  return time + random;
};

export type TranscriptLine = { readonly n: number; readonly dir: "request" | "response" | "event"; readonly step: string; readonly frame: Frame };

/** A deviceId, a key or a host never reaches the file. */
const scrub = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(scrub);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      if (key === "hosts") out[key] = ["fixture.invalid"];
      else if (key === "deviceId") out[key] = "dev_FIXTURE";
      else if (key === "publicKey" || key === "hostKey") out[key] = "<removed>";
      else out[key] = scrub(inner);
    }
    return out;
  }
  return value;
};

/** A relay child, spoken to a line at a time. */
export class Phone {
  readonly lines: Frame[] = [];
  readonly transcript: TranscriptLine[] = [];
  step = "connect";
  private buffer = "";
  private cursor = 0;
  private counter = 0;
  private readonly child: ChildProcessWithoutNullStreams;
  stderr = "";

  constructor(args: ReadonlyArray<string>, cwd: string, env: NodeJS.ProcessEnv) {
    this.child = spawn("bun", [`${cwd}/src/cli/main.ts`, "companion-stdio", ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf8");
      let at: number;
      while ((at = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, at);
        this.buffer = this.buffer.slice(at + 1);
        if (line.trim() === "") continue;
        const frame = JSON.parse(line) as Frame;
        this.lines.push(frame);
        this.transcript.push({ n: this.transcript.length, dir: frame.type === "event" ? "event" : "response", step: this.step, frame: scrub(frame) as Frame });
      }
    });
    this.child.stderr.on("data", (chunk: Buffer) => { this.stderr += chunk.toString("utf8"); });
  }

  /** Waits for a frame that matches, from `from` on (default: everything not yet looked at). */
  async until(match: (frame: Frame) => boolean, timeoutMs = 20_000, from = 0): Promise<Frame> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.lines.slice(from).find(match);
      if (found) return found;
      if (Date.now() > deadline) throw new Error(`no matching frame in ${timeoutMs} ms (${this.lines.length} seen; stderr: ${this.stderr.slice(0, 200)})`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  mark(): number { return this.lines.length; }

  /** One request, its response. `ok: false` comes back as the frame, never thrown. */
  async call(op: string, args: object = {}, timeoutMs = 30_000): Promise<Frame> {
    const id = `w${String(++this.counter).padStart(3, "0")}`;
    const frame = { v: "junto-companion/1", type: "request", id, op, args };
    this.transcript.push({ n: this.transcript.length, dir: "request", step: this.step, frame: scrub(frame) as Frame });
    this.child.stdin.write(`${JSON.stringify(frame)}\n`);
    return this.until((candidate) => candidate.id === id, timeoutMs);
  }

  /** `call`, expecting success; the result. */
  async ok(op: string, args: object = {}): Promise<Frame> {
    const reply = await this.call(op, args);
    if (reply.ok !== true) throw new Error(`${op} refused: ${JSON.stringify(reply.error).slice(0, 300)}`);
    return reply.result as Frame;
  }

  close(): void { this.child.stdin.end(); setTimeout(() => this.child.kill(), 2_000).unref(); }
  get hello(): Frame | undefined { return this.lines.find((frame) => frame.event === "hello"); }
}

export type StepResult = { readonly step: string; readonly status: "pass" | "fail" | "na"; readonly detail?: string };

/** What only the host can do. Absent, the step that needs it is `na`. */
export type Hooks = {
  /** The desktop edits an artifact's document (a replace of its markdown, by the operator). */
  readonly desktopReplace?: (artifactId: string, markdown: string) => Promise<void>;
  /** The desktop makes a document of about 500 000 characters in the node; its artifact id. */
  readonly desktopLargeDocument?: () => Promise<string>;
  /** `peerSeat` mails the viewed seat; resolves once the mail is stored. */
  readonly peerMail?: (text: string) => Promise<void>;
  /** The desktop reads a thread (the seat's Threads popup marks it). */
  readonly desktopReadThread?: (nodeId: string, threadId: string) => Promise<void>;
  /** A seat raises an escalate with an artifact form in the node; the signal text. */
  readonly raiseArtifactSignal?: (text: string, minWords: number) => Promise<void>;
};

export type WalkContext = {
  readonly canvas: string;
  /** The Artifacts node the walk writes in. */
  readonly node: string;
  /** The seat the phone views (threads, unread). */
  readonly seat: string;
  /** The seat whose signal the phone answers. */
  readonly signalSeat: string;
  readonly hooks: Hooks;
};

const PNG_1X1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

const expect = (condition: unknown, message: string): void => {
  if (!condition) throw new Error(message);
};

export const walk = async (phone: Phone, ctx: WalkContext): Promise<StepResult[]> => {
  const results: StepResult[] = [];
  const { canvas, node, hooks } = ctx;
  const stage = async (name: string, run: () => Promise<void>, needs?: { readonly have: boolean; readonly why: string }): Promise<void> => {
    phone.step = name;
    if (needs !== undefined && !needs.have) {
      results.push({ step: name, status: "na", detail: needs.why });
      return;
    }
    try {
      await run();
      results.push({ step: name, status: "pass" });
    } catch (error) {
      results.push({ step: name, status: "fail", detail: String(error instanceof Error ? error.message : error).slice(0, 400) });
    }
  };
  const state: { docId?: string; docVersion?: number; docOp?: string; largeId?: string; fileId?: string } = {};

  await stage("hello", async () => {
    const hello = await phone.until((frame) => frame.event === "hello");
    expect(hello.data.features?.includes("artifacts/1"), `hello features: ${JSON.stringify(hello.data.features)}`);
  });

  await stage("artifacts.nodes", async () => {
    const result = await phone.ok("artifacts.nodes", { canvasName: canvas });
    expect(result.nodes.some((row: Frame) => row.nodeId === node), `node ${node} not listed`);
  });

  await stage("artifacts.list", async () => {
    const result = await phone.ok("artifacts.list", { canvasName: canvas, nodeId: node });
    expect(Array.isArray(result.artifacts) && typeof result.more === "boolean", "artifacts/more missing");
  });

  await stage("artifact.apply create", async () => {
    state.docId = ulid();
    state.docOp = ulid();
    const result = await phone.ok("artifact.apply", {
      canvasName: canvas, nodeId: node, artifactId: state.docId, opId: state.docOp,
      op: { op: "create", title: "Phone walk note", body: { type: "document", markdown: "first line\n" }, labels: ["walk"] },
    });
    expect(result.disposition === "applied" && result.artifact?.artifactId === state.docId, `create: ${JSON.stringify(result).slice(0, 200)}`);
    state.docVersion = result.artifact.version;
  });

  await stage("artifact.get inline", async () => {
    const result = await phone.ok("artifact.get", { canvasName: canvas, artifactId: state.docId });
    expect(result.body?.type === "document" && result.body.markdown === "first line\n", `body: ${JSON.stringify(result.body).slice(0, 120)}`);
    expect(result.bodyRef?.sha256, "bodyRef missing");
  });

  await stage("artifact.apply edit", async () => {
    const result = await phone.ok("artifact.apply", {
      canvasName: canvas, nodeId: node, artifactId: state.docId, opId: ulid(),
      op: { op: "edit", edit: { kind: "patch", type: "document", baseVersion: state.docVersion, patches: [{ op: "splice", at: 11, remove: 0, insert: "second line\n" }] } },
    });
    expect(result.disposition === "applied" && result.artifact.version === state.docVersion! + 1, `edit: ${JSON.stringify(result).slice(0, 200)}`);
    state.docVersion = result.artifact.version;
  });

  await stage("artifact.apply replayed opId", async () => {
    const opId = ulid();
    const args = {
      canvasName: canvas, nodeId: node, artifactId: state.docId, opId,
      op: { op: "edit", edit: { kind: "patch", type: "document", baseVersion: state.docVersion, patches: [{ op: "splice", at: 23, remove: 0, insert: "third line\n" }] } },
    };
    const first = await phone.ok("artifact.apply", args);
    const again = await phone.ok("artifact.apply", args);
    expect(first.disposition === "applied" && again.disposition === "applied", "both applied");
    expect(again.artifact.version === first.artifact.version, `replay moved the version: ${first.artifact.version} then ${again.artifact.version}`);
    expect(JSON.stringify(again) === JSON.stringify(first), "the replay is not the first ruling");
    state.docVersion = first.artifact.version;
  });

  await stage("artifact.apply stale conflict", async () => {
    const reply = await phone.call("artifact.apply", {
      canvasName: canvas, nodeId: node, artifactId: state.docId, opId: ulid(),
      op: { op: "edit", edit: { kind: "replace", baseVersion: 1, body: { type: "document", markdown: "stale write\n" } } },
    });
    expect(reply.ok === false && reply.error?.code === "conflict", `reply: ${JSON.stringify(reply).slice(0, 240)}`);
    expect(reply.error.reason === "stale" && reply.error.artifact?.version === state.docVersion, `head not returned: ${JSON.stringify(reply.error).slice(0, 240)}`);
  });

  await stage("artifact.get bodyRef (over the frame budget)", async () => {
    state.largeId = await hooks.desktopLargeDocument!();
    const result = await phone.ok("artifact.get", { canvasName: canvas, artifactId: state.largeId });
    expect(result.body === undefined, "the body came inline");
    expect(result.bodyRef?.byteLength > 480 * 1024, `bodyRef byteLength ${result.bodyRef?.byteLength}`);
    const piece = await phone.ok("content.get", { sha256: result.bodyRef.sha256, offset: 0, length: 256 });
    expect(piece.byteLength === result.bodyRef.byteLength && typeof piece.data === "string", "content.get did not serve the body");
  }, { have: hooks.desktopLargeDocument !== undefined, why: "this host cannot make a document over the budget (no desktop; the phone's frame is 16 KiB)" });

  await stage("content.stage (purpose artifact) claimed by an apply", async () => {
    const sha = createHash("sha256").update(PNG_1X1).digest("hex");
    const staged = await phone.ok("content.stage", {
      canvasName: canvas, sha256: sha, byteLength: PNG_1X1.length, mediaType: "image/png", displayName: "pixel.png",
      offset: 0, data: PNG_1X1.toString("base64"), purpose: { for: "artifact", canvasName: canvas },
    });
    expect(staged.ref?.sha256 === sha, `no ref: ${JSON.stringify(staged).slice(0, 160)}`);
    state.fileId = ulid();
    const applied = await phone.ok("artifact.apply", {
      canvasName: canvas, nodeId: node, artifactId: state.fileId, opId: ulid(),
      op: { op: "create", title: "Phone pixel", body: { type: "file", content: staged.ref } },
    });
    expect(applied.disposition === "applied" && applied.artifact.type === "file", `file create: ${JSON.stringify(applied).slice(0, 200)}`);
  });

  await stage("comment.post, comments.changed, comments.list", async () => {
    const subject = { kind: "artifact", nodeId: node, artifactId: state.docId };
    const before = await phone.ok("comments.list", { canvasName: canvas, subject });
    const mark = phone.mark();
    const text = "A phone comment";
    const posted = await phone.ok("comment.post", { canvasName: canvas, subject, opId: ulid(), text });
    expect(posted.threadId && posted.messageId, "no thread/message id");
    await phone.until((frame) => frame.event === "comments.changed" && frame.data?.subject?.artifactId === state.docId, 15_000, mark);
    const after = await phone.ok("comments.list", { canvasName: canvas, subject });
    const flat = JSON.stringify(after.threads);
    expect(flat.includes(text), "the posted comment is not listed");
    expect(after.threads.length === before.threads.length + 1, `threads ${before.threads.length} to ${after.threads.length}`);
  });

  await stage("mentions.candidates, mentions.resolve, mentions.linkedFrom", async () => {
    const candidates = await phone.ok("mentions.candidates", { canvasName: canvas, from: ctx.seat, trigger: "#", query: "" });
    expect(Array.isArray(candidates.candidates), "no candidates array");
    const href = mentionHref({ kind: "artifact", nodeId: asNodeId(node), artifactId: state.docId as never }, canvas);
    const resolved = await phone.ok("mentions.resolve", { canvasName: canvas, hrefs: [href] });
    expect(resolved.faces.length === 1, `faces ${resolved.faces.length}`);
    const linked = await phone.ok("mentions.linkedFrom", { canvasName: canvas, target: { kind: "artifact", nodeId: node, artifactId: state.docId } });
    expect(Array.isArray(linked.bodies) && Array.isArray(linked.mail), "linkedFrom shape");
  });

  await stage("artifacts.subscribe, desktop edit seen as artifact.changed", async () => {
    await phone.ok("artifacts.subscribe", { canvasName: canvas });
    const mark = phone.mark();
    await hooks.desktopReplace!(state.docId!, "desktop edit\n");
    const changed = await phone.until((frame) => frame.event === "artifact.changed" && frame.data?.artifact?.artifactId === state.docId, 20_000, mark);
    expect(changed.data.author?.kind === "operator", `author ${JSON.stringify(changed.data.author)}`);
  }, { have: hooks.desktopReplace !== undefined, why: "this host has no desktop to edit with" });

  await stage("artifact.changed for the phone's own write", async () => {
    await phone.ok("artifacts.subscribe", { canvasName: canvas });
    const head = await phone.ok("artifact.get", { canvasName: canvas, artifactId: state.docId });
    const mark = phone.mark();
    const applied = await phone.ok("artifact.apply", {
      canvasName: canvas, nodeId: node, artifactId: state.docId, opId: ulid(),
      op: { op: "edit", edit: { kind: "replace", baseVersion: head.version, body: { type: "document", markdown: "phone edit\n" } } },
    });
    expect(applied.disposition === "applied", "apply not applied");
    const changed = await phone.until((frame) => frame.event === "artifact.changed" && frame.data?.artifact?.artifactId === state.docId, 20_000, mark);
    expect(changed.data.artifact.version === applied.artifact.version, "changed event is not the phone's version");
  });

  await stage("threads.read moves unread n to 0 (seat.changed)", async () => {
    const seats = await phone.ok("seats.list", { canvasName: canvas });
    let seatId = ctx.seat;
    const mark = phone.mark();
    if (hooks.peerMail !== undefined) {
      await phone.ok("threads.list", { canvasName: canvas, nodeId: seatId });
      await hooks.peerMail("A mail the operator has not read");
      await phone.until((frame) => frame.event === "thread.changed" && frame.data?.nodeId === seatId && frame.data.thread.unread >= 1, 30_000, mark);
    } else {
      // No seat that mails here: read what the host already holds unread.
      const waiting = seats.seats.find((row: Frame) => (row.unread ?? 0) >= 1);
      expect(waiting, "no seat with unread mail on this host");
      seatId = waiting.nodeId;
    }
    const withUnread = (await phone.ok("seats.list", { canvasName: canvas })).seats.find((row: Frame) => row.nodeId === seatId);
    const n = withUnread?.unread ?? 0;
    expect(n >= 1, `seat ${seatId} unread ${n} before the read`);
    const listed = await phone.ok("threads.list", { canvasName: canvas, nodeId: seatId });
    const thread = listed.threads.find((row: Frame) => row.unread >= 1);
    expect(thread, "no unread thread in the seat's list");
    await phone.ok("thread.get", { canvasName: canvas, nodeId: seatId, threadId: thread.threadId });
    const mark2 = phone.mark();
    const read = await phone.ok("threads.read", { canvasName: canvas, nodeId: seatId, threadId: thread.threadId });
    expect(read.thread.unread === 0, `thread unread after the read ${read.thread.unread}`);
    await phone.until((frame) => frame.event === "seat.changed" && frame.data?.seat?.nodeId === seatId && (frame.data.seat.unread ?? 0) < n, 30_000, mark2);
    const after = (await phone.ok("seats.list", { canvasName: canvas })).seats.find((row: Frame) => row.nodeId === seatId);
    expect((after?.unread ?? 0) < n, `seat unread ${n} then ${after?.unread}`);
    // The phone's own read answers in its response and is not repeated as thread.changed (section 3).
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(!phone.lines.slice(mark2).some((frame) => frame.event === "thread.changed" && frame.data?.thread?.threadId === thread.threadId), "own read was echoed as thread.changed");
  });

  await stage("thread.changed when the desktop reads", async () => {
    const mark = phone.mark();
    await phone.ok("threads.list", { canvasName: canvas, nodeId: ctx.seat });
    await hooks.peerMail!("A second mail, read on the desktop");
    const arrived = await phone.until((frame) => frame.event === "thread.changed" && frame.data?.nodeId === ctx.seat && frame.data.thread.unread >= 1, 30_000, mark);
    const mark2 = phone.mark();
    await hooks.desktopReadThread!(ctx.seat, arrived.data.thread.threadId);
    const read = await phone.until((frame) => frame.event === "thread.changed" && frame.data?.thread?.threadId === arrived.data.thread.threadId && frame.data.thread.unread === 0, 30_000, mark2);
    expect(read.data.thread.unread === 0, "thread did not read");
  }, { have: hooks.peerMail !== undefined && hooks.desktopReadThread !== undefined, why: "this host has no desktop and no seat that mails" });

  await stage("signal artifact answer", async () => {
    let signal: Frame | undefined;
    if (hooks.raiseArtifactSignal !== undefined) {
      const text = "Draft the walk note";
      await phone.ok("seat.get", { canvasName: canvas, nodeId: ctx.signalSeat });
      const mark = phone.mark();
      await hooks.raiseArtifactSignal(text, 3);
      signal = (await phone.until((frame) => frame.event === "signal.changed" && frame.data?.signal?.text === text, 30_000, mark)).data.signal;
    } else {
      const seat = await phone.ok("seat.get", { canvasName: canvas, nodeId: ctx.signalSeat });
      signal = seat.seat.signals.find((row: Frame) => row.form?.kind === "artifact" && row.state === "open");
    }
    expect(signal?.form?.kind === "artifact", `no artifact-form signal: ${JSON.stringify(signal?.form)}`);
    const words = Array.from({ length: Math.max(signal!.form.minWords ?? 1, 5) }, (_, i) => `word${i + 1}`).join(" ");
    const answered = await phone.ok("signal.answer", { signalId: signal!.signalId, artifact: { markdown: `${words}\n`, replyId: ulid() } });
    expect(answered.signal.state === "answered", `state ${answered.signal.state}`);
    const listed = await phone.ok("artifacts.list", { canvasName: canvas, nodeId: signal!.form.nodeId });
    expect(listed.artifacts.some((row: Frame) => /word1 word2/.test(row.snippet ?? "")), "no document with the answer in the form's node");
  });

  return results;
};
