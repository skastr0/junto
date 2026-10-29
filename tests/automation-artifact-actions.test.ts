import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import { appended, type ArtifactAction, type ArtifactPort, performArtifactAction } from "../src/main/junto/automation/artifact-actions";
import type { ChangeEvent } from "../src/main/junto/automation/plan";
import { firedValue } from "../src/main/junto/automation/values";
import type { ArtifactOp } from "../src/shared/artifact";
import {
  actionRefusal,
  actionText,
  Action,
  type Automation,
  AutomationId,
  AutomationVersion,
  automationValuesOf,
  firedTargetRefusal,
  targetNodeIds,
} from "../src/shared/automation";
import { Schema } from "effect";
import type { InstallationId } from "../src/shared/installation-id";
import type { Canvas } from "../src/shared/model";
import { asNodeId } from "../src/shared/physics/schema";
import { ItemId } from "../src/shared/work-ids";

const NODE = asNodeId("automations-1");
const SHELF = asNodeId("specs");
const DOC = ItemId.make("01M5ESKJFC1A88R1MH1NEZWJ51");
const automation: Automation = {
  automationId: AutomationId.make("01M5ESKJFC1A88R1MH1NEZWJ2Q"),
  nodeId: NODE,
  author: { kind: "operator" },
  version: AutomationVersion.make(1),
  name: "Publish",
  enabled: true,
  trigger: { kind: "change", on: { kind: "artifact", artifact: { node: SHELF }, event: "labelled", label: "publish" as never } },
  then: [],
  limits: { minIntervalMs: 0, maxPerHour: 60 },
};
const canvas = {
  nodes: new Map([
    [SHELF, { kind: "artifacts", id: SHELF, x: 0, y: 0, width: 10, height: 10, z: 0 }],
    [NODE, { kind: "automations", id: NODE, x: 0, y: 0, width: 10, height: 10, z: 0 }],
  ]),
  wires: new Map(),
} as unknown as Canvas;
const firedBy: ChangeEvent = {
  kind: "artifact",
  key: "k",
  nodeId: SHELF,
  artifactId: DOC,
  event: "labelled",
  labels: ["publish"] as never,
  gained: ["publish"] as never,
  byAutomation: false,
};

/** An artifact store holding one document; `beatenBy` newer heads land before each of the first writes. */
const store = (markdown = "# Spec", labels: ReadonlyArray<string> = ["publish"], beatenBy = 0) => {
  let version = 3;
  let held = labels;
  let beat = beatenBy;
  const sent: Array<{ readonly op: ArtifactOp; readonly opId: string; readonly itemId: string | undefined }> = [];
  const port: ArtifactPort = {
    writer: Effect.succeed("macbook-installation" as InstallationId),
    repository: {
      head: (_canvas: string, artifactId: string) =>
        Effect.succeed(
          artifactId === DOC
            ? Option.some({ artifact: { artifactId: DOC, nodeId: SHELF, title: "Spec", version, labels: held }, body: { type: "document", markdown } })
            : Option.none(),
        ),
      submit: (_writer: string, command: { readonly op: ArtifactOp; readonly opId: string; readonly target: { readonly itemId?: string } }) =>
        Effect.sync(() => {
          sent.push({ op: command.op, opId: command.opId, itemId: command.target.itemId });
          if (command.op.op === "edit" && beat > 0) {
            beat -= 1;
            version += 1;
            return { kind: "refused", opId: command.opId, root: command.opId, error: { type: "Conflict", message: "stale", details: { reason: "stale" } } };
          }
          if (command.op.op === "labels") held = command.op.labels;
          return { kind: "applied", opId: command.opId, artifactId: DOC, version, facts: [{}] };
        }),
    } as unknown as ArtifactPort["repository"],
  };
  return { port, sent };
};

/** One ULID per part, as the runner mints them from the firing. */
const ids = new Map<string, string>();
const idOf = (part: string): string => {
  if (!ids.has(part)) ids.set(part, `01M5ESKJFC1A88R1MH1NEZ${String(ids.size).padStart(4, "0")}`);
  return ids.get(part)!;
};

const perform = (port: ArtifactPort | undefined, action: ArtifactAction, rules = true) =>
  Effect.runPromise(
    performArtifactAction(port, {
      canvas,
      canvasName: "factory",
      automation,
      action,
      index: 0,
      fired: { event: firedBy, at: Date.UTC(2026, 9, 28) },
      resolve: (text) => Effect.succeed(text.replaceAll("{{fired.at}}", "2026-10-28")),
      idOf: (part) => idOf(part),
      rules,
    }),
  );

describe("an automation's artifact writes", () => {
  it("creates a document in an Artifacts node, its values said, and refuses any other node", async () => {
    const { port, sent } = store();
    const create = { kind: "create-artifact", node: SHELF, title: "Digest {{fired.at}}", body: "Done.", labels: ["weekly"] } as unknown as ArtifactAction;
    expect(await perform(port, create)).toEqual({ index: 0, ruling: "applied" });
    expect(sent[0]?.op).toEqual({ op: "create", title: "Digest 2026-10-28", body: { type: "document", markdown: "Done." }, labels: ["weekly"] });
    const elsewhere = { kind: "create-artifact", node: NODE, title: "x" } as unknown as ArtifactAction;
    expect(await perform(port, elsewhere)).toEqual({ index: 0, ruling: "refused", reason: "invalid_input" });
  });

  it("appends to the artifact that fired against the head it read, reading again when beaten, at most twice", async () => {
    const beatenOnce = store("# Spec", ["publish"], 1);
    const append = { kind: "append-artifact", to: { fired: true }, text: "## {{fired.at}}\nDeployed." } as unknown as ArtifactAction;
    expect(await perform(beatenOnce.port, append)).toEqual({ index: 0, ruling: "applied" });
    expect(beatenOnce.sent.map(({ op }) => op.op === "edit" && op.edit.kind === "replace" && op.edit.baseVersion)).toEqual([3, 4]);
    expect(beatenOnce.sent[1]?.op).toMatchObject({ edit: { body: { markdown: "# Spec\n## 2026-10-28\nDeployed." } } });
    expect(new Set(beatenOnce.sent.map(({ opId }) => opId)).size).toBe(2);
    const alwaysBeaten = store("# Spec", ["publish"], 5);
    expect(await perform(alwaysBeaten.port, append)).toEqual({ index: 0, ruling: "refused", reason: "stale" });
    expect(alwaysBeaten.sent).toHaveLength(3);
  });

  it("adds and removes labels on the whole set, and writes nothing when the set is already so", async () => {
    const { port, sent } = store("# Spec", ["draft", "publish"]);
    const relabel = { kind: "label-artifact", to: { fired: true }, add: ["published"], remove: ["draft", "publish"] } as unknown as ArtifactAction;
    expect(await perform(port, relabel)).toEqual({ index: 0, ruling: "applied" });
    expect(sent[0]?.op).toEqual({ op: "labels", labels: ["published"] });
    expect(await perform(port, relabel)).toEqual({ index: 0, ruling: "applied" });
    expect(sent).toHaveLength(1);
  });

  it("is not available off the machine that rules the canvas, or with no artifact store", async () => {
    const append = { kind: "append-artifact", to: { fired: true }, text: "x" } as unknown as ArtifactAction;
    expect(await perform(store().port, append, false)).toEqual({ index: 0, ruling: "refused", reason: "not_available" });
    expect(await perform(undefined, append)).toEqual({ index: 0, ruling: "refused", reason: "not_available" });
  });

  it("puts appended text on a line of its own", () => {
    expect(appended("", "a")).toBe("a");
    expect(appended("x\n", "a")).toBe("x\na");
    expect(appended("x", "a")).toBe("x\na");
  });
});

describe("artifact actions at save", () => {
  const to = { kind: "artifact", nodeId: SHELF, artifactId: DOC } as const;
  it("refuses a label change that names nothing or one label both ways, and a write to anything but an artifact", () => {
    expect(actionRefusal({ kind: "label-artifact", to } as never)).toMatchObject({ reason: "invalid_input" });
    expect(actionRefusal({ kind: "label-artifact", to, add: ["a"], remove: ["a"] } as never)).toMatchObject({ message: "label a is both added and removed" });
    expect(actionRefusal({ kind: "append-artifact", to: { kind: "seat", nodeId: NODE }, text: "x" } as never)).toMatchObject({ reason: "invalid_input" });
    expect(actionRefusal({ kind: "append-artifact", to: { fired: true }, text: "x" } as never)).toBeUndefined();
  });

  it("takes the artifact that fired only under an artifact trigger", () => {
    const append = { kind: "append-artifact", to: { fired: true }, text: "x" } as never;
    expect(firedTargetRefusal({ trigger: automation.trigger, then: [append] })).toBeUndefined();
    expect(firedTargetRefusal({ trigger: { kind: "poll", everyMs: 60_000 }, then: [append] })).toMatchObject({ reason: "invalid_input" });
  });

  it("says artifact.labels under an artifact trigger, joined with a comma", () => {
    expect(automationValuesOf(automation.trigger)).toContain("artifact.labels");
    const reads = { artifact: { artifact: { title: "Spec", labels: ["draft", "publish"] } } } as never;
    expect(firedValue("artifact.labels", { event: firedBy, at: 0 }, reads, canvas, "factory")).toBe("draft, publish");
  });
});

describe("a signal action (0.11/07 N2, 0.11/09 H1)", () => {
  const read = { kind: "artifact", nodeId: SHELF, artifactId: DOC } as const;
  const signal = { kind: "signal", signal: "escalate", title: "Write 500 words", detail: "Today, {{fired.at}}", show: [read] } as const;

  it("decodes a seat's kinds or a notice, with a title the feed's length, and shows at most eight artifacts", () => {
    for (const kind of ["notice", "escalate", "blocked", "feedback"]) expect(Schema.is(Action)({ ...signal, signal: kind })).toBe(true);
    expect(Schema.is(Action)({ ...signal, signal: "work" })).toBe(false);
    expect(Schema.is(Action)({ ...signal, title: "x".repeat(281) })).toBe(false);
    expect(Schema.is(Action)({ ...signal, show: Array.from({ length: 9 }, () => read) })).toBe(false);
  });

  it("shows artifacts only, reaches their nodes, and says its title and detail as values", () => {
    expect(actionRefusal(signal as never)).toBeUndefined();
    expect(actionRefusal({ ...signal, show: [{ kind: "seat", nodeId: NODE }] } as never)).toMatchObject({ message: "a signal shows artifacts" });
    expect(targetNodeIds({ ...automation, then: [signal as never] })).toContain(SHELF);
    expect(actionText(signal as never)).toBe("Write 500 words\nToday, {{fired.at}}");
  });

  it("asks for one of N1's forms, its artifact node in reach, only as escalate or blocked", () => {
    const write = { ...signal, form: { kind: "artifact", node: SHELF, title: "Words {{fired.at}}", labels: ["writing"], minWords: 500 } };
    expect(Schema.is(Action)(write)).toBe(true);
    expect(Schema.is(Action)({ ...signal, form: { kind: "secret", name: "CLOUDFLARE_API_TOKEN" } })).toBe(true);
    expect(Schema.is(Action)({ ...signal, form: { kind: "secret", name: "not a name" } })).toBe(false);
    expect(Schema.is(Action)({ ...signal, form: { kind: "artifact", node: SHELF, minWords: 0 } })).toBe(false);
    expect(Schema.is(Action)({ ...signal, form: { kind: "proof" } })).toBe(true);
    expect(targetNodeIds({ ...automation, then: [{ ...write, show: undefined } as never] })).toEqual([SHELF]);
    expect(actionText(write as never)).toBe("Write 500 words\nToday, {{fired.at}}\nWords {{fired.at}}");
    expect(actionRefusal(write as never)).toBeUndefined();
    expect(actionRefusal({ ...write, signal: "blocked" } as never)).toBeUndefined();
    for (const kind of ["notice", "feedback"]) {
      expect(actionRefusal({ ...write, signal: kind } as never)).toMatchObject({ message: "only an escalate or blocked signal asks for an answer in a form" });
    }
    // The form's title becomes the document's, so an artifact title's length.
    expect(Schema.is(Action)({ ...signal, form: { kind: "artifact", node: SHELF, title: "x".repeat(200) } })).toBe(true);
    expect(Schema.is(Action)({ ...signal, form: { kind: "artifact", node: SHELF, title: "x".repeat(201) } })).toBe(false);
  });
});
