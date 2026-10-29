/**
 * Real app, release checklist T1 to T4 and L5, the CLI half a seat drives:
 * `create --label` folds case, `show` lists the labels, `label --set` sets
 * the whole set and an empty one clears it, the cap of 20 and a bad label
 * refuse; `create` and `edit` resolve `[[Title]]`, zero or several matches
 * refuse with the candidates, and `show` lists linked from: a body link and a
 * mail that links it. Each check is reported on its own.
 *   bun run test:e2e:fast e2e/scenarios/artifact-cli-verify.spec.ts
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mentionLink } from "../../src/shared/mention";
import { asNodeId } from "../../src/shared/model";
import { crewOccupySeat, crewPlayFactory, crewSeat, installCrewSeatHarness } from "../harness/crew-fixture";
import { expect, launchJunto, test } from "../harness/launch";
import { modelFixture, modelNode, modelRegion, modelSeat, modelWire } from "../harness/model";

const CANVAS = "artifact-cli-verify";

type Result = { row: string; pass: boolean; detail?: string };
type Json = { ok?: boolean; data?: Record<string, unknown>; error?: unknown };

test("artifact CLI: labels fold, set, clear and cap; [[Title]] resolves or refuses with candidates; show lists linked from", async () => {
  test.setTimeout(300_000);
  const scout = modelSeat({ id: "scout", key: "local:cli-scout", label: "Scout", harness: "codex", cwd: mkdtempSync(join(tmpdir(), "junto-cli-scout-")), x: 40, y: 60 });
  const ada = modelSeat({ id: "ada", key: "local:cli-ada", label: "Ada", harness: "codex", cwd: mkdtempSync(join(tmpdir(), "junto-cli-ada-")), x: 300, y: 60 });
  const nodes = [
    modelRegion({ id: "ops", label: "Ops", x: 0, y: 0, width: 900, height: 420 }),
    scout,
    ada,
    modelNode({ kind: "artifacts", id: "shelf", label: "Shelf", x: 560, y: 60, width: 260, height: 140, z: 0 }),
  ];
  const junto = await launchJunto({
    windowContentSize: { width: 1400, height: 860 },
    seedModels: { [CANVAS]: modelFixture(nodes, [modelWire("e-scout-ada", "scout", "ada", "messages", nodes)]) },
    afterSeed: installCrewSeatHarness,
  });
  const results: Result[] = [];
  const check = async (row: string, run: () => Promise<void>): Promise<void> => {
    try {
      await run();
      results.push({ row, pass: true });
    } catch (error) {
      results.push({ row, pass: false, detail: String(error).replace(/\u001b\[[0-9;]*m/gu, "").split("\n").slice(0, 6).join(" ") });
    }
  };
  try {
    const { page, sandbox } = junto;
    await expect(page.locator('.react-flow__node[data-id="shelf"]')).toBeVisible({ timeout: 30_000 });
    const seat = crewSeat(sandbox, CANVAS, "scout");
    await crewPlayFactory(page);
    await crewOccupySeat(page, CANVAS, scout, seat);
    expect((await seat.op("onboard", {})).ok, "scout onboards").toBe(true);
    const cli = async (argv: ReadonlyArray<string>): Promise<{ json: Json; raw: string }> => {
      const result = await seat.cli(argv);
      const out = (result.stdout.trim() === "" ? result.stderr : result.stdout).trim();
      if (!out.startsWith("{")) throw new Error(`junto ${argv.join(" ")} exit ${String(result.exitCode)}:\n${result.stdout.slice(0, 800)}\n${result.stderr.slice(0, 800)}`);
      return { json: JSON.parse(out) as Json, raw: out };
    };
    const idOf = (j: Json): string => {
      const d = j.data as { artifactId?: string; id?: string; artifact?: { artifactId?: string; id?: string } } | undefined;
      const id = d?.artifactId ?? d?.id ?? d?.artifact?.artifactId ?? d?.artifact?.id;
      if (typeof id !== "string") throw new Error(`no id in ${JSON.stringify(j).slice(0, 400)}`);
      return id;
    };
    const show = async (id: string) => (await cli(["artifact", "show", id])).raw;

    // T: labels through the CLI.
    const brief = await cli(["artifact", "create", "Brief", "--type", "document", "--markdown", "# Brief", "--label", "Draft", "--label", "Project/Junto"]);
    const briefId = idOf(brief.json);
    await check("create --label folds case and show lists the labels", async () => {
      const raw = await show(briefId);
      expect(raw).toContain('"draft"');
      expect(raw).toContain('"project/junto"');
      expect(raw).not.toContain('"Draft"');
    });
    await check("label --set sets the whole set", async () => {
      expect((await cli(["artifact", "label", briefId, "--set", "alpha,beta"])).json.ok).toBe(true);
      const raw = await show(briefId);
      expect(raw).toContain('"alpha"');
      expect(raw).not.toContain('"draft"');
    });
    await check("label --set '' clears them", async () => {
      expect((await cli(["artifact", "label", briefId, "--set", ""])).json.ok).toBe(true);
      expect(await show(briefId)).toMatch(/"labels":\[\]/u);
    });
    await check("the cap of 20 refuses a 21st label", async () => {
      const many = Array.from({ length: 21 }, (_, i) => `l${String(i)}`).join(",");
      const r = await cli(["artifact", "label", briefId, "--set", many]);
      expect(r.json.ok, r.raw.slice(0, 300)).toBe(false);
      console.log("T-CAP", r.raw.slice(0, 400));
      expect((await cli(["artifact", "label", briefId, "--set", Array.from({ length: 20 }, (_, i) => `l${String(i)}`).join(",")])).json.ok).toBe(true);
    });
    await check("a label outside a-z 0-9 - _ / space refuses", async () => {
      const r = await cli(["artifact", "label", briefId, "--set", "bad!"]);
      expect(r.json.ok, r.raw.slice(0, 300)).toBe(false);
      console.log("T-BAD", r.raw.slice(0, 400));
    });

    // L5: [[Title]] in create and edit.
    const target = idOf((await cli(["artifact", "create", "Target note", "--type", "document", "--markdown", "# Target note"])).json);
    const source = await cli(["artifact", "create", "Source note", "--type", "document", "--markdown", "See [[Target note]] first."]);
    const sourceId = idOf(source.json);
    await check("create resolves [[Title]] to the artifact's id", async () => {
      expect(source.json.ok, source.raw.slice(0, 300)).toBe(true);
      expect(await show(sourceId)).toContain(target);
    });
    const twinA = idOf((await cli(["artifact", "create", "Twin", "--type", "document", "--markdown", "# Twin"])).json);
    const twinB = idOf((await cli(["artifact", "create", "Twin", "--type", "document", "--markdown", "# Twin"])).json);
    const base = (raw: string): number => Number((raw.match(/"version":(\d+)/u) ?? [])[1]);
    await check("edit resolves [[Title]]", async () => {
      const r = await cli(["artifact", "edit", sourceId, "--base", String(base(await show(sourceId))), "--markdown", "Now [[Target note]] again."]);
      expect(r.json.ok, r.raw.slice(0, 300)).toBe(true);
      expect(await show(sourceId)).toContain("again");
    });
    await check("zero matches refuse", async () => {
      const r = await cli(["artifact", "edit", sourceId, "--base", String(base(await show(sourceId))), "--markdown", "See [[No such title]]."]);
      expect(r.json.ok, r.raw.slice(0, 300)).toBe(false);
      console.log("L-ZERO", r.raw.slice(0, 500));
    });
    await check("several matches refuse with the candidates", async () => {
      const r = await cli(["artifact", "create", "Pair note", "--type", "document", "--markdown", "See [[Twin]]."]);
      expect(r.json.ok, r.raw.slice(0, 300)).toBe(false);
      expect(r.raw).toContain(twinA);
      expect(r.raw).toContain(twinB);
      console.log("L-SEVERAL", r.raw.slice(0, 600));
    });

    // Linked from: the body link, then a mail that links it.
    const link = mentionLink({ kind: "artifact", nodeId: asNodeId("shelf"), artifactId: target as never }, "[[Target note]]", CANVAS);
    const sent = await cli(["msg", "send", JSON.stringify({ target: "Ada", text: `Read ${link} before standup.` })]);
    console.log("L-MAIL", sent.raw.slice(0, 300));
    await check("show lists linked from: the body link", async () => {
      const raw = await show(target);
      expect(raw).toContain("linkedFrom");
      expect(raw.slice(raw.indexOf("linkedFrom"))).toContain(sourceId);
    });
    await check("show lists linked from: the mail", async () => {
      await expect.poll(async () => {
        const raw = await show(target);
        return /mail|message/iu.test(raw.slice(raw.indexOf("linkedFrom")));
      }, { timeout: 15_000 }).toBe(true);
    });
    console.log("L-SHOW", (await show(target)).slice(0, 1500));
  } finally {
    console.log("CLI", JSON.stringify(results));
    await junto.close();
  }
  for (const r of results) expect.soft(r.pass, `${r.row}: ${r.detail ?? ""}`).toBe(true);
});
