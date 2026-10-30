/**
 * Real app: Files quick open (Cmd+P) on a large root, timed per fresh query.
 * The root and its file list come from the environment (the F2 200k fixture:
 * make_fixture.py, seed 1100). Each query starts from an empty field and is
 * set whole, as one input event; the time is from that event to the first
 * animation frame that shows the final rows, held for 8 frames. The queries
 * are drawn as the index bench draws them: 6 letters, path-like, scattered,
 * 3 letters and no match. Every query's top rows and count are written out,
 * so two builds can be compared for the same results.
 *   JUNTO_QO_ROOT=<repo> JUNTO_QO_PATHS=<list> JUNTO_SHOTS_DIR=<dir> scripts/run-e2e.sh e2e/scenarios/files-quick-open-latency.spec.ts
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { loadavg } from "node:os";
import { join } from "node:path";
import { filesNode, openFilesModal } from "../harness/files-scenario";
import { expect, launchJunto, test } from "../harness/launch";
import { modelFixture } from "../harness/model";

const CANVAS = "files-quick-open-latency";
const ROOT = process.env.JUNTO_QO_ROOT ?? "";
const PATHS = process.env.JUNTO_QO_PATHS ?? "";
const ROUNDS = Number(process.env.JUNTO_QO_ROUNDS ?? 3);
const OUT = process.env.JUNTO_SHOTS_DIR ?? "test-results/files-quick-open-latency";

const groupsOf = (paths: ReadonlyArray<string>): Record<string, string[]> => {
  let seed = 7;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const picked = Array.from({ length: 200 }, () => paths[Math.floor(rand() * paths.length)]!);
  const names = picked.map((p) => p.split("/").pop()!.toLowerCase().replace(/[^a-z]/gu, ""));
  const segs = picked.map((p) => p.toLowerCase().split("/"));
  const long = names.filter((n) => n.length >= 6);
  const scatter = (n: string) => n.split("").filter((_, i) => i % 2 === 0).join("").slice(0, 6);
  return {
    "6 letters": long.slice(0, 40).map((n) => n.slice(0, 6)),
    "path-like": segs.filter((s) => s.length >= 2).slice(0, 30).map((s) => `${s[0]!.slice(0, 3)}/${s[1]!.slice(0, 4)}`),
    scattered: long.slice(40, 70).map(scatter),
    "3 letters": names.slice(40, 80).map((n) => n.slice(0, 3)).filter((q) => q.length === 3),
    "no match": ["zqxj", "qqqqq", "xzxzxz", "jjjkkk", "zzqq", "vvvxx", "qxq", "wqzv", "kqzx", "zzzzzz"],
  };
};

const pct = (v: ReadonlyArray<number>, p: number): number => {
  const s = [...v].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]! * 10) / 10;
};

test("files quick open: fresh query latency on a large root", async () => {
  test.setTimeout(1_800_000);
  expect(ROOT, "JUNTO_QO_ROOT").not.toBe("");
  const paths = readFileSync(PATHS, "utf8").split("\n").filter((p) => p !== "");
  const groups = groupsOf(paths);
  const junto = await launchJunto({ windowContentSize: { width: 1500, height: 900 }, seedModels: { [CANVAS]: modelFixture([filesNode(ROOT)]) } });
  const { page } = junto;
  const times: Record<string, number[]> = {};
  const results: Record<string, { count: string; top: string[] }> = {};
  const loads: number[][] = [loadavg()];
  try {
    const modal = await openFilesModal(page);
    await expect(modal.getByRole("treeitem").first()).toBeVisible({ timeout: 120_000 });
    await page.keyboard.press("Meta+p");
    const field = page.getByTestId("quick-open-input");
    await expect(field).toBeFocused({ timeout: 10_000 });

    /** Sets the field whole and times the input event to the first frame of the final rows. */
    const time = (query: string) =>
      page.evaluate(async (q) => {
        const input = document.querySelector('[data-testid="quick-open-input"]') as HTMLInputElement;
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
        const card = document.querySelector('[data-testid="quick-open"]') as HTMLElement;
        const sign = () =>
          `${card.querySelector(".quick-open__count")?.textContent ?? ""}|${card.querySelector(".quick-open__empty")?.textContent ?? ""}|${[...card.querySelectorAll(".quick-open__row")].slice(0, 5).map((r) => r.textContent).join("/")}`;
        const frame = () => new Promise<number>((done) => requestAnimationFrame((t) => done(t)));
        const settle = async (from: string, limit: number) => {
          let last = sign();
          let since = performance.now();
          let firstChange = last !== from ? since : -1;
          let held = 0;
          const end = performance.now() + limit;
          while (performance.now() < end) {
            const at = await frame();
            const now = sign();
            if (now !== last) {
              last = now;
              since = at;
              held = 0;
              if (firstChange < 0 && now !== from) firstChange = at;
            } else if (now !== from && (held += 1) >= 8) break;
          }
          return { sign: last, at: since };
        };
        set.call(input, "");
        input.dispatchEvent(new Event("input", { bubbles: true }));
        const empty = await settle("\u0000", 2000);
        const t0 = performance.now();
        set.call(input, q);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        const done = await settle(empty.sign, 5000);
        return {
          ms: done.at - t0,
          count: card.querySelector(".quick-open__count")?.textContent ?? card.querySelector(".quick-open__empty")?.textContent ?? "",
          top: [...card.querySelectorAll(".quick-open__row")].slice(0, 5).map((r) => r.textContent ?? ""),
        };
      }, query);

    // Warm the index and the renderer before anything is counted.
    for (const q of ["readme", "src/comp", "index"]) await time(q);
    for (let round = 0; round < ROUNDS; round += 1) {
      for (const [group, queries] of Object.entries(groups)) {
        for (const q of queries) {
          const r = await time(q);
          (times[group] ??= []).push(r.ms);
          if (round === 0) results[q] = { count: r.count, top: r.top };
        }
      }
      loads.push(loadavg());
    }
  } finally {
    mkdirSync(OUT, { recursive: true });
    const fresh = Object.entries(times).filter(([g]) => g !== "3 letters" && g !== "no match").flatMap(([, v]) => v);
    const summary = Object.fromEntries([
      ...Object.entries(times).map(([g, v]) => [g, { n: v.length, p50: pct(v, 50), p95: pct(v, 95), max: pct(v, 100) }]),
      ["all groups", { n: Object.values(times).flat().length, p50: pct(Object.values(times).flat(), 50), p95: pct(Object.values(times).flat(), 95), max: pct(Object.values(times).flat(), 100) }],
      ["all fresh (6, path, scattered)", fresh.length === 0 ? null : { n: fresh.length, p50: pct(fresh, 50), p95: pct(fresh, 95), max: pct(fresh, 100) }],
    ]);
    writeFileSync(join(OUT, "latency.json"), JSON.stringify({ summary, loads, times, results }, null, 2));
    console.log("QO-LATENCY", JSON.stringify({ summary, loads }));
    await junto.close();
  }
});
