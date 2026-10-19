import { modelFixture, modelSeat } from "../harness/model";
/**
 * The overseer commands that speak model kinds, typed in an overseer seat [fake-tui].
 *
 *   bun run cli:build && bun run test:e2e:fast e2e/scenarios/overseer-model-kinds-cli.spec.ts
 *
 * The CLI team's eleven-step walk: canvas read, node create, configure,
 * recolor and move, wire verbs, connect, list and disconnect, the retired
 * edge family, seat drafts, reseat, canvas batch with an expected seq, and
 * node delete. Three fake Codex seats on one canvas:
 *
 *   O  the overseer (granted with the harness's grantOverseer). Every
 *      overseer command is typed in O, through its own built CLI.
 *   A, B  ordinary seats, not wired to each other.
 *
 * What is under test is the CLI: its exit code, stdout and stderr. The spec
 * needs dist/junto and refuses to start without it; it never falls back to a
 * work-control op. What the walk calls "appears on the canvas", "is drawn",
 * "is gone" and "unchanged" is read through the app, never through the CLI's
 * own read: the model as main holds it (harness/model.ts readModelCanvas) and
 * the canvas's own DOM (a node's card by data-id, a wire by its edge element).
 *
 * Harnesses in steps 8 and 9. The seats here run the crew fixture's fake
 * under the `codex` binary name, so the new seat is created on `codex`. It
 * is re-seated to `grok`, a second harness planted as a no-op binary by
 * launchJunto's seedHarnessInstalls, the way seat-offboard-operator.spec.ts
 * stages its re-seat walk. The created seat is never started.
 *
 * One test for the whole walk: the steps share the canvas and its seq. Each
 * block is labelled with its step; every check is soft, so every step runs
 * and reports. The four faults the walk asks to be reported as they are have
 * named checks, each beginning "FAIL TO REPORT".
 *
 * Evidence, in MODEL_KINDS_CLI_DIR when set and the test's output folder
 * otherwise: `<step>-cli.txt` for each command (argv, exit code, stdout,
 * stderr) and a frame at each step where the canvas should change.
 */
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page, TestInfo } from "@playwright/test";
import type { AgentSeatStateEvent } from "../../src/shared/agent-seat-state";
import { Schema } from "effect";
import { Node, Wire, Seq } from "../../src/shared/model";
import { crewOccupySeat, crewPlayFactory, crewSeat, installCrewSeatHarness, type CrewCliResult, type CrewSeat } from "../harness/crew-fixture";
import { expect, launchJunto, test } from "../harness/launch";
import { grantOverseer, readModelCanvas } from "../harness/model";

const CANVAS = "modelkinds";
const CLI_BUILT = existsSync(join(process.cwd(), "dist", "junto"));
const CLI_MISSING =
  "SETUP: dist/junto is missing. This walk tests the CLI's own exit codes and output, so it does not run without it. Build it with `bun run cli:build` in the checkout the run starts from.";

const soft = expect.configure({ soft: true });

/** The harness the fake seats run under, and the second one planted for the re-seat. */
const CREATE_HARNESS = "codex";
const RESEAT_HARNESS = "grok";

// The sentences, each from the source that says it.
/** cli/commands/overseer-retired.ts:18-23. */
const EDGE_RETIRED = "edge.connect is now wire.connect: the edge family is now wire";
const WIRE_SCHEMA_HINT = "junto overseer schema show wire.connect";
/** shared/overseer-rules.ts:356-359. */
const wrongKind = (id: string): string => `node "${id}" is a note, not a region; send a change whose kind is "note"`;
/** shared/overseer-rules.ts:287-297 (seatDraftRefusal). */
// The CLI refuses the draft before the socket (src/cli/commands/overseer.ts, e2c1c7a82).
const SEAT_DRAFT_SAYS = ["A seat is created from harness, profile, model, effort, mode, permissionMode and cwd; Junto builds its launch.", "Remove: launch"] as const;
/** main/junto/model/service.ts:223. */
const OPERATOR_ONLY = "Only the operator can change what an overseer seat runs or remove it.";
/** main/junto/overseer/canvas.ts:561 (AuthError, shown as Forbidden: overseer/dispatch.ts:90). */
const OWN_SEAT = "overseer cannot delete its own seat";
/** main/junto/overseer/canvas.ts:309-316 (ClaimConflict, shown as Conflict: overseer/dispatch.ts:94). */
const STALE_SAYS = ["is at seq", "read the canvas again before editing"] as const;

// ---------------------------------------------------------------------------
// Canvas
// ---------------------------------------------------------------------------

const O = modelSeat({ id: "overseer", label: "Overseer", x: 480, y: 40 });
const A = modelSeat({ id: "seat-a", label: "Ada", x: 480, y: 220 });
const B = modelSeat({ id: "seat-b", label: "Bo", x: 820, y: 220 });
const FIXTURE = modelFixture([O, A, B]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const seatState = async (page: Page, nodeId: string): Promise<string> => {
  const events = (await page.evaluate(() => window.junto!.agentSeatStateSnapshot())) as ReadonlyArray<AgentSeatStateEvent>;
  return events.find((event) => event.bindingId === `local:${nodeId}`)?.state ?? "none";
};

/** The one JSON line a stream holds, or undefined when it holds none. */
const jsonLine = (text: string): Record<string, unknown> | undefined => {
  for (const line of text.split("\n").reverse()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      return JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      // Not the line.
    }
  }
  return undefined;
};

/** Every returned row must satisfy its closed native schema, including nested batch results. */
const validateRows = (value: unknown): void => {
  if (Array.isArray(value)) {
    value.forEach(validateRows);
  } else if (typeof value === "object" && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      const strict = { onExcessProperty: "error" } as const;
      if (key === "node") Schema.decodeUnknownSync(Node, strict)(item);
      else if (key === "nodes") Schema.decodeUnknownSync(Schema.Array(Node), strict)(item);
      else if (key === "wire") Schema.decodeUnknownSync(Wire, strict)(item);
      else if (key === "wires") Schema.decodeUnknownSync(Schema.Array(Wire), strict)(item);
      else validateRows(item);
    }
  }
};

type Ran = {
  readonly result: CrewCliResult;
  readonly out: Record<string, unknown> | undefined;
  readonly err: Record<string, unknown> | undefined;
  readonly data: Record<string, unknown>;
  readonly error: { readonly type?: unknown; readonly message?: unknown; readonly hint?: unknown };
};

type ModelNode = { readonly id: string; readonly kind: string } & Record<string, unknown>;
type ModelWire = { readonly id: string; readonly from: string; readonly to: string; readonly verb: string } & Record<string, unknown>;

// ===========================================================================

test("[fake-tui] the overseer's model-kind commands: read, node, wire, the retired edge family, seat drafts, reseat, batch, delete", async ({}, testInfo: TestInfo) => {
  test.setTimeout(600_000);
  if (!CLI_BUILT) throw new Error(CLI_MISSING);

  const dir = process.env.MODEL_KINDS_CLI_DIR ?? testInfo.outputPath();
  await mkdir(dir, { recursive: true });
  const junto = await launchJunto({
    seedModels: { [CANVAS]: FIXTURE },
    // Planted before afterSeed (harness/launch.ts), so the fake codex below is not overwritten.
    seedHarnessInstalls: [RESEAT_HARNESS],
    afterSeed: installCrewSeatHarness,
  });
  const { page, sandbox } = junto;
  const shot = async (name: string): Promise<void> => {
    await page.mouse.move(4, 4).catch(() => undefined);
    await page.screenshot({ path: join(dir, `${name}.png`) }).catch(() => undefined);
  };

  /** Run one command in a seat through its own CLI, and keep everything it said. */
  const run = async (step: string, seat: CrewSeat, argv: ReadonlyArray<string>): Promise<Ran> => {
    const result = await seat.cli(argv);
    const out = jsonLine(result.stdout);
    const err = jsonLine(result.stderr);
    await writeFile(
      join(dir, `${step}-cli.txt`),
      [`argv: ${JSON.stringify(["junto", ...argv])}`, `exit code: ${String(result.exitCode)}`, "", "--- stdout ---", result.stdout, "--- stderr ---", result.stderr, ""].join("\n"),
      "utf8",
    );
    testInfo.annotations.push({ type: `step-${step}`, description: `exit ${String(result.exitCode)}; stdout ${result.stdout.trim().slice(0, 240)}; stderr ${result.stderr.trim().slice(0, 300)}` });
    return {
      result,
      out,
      err,
      data: (out?.data ?? {}) as Record<string, unknown>,
      // The hint of every CLI InputError is under error.details.hint.
      error: {
        ...((err?.error ?? {}) as { type?: unknown; message?: unknown }),
        hint: ((err?.error as { details?: { hint?: unknown } } | undefined)?.details?.hint) ??
          (err?.error as { hint?: unknown } | undefined)?.hint,
      },
    };
  };
  const input = (value: unknown): string => JSON.stringify(value);

  /** A pass: exit 0, a success envelope on stdout, nothing on stderr, and closed native rows. */
  const expectPass = (step: string, ran: Ran): void => {
    soft(ran.result.exitCode, `step ${step}: exit code`).toBe(0);
    soft(ran.out?.ok, `step ${step}: stdout is a success envelope: ${ran.result.stdout.trim().slice(0, 400)}`).toBe(true);
    soft(ran.err, `step ${step}: no failure envelope on stderr: ${ran.result.stderr.trim().slice(0, 400)}`).toBeUndefined();
    if ("nodes" in ran.data && "wires" in ran.data) {
      soft(() => Schema.decodeUnknownSync(Schema.Struct({
        name: Schema.String, seq: Seq, nodes: Schema.Array(Node), wires: Schema.Array(Wire),
      }), { onExcessProperty: "error" })(ran.data), `step ${step}: closed canvas read`).not.toThrow();
    }
    soft(() => validateRows(ran.out), `FAIL TO REPORT (step ${step}): the answer carries a row outside its native schema`).not.toThrow();
  };
  /** A refusal: exit 1, a failure envelope on stderr, nothing on stdout. */
  const expectRefusal = (step: string, ran: Ran): void => {
    soft(ran.result.exitCode, `step ${step}: exit code`).toBe(1);
    soft(ran.err?.ok, `step ${step}: stderr is a failure envelope: ${ran.result.stderr.trim().slice(0, 400)}`).toBe(false);
    soft(ran.result.stdout.trim(), `step ${step}: nothing printed on stdout`).toBe("");
    soft(`${ran.result.stdout}${ran.result.stderr}`, `step ${step}: the command is supported`).not.toContain("Unsupported");
  };
  /** A create or connect answer carries an id main minted. */
  const expectMinted = (step: string, what: string, id: unknown): string => {
    soft(typeof id === "string" && id.length > 0, `FAIL TO REPORT (step ${step}): the ${what} answer carries no id`).toBe(true);
    return typeof id === "string" ? id : "";
  };

  // The canvas as main holds it, and as it is drawn.
  const model = async (): Promise<{ readonly seq: number; readonly nodes: ReadonlyArray<ModelNode>; readonly wires: ReadonlyArray<ModelWire> }> => {
    const opened = await readModelCanvas(page, CANVAS);
    return { seq: opened.seq, nodes: opened.nodes as unknown as ReadonlyArray<ModelNode>, wires: opened.wires as unknown as ReadonlyArray<ModelWire> };
  };
  const nodeOf = async (id: string): Promise<ModelNode | undefined> => (await model()).nodes.find((node) => node.id === id);
  const counts = async (): Promise<string> => {
    const held = await model();
    return `${String(held.nodes.length)} nodes, ${String(held.wires.length)} wires`;
  };
  const card = (id: string): Locator => page.locator(`.react-flow__node[data-id="${id}"]`);
  /** A drawn wire: React Flow's edge element for its id, with the canvas's own path (canvas-wire-sockets.spec.ts:37). */
  const drawnWire = (id: string): Locator => page.locator(`[data-testid="rf__edge-${id}"] path.junto-edge`);
  /** A refusal left nothing behind: the model's counts are as before. */
  const expectNothingLanded = async (step: string, before: string, what: string): Promise<void> => {
    soft(await counts(), `FAIL TO REPORT (step ${step}): ${what} was refused yet left something on the canvas (before: ${before})`).toBe(before);
  };
  const connectedOf = async (step: string, seat: CrewSeat): Promise<ReadonlyArray<string>> => {
    const ran = await run(step, seat, ["onboard"]);
    soft(ran.result.exitCode, `step ${step}: junto onboard exits 0`).toBe(0);
    return ((ran.data.connected ?? []) as ReadonlyArray<{ readonly id?: unknown }>).map((entry) => String(entry.id));
  };

  try {
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
    await crewPlayFactory(page);

    // ── Staging ────────────────────────────────────────────────────────────
    const start = async (node: typeof O): Promise<CrewSeat> => {
      const seat = crewSeat(sandbox, CANVAS, node.id);
      await crewOccupySeat(page, CANVAS, node, seat);
      await expect.poll(() => seatState(page, node.id), { message: `seat ${node.id} state`, timeout: 30_000 }).toBe("idle");
      return seat;
    };
    const o = await start(O);
    const a = await start(A);
    await start(B);
    await grantOverseer(page, CANVAS, O.id);
    await expect(card(O.id).locator(".junto-node")).toHaveAttribute("data-overseer", "true", { timeout: 15_000 });
    expect((await model()).wires, "A and B are not wired to each other").toEqual([]);
    await shot("0-staged");

    // ── 1. canvas read ─────────────────────────────────────────────────────
    const s1 = await run("1", o, ["overseer", "canvas", "read"]);
    expectPass("1", s1);
    soft(s1.data.name, "step 1: data.name").toBe(CANVAS);
    soft(typeof s1.data.seq, "step 1: seq is a NUMBER").toBe("number");
    soft(Array.isArray(s1.data.nodes) && Array.isArray(s1.data.wires), "step 1: data has nodes and wires").toBe(true);
    const nodes1 = (s1.data.nodes ?? []) as ReadonlyArray<Record<string, unknown>>;
    soft(nodes1.map((node) => node.id).sort(), "step 1: the three seats").toEqual([A.id, B.id, O.id].sort());
    soft(nodes1.every((node) => typeof node.kind === "string" && node.kind.length > 0), "step 1: each node has a kind").toBe(true);
    const S = Number(s1.data.seq);
    soft(S, "step 1: the read's seq is the model's").toBe((await model()).seq);

    // ── 2. node create: a note ─────────────────────────────────────────────
    const s2 = await run("2", o, ["overseer", "node", "create", input({ node: { kind: "note", text: "Ship on green.", x: 0, y: 0, width: 220, height: 84 } })]);
    expectPass("2", s2);
    const made = (s2.data.node ?? {}) as Record<string, unknown>;
    const N = expectMinted("2", "node create", made.id);
    soft(made.kind, "step 2: the created node is a note").toBe("note");
    soft((await nodeOf(N))?.text, "step 2: the note is in the model, with its text").toBe("Ship on green.");
    await soft(card(N), "step 2: the note appears on the canvas").toBeVisible({ timeout: 15_000 });
    await soft(card(N)).toContainText("Ship on green.");
    await shot("2-note-created");

    // ── 3. node configure, and a change of the wrong kind ──────────────────
    const s3 = await run("3a", o, ["overseer", "node", "configure", input({ nodeId: N, change: { kind: "note", text: "Ship on green, then tag." } })]);
    expectPass("3", s3);
    soft((await nodeOf(N))?.text, "step 3: the model holds the new text").toBe("Ship on green, then tag.");
    await soft(card(N), "step 3: the note on the canvas shows the new text").toContainText("Ship on green, then tag.", { timeout: 15_000 });
    await shot("3-note-configured");
    const before3 = await counts();
    const s3b = await run("3b", o, ["overseer", "node", "configure", input({ nodeId: N, change: { kind: "region", label: "x" } })]);
    expectRefusal("3 (wrong kind)", s3b);
    soft(s3b.error.type, "step 3: InvalidArguments").toBe("InvalidArguments");
    soft(s3b.error.message, "step 3: the message names the node's actual kind").toBe(wrongKind(N));
    soft(String(s3b.error.message ?? ""), 'FAIL TO REPORT (step 3): the refusal does not say what to send instead').toContain('send a change whose kind is "note"');
    await expectNothingLanded("3", before3, "the wrong-kind change");
    soft((await nodeOf(N))?.kind, "step 3: the node is still a note").toBe("note");

    // ── 4. recolor and move ────────────────────────────────────────────────
    const s4 = await run("4a", o, ["overseer", "node", "recolor", input({ nodeIds: [N], color: "4" })]);
    expectPass("4 (recolor)", s4);
    soft((await nodeOf(N))?.color, "step 4: the note is recolored in the model").toBe("4");
    const s4b = await run("4b", o, ["overseer", "node", "move", input({ nodeId: N, x: 40, y: 80 })]);
    expectPass("4 (move)", s4b);
    const moved = await nodeOf(N);
    soft({ x: moved?.x, y: moved?.y }, "step 4: the note is moved in the model").toEqual({ x: 40, y: 80 });
    await soft(card(N), "step 4: the note is still drawn").toBeVisible();
    await shot("4-note-recolored-and-moved");

    // ── 5. wire verbs, connect, list ───────────────────────────────────────
    const s5 = await run("5a", o, ["overseer", "wire", "verbs", input({ from: A.id, to: B.id })]);
    expectPass("5 (verbs)", s5);
    soft((s5.data.verbs ?? []) as ReadonlyArray<unknown>, "step 5: the verbs include messages").toContain("messages");
    const s5b = await run("5b", o, ["overseer", "wire", "connect", input({ wire: { from: A.id, to: B.id, verb: "messages" } })]);
    expectPass("5 (connect)", s5b);
    const wire = (s5b.data.wire ?? {}) as Record<string, unknown>;
    const W = expectMinted("5", "wire connect", wire.id ?? s5b.data.wireId);
    soft({ from: wire.from, to: wire.to, verb: wire.verb }, "step 5: the answer carries the wire").toEqual({ from: A.id, to: B.id, verb: "messages" });
    soft((await model()).wires.find((held) => held.id === W), "step 5: the wire is in the model").toMatchObject({ from: A.id, to: B.id, verb: "messages" });
    await soft(drawnWire(W), "step 5: the wire is drawn").toHaveCount(1, { timeout: 15_000 });
    await shot("5-wire-connected");
    soft(await connectedOf("5c", a), "step 5: A's junto onboard lists B among its connected seats").toContain(B.id);
    const s5d = await run("5d", o, ["overseer", "wire", "list"]);
    expectPass("5 (list)", s5d);
    soft(
      ((s5d.data.wires ?? []) as ReadonlyArray<Record<string, unknown>>).find((held) => held.id === W),
      "step 5: wire list includes it, with from, to and verb",
    ).toMatchObject({ id: W, from: A.id, to: B.id, verb: "messages" });

    // ── 6. wire disconnect ─────────────────────────────────────────────────
    const s6 = await run("6a", o, ["overseer", "wire", "disconnect", input({ wireId: W })]);
    expectPass("6", s6);
    soft((await model()).wires.some((held) => held.id === W), "step 6: the wire is gone from the model").toBe(false);
    await soft(drawnWire(W), "step 6: the wire is no longer drawn").toHaveCount(0, { timeout: 15_000 });
    await shot("6-wire-disconnected");
    soft(await connectedOf("6b", a), "step 6: A's next junto onboard no longer lists B").not.toContain(B.id);

    // ── 7. the retired edge family, and the old field names ────────────────
    const before7 = await counts();
    const s7 = await run("7a", o, ["overseer", "edge", "connect", input({ edge: { fromNode: A.id, toNode: B.id, verb: "messages" } })]);
    expectRefusal("7 (edge connect)", s7);
    soft(s7.error.message, "step 7: stderr says edge.connect is now wire.connect").toBe(EDGE_RETIRED);
    soft(s7.error.hint ?? "", "step 7: with the hint to read the new shape").toBe(WIRE_SCHEMA_HINT);
    soft(
      s7.result.stderr.includes("wire.connect") && s7.result.stderr.includes("schema show wire.connect"),
      "FAIL TO REPORT (step 7, edge connect): the refusal does not say what to send instead",
    ).toBe(true);
    await expectNothingLanded("7", before7, "edge connect");
    const s7b = await run("7b", o, ["overseer", "wire", "connect", input({ wire: { fromNode: A.id, toNode: B.id } })]);
    expectRefusal("7 (old field names)", s7b);
    soft(s7b.error.type, "step 7: an InputError").toBe("InputError");
    soft(s7b.result.stderr, "step 7: it names the bad field").toMatch(/fromNode|toNode|"from"|from\b/u);
    soft(s7b.error.hint ?? "", "step 7: with the hint to run schema show").toBe(WIRE_SCHEMA_HINT);
    soft(s7b.result.stderr.includes("schema show wire.connect"), "FAIL TO REPORT (step 7, old field names): the refusal does not say what to send instead").toBe(true);
    await expectNothingLanded("7", before7, "wire connect with the old field names");
    soft(await page.locator('[data-testid^="rf__edge-"]').count(), "step 7: nothing is drawn").toBe(0);

    // ── 8. a seat draft, and two that name what only main works out ───────
    const s8 = await run("8a", o, ["overseer", "node", "create", input({ node: { kind: "agent", harness: CREATE_HARNESS, label: "Reviewer", x: 0, y: 200, width: 260, height: 120 } })]);
    expectPass("8 (create)", s8);
    const seat = (s8.data.node ?? {}) as Record<string, unknown>;
    const R = expectMinted("8", "seat create", seat.id);
    soft(seat.kind, "step 8: the created node is an agent seat").toBe("agent");
    const reviewer = await nodeOf(R);
    soft({ kind: reviewer?.kind, label: reviewer?.label, harness: reviewer?.harness, overseer: reviewer?.overseer }, "step 8: the seat in the model").toEqual({
      kind: "agent",
      label: "Reviewer",
      harness: CREATE_HARNESS,
      overseer: false,
    });
    await soft(card(R), "step 8: a seat named Reviewer appears").toContainText("Reviewer", { timeout: 15_000 });
    await soft(card(R).locator(".junto-node"), "step 8: it carries no overseer mark").not.toHaveAttribute("data-overseer", "true");
    soft(await seatState(page, R), "step 8: it is not started").toMatch(/^(none|gone)$/u);
    // `agent get` prints nodeId, canvas, agentKey, bindingId, hostId, harness, session, chatLive (overseer/native.ts:547-559): no grant among them.
    const s8get = await run("8b", o, ["overseer", "agent", "get", input({ nodeId: R })]);
    expectPass("8 (agent get)", s8get);
    soft(s8get.data.harness, "step 8: agent get shows its harness").toBe(CREATE_HARNESS);
    soft(/"overseer"\s*:\s*true/u.test(s8get.result.stdout), "step 8: agent get shows no grant").toBe(false);
    soft((s8get.data.session as { readonly status?: unknown } | undefined)?.status ?? "none", "step 8: agent get shows no live process").not.toBe("running");
    await shot("8-seat-created");

    const before8 = await counts();
    const s8c = await run("8c", o, [
      "overseer",
      "node",
      "create",
      input({ node: { kind: "agent", harness: CREATE_HARNESS, launch: { kind: "harness", argv: ["x"] }, x: 0, y: 400, width: 260, height: 120 } }),
    ]);
    expectRefusal("8 (draft with launch)", s8c);
    testInfo.annotations.push({ type: "step-8c-error-type", description: String(s8c.error.type) });
    soft(s8c.error.hint ?? "", "step 8: the refusal carries the hint to read the schema").toBe("junto overseer schema show node.create");
    soft(
      SEAT_DRAFT_SAYS.filter((word) => !s8c.result.stderr.includes(word)),
      "FAIL TO REPORT (step 8, draft with launch): the refusal does not say what a seat is created from and that main builds its launch",
    ).toEqual([]);
    await expectNothingLanded("8", before8, "the seat draft with a launch");
    const s8d = await run("8d", o, [
      "overseer",
      "node",
      "create",
      input({ node: { kind: "agent", harness: CREATE_HARNESS, overseer: true, x: 0, y: 400, width: 260, height: 120 } }),
    ]);
    expectRefusal("8 (draft with overseer)", s8d);
    testInfo.annotations.push({ type: "step-8d-error-type", description: String(s8d.error.type) });
    soft(s8d.result.stderr, "FAIL TO REPORT (step 8, draft with overseer): the refusal does not say what a seat is created from").toContain("A seat is created from harness, profile, model, effort, mode, permissionMode and cwd; Junto builds its launch. Remove: overseer");
    await expectNothingLanded("8", before8, "the seat draft naming overseer");
    soft((await model()).nodes.filter((node) => node.kind === "agent" && node.overseer === true).map((node) => node.id), "step 8: O is still the only overseer").toEqual([O.id]);

    // ── 9. reseat ──────────────────────────────────────────────────────────
    const s9 = await run("9a", o, ["overseer", "agent", "reseat", input({ nodeId: R, harness: RESEAT_HARNESS })]);
    expectPass("9 (reseat)", s9);
    soft(s9.data.harness, "step 9: the answer names the new harness").toBe(RESEAT_HARNESS);
    await soft.poll(async () => (await nodeOf(R))?.harness, { message: "step 9: the seat in the model shows the new harness", timeout: 15_000 }).toBe(RESEAT_HARNESS);
    const reseated = JSON.stringify(await nodeOf(R));
    await shot("9-reseated");
    const s9b = await run("9b", o, ["overseer", "agent", "reseat", input({ nodeId: R, harness: RESEAT_HARNESS, launch: { kind: "harness", argv: ["x"] } })]);
    expectRefusal("9 (reseat with launch)", s9b);
    testInfo.annotations.push({ type: "step-9b-error-type", description: String(s9b.error.type) });
    soft(JSON.stringify(await nodeOf(R)), "step 9: the seat is unchanged by the refused reseat").toBe(reseated);
    const overseerBefore = JSON.stringify(await nodeOf(O.id));
    const s9c = await run("9c", o, ["overseer", "agent", "reseat", input({ nodeId: O.id, harness: RESEAT_HARNESS })]);
    expectRefusal("9 (reseat the overseer)", s9c);
    soft(s9c.error.type, "step 9: Forbidden").toBe("Forbidden");
    soft(s9c.error.message, "step 9: only the operator may").toBe(OPERATOR_ONLY);
    soft(JSON.stringify(await nodeOf(O.id)), "step 9: O is unchanged").toBe(overseerBefore);
    soft((await nodeOf(O.id))?.overseer, "step 9: O is still the overseer in the model").toBe(true);
    await soft(card(O.id).locator(".junto-node"), "step 9: O still carries the overseer mark").toHaveAttribute("data-overseer", "true");
    const s9get = await run("9d", o, ["overseer", "agent", "get", input({ nodeId: O.id })]);
    expectPass("9 (agent get O)", s9get);
    soft(s9get.data.harness, "step 9: agent get shows O on its harness still").toBe(CREATE_HARNESS);

    // ── 10. canvas batch, against the seq ─────────────────────────────────
    const s10 = await run("10a", o, ["overseer", "canvas", "read"]);
    expectPass("10 (read)", s10);
    const S2 = Number(s10.data.seq);
    soft(typeof s10.data.seq, "step 10: seq is a number").toBe("number");
    soft(S2, "step 10: the canvas has moved since step 1").toBeGreaterThan(S);
    testInfo.annotations.push({ type: "seq", description: `<S> ${String(S)}, <S2> ${String(S2)}` });

    const before10 = await counts();
    const s10b = await run("10b", o, [
      "overseer",
      "canvas",
      "batch",
      input({ expectedSeq: S, steps: [{ operation: "node.create", node: { kind: "note", text: "stale", x: 0, y: 600, width: 220, height: 84 } }] }),
    ]);
    expectRefusal("10 (stale)", s10b);
    soft(s10b.error.type, "step 10: a Conflict").toBe("Conflict");
    soft(STALE_SAYS.filter((word) => !String(s10b.error.message ?? "").includes(word)), "FAIL TO REPORT (step 10, stale): the refusal does not say what to do instead").toEqual([]);
    await expectNothingLanded("10", before10, "the stale batch");
    soft((await model()).nodes.some((node) => node.text === "stale"), "step 10: no note with text stale").toBe(false);
    soft((await model()).seq, "step 10: a refused batch does not move the seq").toBe(S2);

    const s10c = await run("10c", o, [
      "overseer",
      "canvas",
      "batch",
      input({
        expectedSeq: S2,
        steps: [
          { operation: "node.create", node: { kind: "note", id: "batch-note", text: "fresh", x: 0, y: 600, width: 220, height: 84 } },
          { operation: "wire.connect", wire: { from: A.id, to: B.id, verb: "messages" } },
        ],
      }),
    ]);
    expectPass("10 (batch)", s10c);
    const results = (s10c.data.results ?? []) as ReadonlyArray<Record<string, unknown>>;
    soft(results.length, "step 10: one result per step").toBe(2);
    const batchNote = expectMinted("10", "batch node create", results[0]?.nodeId ?? (results[0]?.node as { id?: unknown } | undefined)?.id);
    soft(batchNote, "step 10: the note keeps the id it was given").toBe("batch-note");
    const W2 = expectMinted("10", "batch wire connect", results[1]?.wireId ?? (results[1]?.wire as { id?: unknown } | undefined)?.id);
    const after10 = await model();
    soft((await nodeOf("batch-note"))?.text, "step 10: the note is in the model").toBe("fresh");
    soft(after10.wires.find((held) => held.id === W2), "step 10: the wire is in the model").toMatchObject({ from: A.id, to: B.id, verb: "messages" });
    // One Batch, so the canvas moves once (overseer/canvas.ts:319-323).
    soft(after10.seq, "step 10: both landed in one change: seq moved once past <S2>").toBe(S2 + 1);
    await soft(card("batch-note"), "step 10: the note appears on the canvas").toContainText("fresh", { timeout: 15_000 });
    await soft(drawnWire(W2), "step 10: the wire is drawn").toHaveCount(1, { timeout: 15_000 });
    await shot("10-batch-landed");

    const before10d = await counts();
    const seqBefore10d = (await model()).seq;
    const s10d = await run("10d", o, [
      "overseer",
      "canvas",
      "batch",
      input({
        expectedSeq: seqBefore10d,
        steps: [
          { operation: "node.create", node: { kind: "note", id: "half-note", text: "half", x: 0, y: 760, width: 220, height: 84 } },
          { operation: "wire.connect", wire: { from: A.id, to: "no-such-node", verb: "messages" } },
        ],
      }),
    ]);
    expectRefusal("10 (half invalid)", s10d);
    testInfo.annotations.push({ type: "step-10d-error", description: `${String(s10d.error.type)}: ${String(s10d.error.message)}` });
    await expectNothingLanded("10", before10d, "the batch whose second step is invalid");
    soft(await nodeOf("half-note"), "step 10: NEITHER step landed: no new note").toBeUndefined();
    soft((await model()).seq, "step 10: and the seq did not move").toBe(seqBefore10d);
    await soft(card("half-note"), "step 10: nor is it drawn").toHaveCount(0);

    // ── 11. node delete ────────────────────────────────────────────────────
    const s11 = await run("11a", o, ["overseer", "node", "delete", input({ nodeIds: [N, "batch-note", R] })]);
    expectPass("11 (delete)", s11);
    const left = (await model()).nodes.map((node) => node.id);
    soft([N, "batch-note", R].filter((id) => left.includes(id)), "step 11: all three are gone from the model").toEqual([]);
    for (const id of [N, "batch-note", R]) await soft(card(id), `step 11: ${id} is no longer drawn`).toHaveCount(0, { timeout: 15_000 });
    await shot("11-deleted");
    const before11 = await counts();
    const s11b = await run("11b", o, ["overseer", "node", "delete", input({ nodeIds: [O.id] })]);
    expectRefusal("11 (delete its own seat)", s11b);
    soft(s11b.error.type, "step 11: Forbidden").toBe("Forbidden");
    soft(s11b.error.message, "step 11: an overseer cannot delete its own seat").toBe(OWN_SEAT);
    await expectNothingLanded("11", before11, "deleting the overseer's own seat");
    soft((await nodeOf(O.id))?.overseer, "step 11: O is still there, and still the overseer").toBe(true);
    await soft(card(O.id), "step 11: and still drawn").toBeVisible();
    await shot("11-at-the-end");
  } catch (error) {
    await shot("on-failure");
    throw error;
  } finally {
    await junto.close();
  }
});
