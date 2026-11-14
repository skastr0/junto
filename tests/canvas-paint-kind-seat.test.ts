import { describe, expect, it } from "vitest";
import { TIER_BIT, type KindLive, type Quad } from "../src/window/canvas/contract";
import { paintKindSeat, KIND_HUE } from "../src/window/canvas/paint/kind-seat";
import { SEAT_RING_CENTRE, SEAT_TEXT } from "../src/window/canvas/paint/card-spec";
import { BAND_PERIOD_MS } from "../src/window/lib/kind-band";
import { fakeEnv, kindFact, view } from "./canvas-paint-fixtures";

const KINDS = ["terminal", "task", "artifacts", "automations", "page", "git", "files", "link", "file"] as const;
const STATES: ReadonlyArray<KindLive["state"]> = ["resting", "working", "waiting", "review", "blocked", "done", "offline"];
const at = (quads: ReadonlyArray<Quad>, tier: keyof typeof TIER_BIT): ReadonlyArray<Quad> => quads.filter((q) => (q.tiers & TIER_BIT[tier]) !== 0);
const keys = (quads: ReadonlyArray<Quad>): string[] => quads.map((q) => q.key);
const paint = (kind: string, live: Partial<KindLive> = {}, v = view(), cap?: number) => paintKindSeat(kindFact(kind, live, cap), v, fakeEnv);

describe("kind seat paint", () => {
  it("every kind in every state paints a shell, ring, icon and name at near", () => {
    for (const kind of KINDS) {
      for (const state of STATES) {
        const quads = at(paint(kind, { state }).quads, "near");
        expect(keys(quads), `${kind} ${state}`).toEqual(expect.arrayContaining(["shell", "icon", "name", "line"]));
        expect(quads.some((q) => q.key.startsWith("ring."))).toBe(true);
      }
    }
  });

  it("mid keeps the shell, ring, band and a centred name; no line", () => {
    const quads = paint("task", { state: "working", ledger: { kind: "task", finished: 1, open: 2, asks: 0, stuck: 0, backlog: 1 } }).quads;
    const mid = at(quads, "mid");
    expect(keys(mid)).toEqual(expect.arrayContaining(["shell.mid", "icon", "name.mid", "band.0"]));
    expect(keys(mid)).not.toContain("shell");
    expect(keys(mid)).not.toContain("line");
    expect(keys(mid)).not.toContain("name");
    expect(mid.find((q) => q.key === "name.mid")?.rect.y).toBeCloseTo(SEAT_RING_CENTRE.y - (16 * 1.375) / 2);
  });

  it("mid hugs the name and enqueue and enlarges the name to 16", () => {
    const short = paint("task", { name: "Ada" }).quads;
    const shortShell = short.find((q) => q.key === "shell.mid")!;
    expect(shortShell.rect.width).toBe(108);
    expect(shortShell.style.stroke).toEqual({ color: { token: "stroke", alpha: 0.55 }, width: 1 });
    const name = short.find((q) => q.key === "name.mid")!;
    expect(name.text?.size).toBe(16);
    expect(name.text?.weight).toBe(600);
    const withEnqueue = paint("task", { enqueue: true, name: "board" }).quads;
    const shell = withEnqueue.find((q) => q.key === "shell.mid")!;
    const enqueue = withEnqueue.find((q) => q.key === "enqueue.mid")!;
    expect(shell.rect.width).toBe(147);
    expect(enqueue.rect.x).toBe(116);
    expect(enqueue.rect.width).toBe(20);
  });

  it("far and overview have no shell, text or band; ring and icon are held by the seat scale from the ring cap", () => {
    const quads = paint("git", { state: "working" }, view(), 2.5).quads;
    for (const tier of ["far", "overview"] as const) {
      const t = at(quads, tier);
      expect(keys(t)).not.toContain("shell");
      expect(keys(t)).not.toContain("name");
      expect(keys(t)).not.toContain("line");
      expect(t.some((q) => q.key.startsWith("band."))).toBe(false);
      expect(t.find((q) => q.key === "icon")?.scale).toEqual({ kind: "seat", cap: 2.5, anchor: SEAT_RING_CENTRE });
      expect(t.some((q) => q.key.startsWith("ring."))).toBe(true);
    }
  });

  it("the ring is the seat's grammar for the state", () => {
    const motion = (state: KindLive["state"]) => paint("terminal", { state }).quads.find((q) => q.key === "ring.spin")?.motion;
    expect(motion("working")).toEqual({ kind: "turn", periodMs: 1440 });
    const call = paint("terminal", { state: "waiting" }).quads.find((q) => q.key === "ring.pulse")?.motion;
    expect(call).toEqual({ kind: "send", periodMs: 1440 });
    expect(paint("terminal", { state: "review" }).quads.find((q) => q.key === "ring.pulse")?.motion).toEqual(call);
    expect(paint("terminal", { state: "blocked" }).quads.find((q) => q.key === "ring.pulse")?.motion).toEqual({ kind: "beat", periodMs: 1440 });
    const done = paint("terminal", { state: "done", stateSince: 9000 }).quads;
    expect(done.find((q) => q.key === "ring.land")?.motion).toEqual({ kind: "land", since: 9000 });
    expect(paint("terminal", { state: "resting" }).quads.filter((q) => q.motion?.kind === "turn" && q.key.startsWith("ring."))).toEqual([]);
    expect(paint("terminal", { state: "offline" }).quads.some((q) => q.key === "ring.core")).toBe(true);
  });

  it("a working task has the chase layer as a turn on its band period", () => {
    const quads = paint("task", { state: "working", ledger: { kind: "task", finished: 1, open: 2, asks: 0, stuck: 0, backlog: 0 } }).quads;
    const moving = quads.filter((q) => q.key.startsWith("band.") && q.motion !== undefined);
    expect(moving).toHaveLength(1);
    expect(moving[0]!.motion).toEqual({ kind: "turn", periodMs: BAND_PERIOD_MS.chase });
    expect(quads.filter((q) => q.key.startsWith("band.") && q.motion === undefined).length).toBeGreaterThan(0);
    // Bands sit in the 52 ring box, over the ring base and under the icon.
    const band = quads.find((q) => q.key === "band.0")!;
    expect(band.rect).toEqual({ x: 2, y: 2, width: 52, height: 52 });
    expect(band.z).toBeLessThan(quads.find((q) => q.key === "icon")!.z);
  });

  it("a resting kind has a still band and no moving layer; blocked waits on a pulse or shake", () => {
    const rest = paint("artifacts", { state: "resting", ledger: { kind: "artifacts", count: 5 } }).quads;
    expect(rest.filter((q) => q.key.startsWith("band.") && q.motion)).toEqual([]);
    const blocked = paint("automations", { state: "blocked", ledger: { kind: "automations", on: 2, off: 1, failed: 1 } }).quads;
    expect(blocked.find((q) => q.key.startsWith("band.") && q.motion)?.motion).toEqual({ kind: "shake", periodMs: BAND_PERIOD_MS.shake });
  });

  it("the selected shell takes the kind's own hue and lifts a seat shadow; hover is stroke over raise", () => {
    for (const kind of KINDS) {
      const sel = paint(kind, {}, view({ selected: true }));
      const shell = sel.quads.find((q) => q.key === "shell")!;
      expect(shell.style.stroke?.color).toEqual({ token: KIND_HUE[kind], alpha: 0.6 });
      expect(shell.style.fill).toEqual({ kind: "flat", color: { mix: [{ token: KIND_HUE[kind] }, { token: "raise" }], share: 0.1 } });
      expect(keys(sel.quads)).toContain("shell.shadow");
      expect(sel.lift).toBe(0);
      const drop = sel.quads.find((q) => q.key === "shell.shadow")!;
      expect(drop.rect.width).toBe(216 + 40);
      expect(drop.hole).toBe(20);
    }
    const hover = paint("link", {}, view({ hovered: true }));
    expect(hover.quads.find((q) => q.key === "shell")?.style.stroke?.color).toEqual({ token: "stroke" });
    expect(hover.lift).toBe(1);
    expect(keys(paint("link").quads)).not.toContain("shell.shadow");
  });

  it("line ink follows the state", () => {
    const ink = (state: KindLive["state"]) => paint("task", { state }).quads.find((q) => q.key === "line")?.style.ink;
    expect(ink("working")).toEqual({ token: "cyan-fg" });
    expect(ink("waiting")).toEqual({ token: "amber-fg" });
    expect(ink("review")).toEqual({ token: "amber-fg" });
    expect(ink("blocked")).toEqual({ token: "crimson-fg" });
    expect(ink("done")).toEqual({ token: "green" });
    expect(ink("offline")).toEqual({ token: "faint" });
    expect(ink("resting")).toEqual({ token: "dim" });
  });

  it("the files drop target is a dashed cyan inset with an 8% fill, near and mid only", () => {
    const drop = paint("files", { dropTarget: true }).quads.find((q) => q.key === "drop")!;
    expect(drop.rect).toEqual({ x: 2, y: 2, width: 212, height: 52 });
    expect(drop.style.stroke?.dash).toBeDefined();
    expect(drop.style.fill).toEqual({ kind: "flat", color: { token: "cyan", alpha: 0.08 } });
    expect(drop.tiers).toBe(TIER_BIT.near | TIER_BIT.mid);
    expect(keys(paint("files").quads)).not.toContain("drop");
  });

  it("the task card's enqueue is a 20 pill with a taskEnqueue part after the name, at near and mid", () => {
    const quads = paint("task", { enqueue: true, name: "board" }).quads;
    const enqueue = quads.find((q) => q.key === "enqueue")!;
    expect(enqueue.part).toEqual({ kind: "taskEnqueue" });
    expect(enqueue.rect.width).toBe(20);
    const name = quads.find((q) => q.key === "name")!;
    expect(name.rect.width).toBeLessThan(SEAT_TEXT.width);
    expect(enqueue.rect.x).toBeCloseTo(name.rect.x + name.rect.width + 4);
    expect(enqueue.tiers).toBe(TIER_BIT.near);
    // Mid keeps the name row, so the plus stays, centred with it on the ring.
    const midEnqueue = quads.find((q) => q.key === "enqueue.mid")!;
    expect(midEnqueue.part).toEqual({ kind: "taskEnqueue" });
    expect(midEnqueue.tiers).toBe(TIER_BIT.mid);
    expect(midEnqueue.rect.y).toBeCloseTo(SEAT_RING_CENTRE.y - 10);
    expect(keys(paint("task").quads)).not.toContain("enqueue");
  });

  it("the terminal strip hangs under the line at near", () => {
    const quads = paint("terminal", { tasks: { state: "working", label: "#12", title: "fix the thing", more: 2 } }).quads;
    expect(keys(quads)).toEqual(expect.arrayContaining(["task.mark", "task.label", "task.title", "task.more"]));
    const line = quads.find((q) => q.key === "line")!;
    expect(quads.find((q) => q.key === "task.label")!.rect.y).toBeGreaterThan(line.rect.y);
    expect(quads.find((q) => q.key === "task.more")?.text?.text).toBe("+2");
  });

  it("far halo says call, wait and halt; far hover blooms the full card instead of the tag", () => {
    expect(paint("page", { state: "waiting" }).quads.find((q) => q.key === "halo.inner")?.style.stroke?.color).toEqual({ token: "amber", alpha: 0.92 });
    expect(paint("page", { state: "blocked" }).quads.find((q) => q.key === "halo.outer")?.style.stroke?.color).toEqual({ token: "crimson", alpha: 0.3 });
    expect(keys(paint("page", { state: "working" }).quads)).not.toContain("halo.inner");
    const hov = paint("page", {}, view({ hovered: true })).quads;
    expect(keys(hov)).toContain("hover.name");
    expect(keys(hov)).toContain("hover.line");
    expect(hov.find((q) => q.key === "tag")?.tiers).toBe(TIER_BIT.overview);
    expect(hov.find((q) => q.key === "hover.icon")?.scale).toEqual({ kind: "hover", anchor: SEAT_RING_CENTRE });
    expect(keys(paint("page").quads)).not.toContain("tag");
  });

  it("hover hides the mid pill and the base far ring; the bloom takes their tier", () => {
    const hovered = paint("task", { enqueue: true }, view({ hovered: true })).quads;
    expect(keys(hovered)).not.toContain("shell.mid");
    expect(keys(hovered)).not.toContain("name.mid");
    expect(keys(hovered)).not.toContain("enqueue.mid");
    const icon = hovered.find((q) => q.key === "icon")!;
    expect(icon.tiers & (TIER_BIT.mid | TIER_BIT.far)).toBe(0);
    expect(hovered.find((q) => q.key === "hover.enqueue")?.band).toBe("lifted");
    expect(hovered.find((q) => q.key === "hover.enqueue")?.tiers).toBe(TIER_BIT.mid | TIER_BIT.far);
  });

  it("an unbound card draws the default shell and one plain line", () => {
    const quads = paint("terminal", { unbound: true, line: "unbound terminal" }).quads;
    expect(keys(quads)).toEqual(expect.arrayContaining(["shell", "unbound"]));
    expect(keys(quads)).not.toContain("icon");
    expect(quads.find((q) => q.key === "unbound")?.text?.text).toBe("unbound terminal");
    expect(quads.find((q) => q.key === "unbound")?.style.ink).toEqual({ token: "dim" });
    const page = paint("page", { unbound: true, line: "page unbound" }).quads.find((q) => q.key === "unbound")!;
    expect(page.style.ink).toEqual({ token: "faint" });
  });

  it("puts the text column where the DOM does", () => {
    const name = paint("git").quads.find((q) => q.key === "name")!;
    expect(name.rect.x).toBe(SEAT_TEXT.x);
    expect(name.rect.width).toBe(SEAT_TEXT.width);
  });

  it("an editing card hides its own name; keyboard focus rings the shell", () => {
    expect(keys(paint("git", {}, view({ editing: true })).quads)).not.toContain("name");
    expect(keys(paint("git", {}, view({ keyboardFocus: true })).quads)).toContain("focus");
  });

  it("dims by focus role and carries a reach mark in the lifted band", () => {
    expect(paint("git", {}, view({ focus: { kind: "impact", role: "outsider" } })).dim).toEqual({ opacity: 0.22, saturate: 0.35 });
    const reach = paint("git", {}, view({ reach: { id: "git-1", effect: "gains", summary: "gains 2" } })).quads;
    expect(reach.find((q) => q.key === "reach")?.band).toBe("lifted");
    expect(reach.find((q) => q.key === "reach.pill.text")?.text?.text).toBe("gains 2");
  });

  it("the shell's corners are the ones its sheet draws: a round left end, square right corners", () => {
    // `border-radius: 999px 12px 12px 999px` on a 216 by 56 card is what CSS
    // makes of it: the left end round at 28 (concentric with the ring), the
    // right corners leftovers of the same factor. Drawing the authored 12px
    // corners there put a 14px arc where the sheet has none.
    for (const selected of [false, true]) {
      const shell = paint("page", {}, view({ selected })).quads.find((q) => q.key === "shell")!;
      expect(shell.radii).toEqual([28, 12 * (56 / 1998), 12 * (56 / 1998), 28]);
    }
    const shadow = paint("task", {}, view({ selected: true })).quads.find((q) => q.key === "shell.shadow")!;
    expect(shadow.radii).toEqual([28, 12 * (56 / 1998), 12 * (56 / 1998), 28]);
  });
});
