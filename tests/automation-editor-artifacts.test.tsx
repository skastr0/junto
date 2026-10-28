// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ARTIFACT_LABEL_RULE, type ArtifactLabel } from "../src/shared/artifact-labels";
import { asCanvasName } from "../src/shared/model";
import { asNodeId } from "../src/shared/physics/schema";
import { AutomationEditor } from "../src/renderer/components/automations/AutomationEditor";
import {
  APPEND_HEADING,
  actionWords,
  draftProblems,
  editDraft,
  labelNote,
  newDraft,
  triggerWords,
  type ActionDraft,
  type AutomationDraft,
  type NameOf,
  type TriggerDraft,
} from "../src/renderer/lib/automation-editor";
import { modelStore } from "../src/renderer/lib/use-model";
import { artifacts, automations } from "./support/model-nodes";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CANVAS = "automation-artifacts";
const home = asNodeId("automations-1");
const shelf = asNodeId("shelf-1");
const seat = { kind: "seat", nodeId: asNodeId("agent-a") } as const;
const nameOf: NameOf = (ref) => (!("kind" in ref) ? ref.node : ref.kind === "seat" ? `@${ref.nodeId}` : `#${ref.nodeId}`);

const onArtifact = (event: "edited" | "commented" | "labelled", label?: string): TriggerDraft => ({
  kind: "change",
  on: { kind: "artifact", artifact: { node: shelf }, event, ...(label === undefined ? {} : { label }) },
});

const draftWith = (trigger: TriggerDraft, then: ReadonlyArray<ActionDraft>): AutomationDraft => ({
  ...newDraft("01M62A1X7ABVZ8RQ15RJWCR84A" as AutomationDraft["automationId"], home, { kind: "operator" }, "UTC"),
  name: "Publish",
  trigger,
  then,
  thenKeys: then.map((_, index) => `k${index}`),
});

const actionProblem = (draft: AutomationDraft): string | undefined => draftProblems(draft).find((problem) => problem.at === "action")?.message;
const triggerProblem = (draft: AutomationDraft): string | undefined => draftProblems(draft).find((problem) => problem.at === "trigger")?.message;

describe("artifact automations, the draft", () => {
  it("an artifact trigger says its label in the sentence the list shows", () => {
    expect(triggerWords(onArtifact("edited", "Publish"), nameOf)).toBe("when any artifact in shelf-1 labelled publish is edited");
    expect(triggerWords(onArtifact("labelled", "publish"), nameOf)).toBe("when any artifact in shelf-1 is labelled publish");
    expect(triggerWords(onArtifact("labelled"), nameOf)).toBe("when any artifact in shelf-1 is labelled anything");
    expect(triggerWords(onArtifact("commented"), nameOf)).toBe("when any artifact in shelf-1 is commented on");
  });

  it("a label that is not one is refused at the trigger, in the header's rule", () => {
    expect(triggerProblem(draftWith(onArtifact("edited", "no//levels"), [{ kind: "mail", to: seat, text: "x" }]))).toBe(
      ARTIFACT_LABEL_RULE,
    );
    // A trailing / breaks the rule the sentence states.
    expect(triggerProblem(draftWith(onArtifact("labelled", "publish/"), [{ kind: "mail", to: seat, text: "x" }]))).toBe(ARTIFACT_LABEL_RULE);
    // Case folds as the header folds it: Publish is publish.
    expect(triggerProblem(draftWith(onArtifact("edited", "Publish"), [{ kind: "mail", to: seat, text: "x" }]))).toBeUndefined();
  });

  it("the artifact that fired is only there under an artifact trigger", () => {
    const append: ActionDraft = { kind: "append-artifact", to: { fired: true }, text: "done" };
    expect(actionProblem(draftWith(onArtifact("edited"), [append]))).toBeUndefined();
    const schedule: TriggerDraft = { kind: "schedule", cron: "0 9 * * 1-5", timezone: "UTC" };
    expect(actionProblem(draftWith(schedule, [append]))).toBe("Only an artifact trigger has an artifact that fired. Pick one artifact.");
    expect(actionProblem(draftWith(schedule, [{ kind: "label-artifact", to: { fired: true }, add: ["done"] }]))).toBe(
      "Only an artifact trigger has an artifact that fired. Pick one artifact.",
    );
  });

  it("label-artifact needs a label, and never the same one added and removed", () => {
    const trigger = onArtifact("labelled", "publish");
    expect(actionProblem(draftWith(trigger, [{ kind: "label-artifact", to: { fired: true } }]))).toBe("Name a label to add or remove.");
    expect(actionProblem(draftWith(trigger, [{ kind: "label-artifact", to: { fired: true }, add: ["Shipped"], remove: ["shipped"] }]))).toBe(
      "shipped is both added and removed. Keep it in one.",
    );
    expect(actionProblem(draftWith(trigger, [{ kind: "label-artifact", to: { fired: true }, add: ["shipped"], remove: ["publish"] }]))).toBeUndefined();
  });

  it("create-artifact needs its node and title; body and labels are optional, values checked in both", () => {
    const trigger = onArtifact("edited");
    expect(actionProblem(draftWith(trigger, [{ kind: "create-artifact", title: "Digest" }]))).toBe("Pick the Artifacts node.");
    expect(actionProblem(draftWith(trigger, [{ kind: "create-artifact", node: shelf, title: " " }]))).toBe("Write the artifact title.");
    expect(actionProblem(draftWith(trigger, [{ kind: "create-artifact", node: shelf, title: "Digest {{artifact.title}}" }]))).toBeUndefined();
    expect(
      actionProblem(draftWith(trigger, [{ kind: "create-artifact", node: shelf, title: "Digest", body: "{{task.title}}" }])),
    ).toContain("This trigger carries no {{task.title}}.");
    expect(actionProblem(draftWith(trigger, [{ kind: "create-artifact", node: shelf, title: "Digest", labels: ["a//b"] }]))).toBe(
      ARTIFACT_LABEL_RULE,
    );
  });

  it("a new append starts as a dated section, and a changed kind carries its text", () => {
    const draft = draftWith(onArtifact("edited"), [{ kind: "mail", to: seat, text: "Shipped {{artifact.title}}" }]);
    expect(editDraft(draft, { type: "add-action", kind: "append-artifact" }).then[1]).toEqual({ kind: "append-artifact", text: APPEND_HEADING });
    expect(editDraft(draft, { type: "action-kind", index: 0, kind: "append-artifact" }).then[0]).toEqual({
      kind: "append-artifact",
      text: "Shipped {{artifact.title}}",
    });
    expect(editDraft(draft, { type: "action-kind", index: 0, kind: "create-artifact" }).then[0]).toEqual({
      kind: "create-artifact",
      title: "",
      body: "Shipped {{artifact.title}}",
    });
  });

  it("a label no artifact carries is said under the field, with the labels that are there", () => {
    const used = ["project/junto", "publish", "weekly"] as unknown as ReadonlyArray<ArtifactLabel>;
    expect(labelNote("publsh", "edited", "Specs", used)).toBe("No artifact in Specs carries publsh yet. Labels there: project/junto, publish, weekly.");
    expect(labelNote("draft", "labelled", "Specs", [])).toBe("No artifact in Specs carries draft yet. It fires when one gains it.");
    // A match, a level above one, an empty field or a broken label says nothing here.
    expect(labelNote("Publish", "edited", "Specs", used)).toBeUndefined();
    expect(labelNote("project", "edited", "Specs", used)).toBeUndefined();
    expect(labelNote("", "edited", "Specs", used)).toBeUndefined();
    expect(labelNote("a//b", "edited", "Specs", used)).toBeUndefined();
  });

  it("each artifact action says what it writes", () => {
    expect(actionWords({ kind: "create-artifact", node: shelf, title: "x" }, nameOf)).toBe("create an artifact in shelf-1");
    expect(actionWords({ kind: "append-artifact", to: { fired: true }, text: "x" }, nameOf)).toBe("append to the artifact that fired");
    expect(actionWords({ kind: "label-artifact", to: { kind: "artifact", nodeId: shelf, artifactId: "01M62A1X7ABVZ8RQ15RJWCR84B" as never } }, nameOf)).toBe(
      "label #shelf-1",
    );
  });
});

let host: HTMLDivElement;
let root: Root;
let release: () => void;

const render = async (draft: AutomationDraft): Promise<void> => {
  await act(async () =>
    root.render(
      <AutomationEditor draft={draft} onDraft={() => undefined} canvasName={CANVAS} saving={false} dirty={false} onSave={() => undefined} onRevert={() => undefined} />,
    ),
  );
};

const words = (): ReadonlyArray<string | null> =>
  [...host.querySelectorAll(".automation-editor__sentence .automation-editor__word")].map((word) => word.textContent);

describe("artifact automations, the form", () => {
  beforeEach(() => {
    release = modelStore.adopt({
      canvas: asCanvasName(CANVAS),
      seq: 0,
      wires: [],
      nodes: [automations("automations-1", { z: 0 }), artifacts("shelf-1", { x: 800, z: 1, label: "Specs" })],
    });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    release();
  });

  it("reads When an artifact labelled publish in Specs is edited, and is labelled puts the label last", async () => {
    await render(draftWith(onArtifact("edited", "publish"), [{ kind: "mail", to: seat, text: "x" }]));
    expect(words()).toEqual(["When", "labelled", "is"]);
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Only with this label, optional"]')?.value).toBe("publish");

    await render(draftWith(onArtifact("labelled", "publish"), [{ kind: "mail", to: seat, text: "x" }]));
    expect(words()).toEqual(["When", "is"]);
    expect(host.querySelector('input[aria-label="Only with this label, optional"]')).toBeNull();
    expect(host.querySelector<HTMLInputElement>('input[aria-label="The label it gains, or any"]')?.value).toBe("publish");
  });

  it("offers the artifact that fired only under an artifact trigger", async () => {
    await render(draftWith(onArtifact("edited"), [{ kind: "append-artifact", to: { fired: true }, text: APPEND_HEADING }]));
    expect(host.querySelector('[aria-label="Append to"]')?.textContent).toContain("the artifact that fired");
    expect(host.querySelector('textarea[aria-label="Artifact to append to"]')).toBeNull();
    expect(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Text to append"]')?.value).toBe(APPEND_HEADING);

    await render(draftWith({ kind: "schedule", cron: "0 9 * * 1-5", timezone: "UTC" }, [{ kind: "label-artifact", add: ["done"] }]));
    expect(host.querySelector('[aria-label="Which artifact"]')?.textContent).toContain("one artifact");
    expect(host.querySelector('textarea[aria-label="Artifact to label"]')).not.toBeNull();
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Labels to add"]')?.value).toBe("done");
  });

  it("a typed label nothing in the node carries is noted under the sentence and describes the field", async () => {
    await render(draftWith(onArtifact("edited", "publsh"), [{ kind: "mail", to: seat, text: "x" }]));
    const field = host.querySelector<HTMLInputElement>('input[aria-label="Only with this label, optional"]')!;
    const note = document.getElementById(field.getAttribute("aria-describedby")!);
    expect(note?.textContent).toBe("No artifact in Specs carries publsh yet.");
    // A live region, so the miss is heard as it appears, not only when the field is next focused.
    expect(note?.getAttribute("role")).toBe("status");

    await render(draftWith(onArtifact("edited", ""), [{ kind: "mail", to: seat, text: "x" }]));
    // Mounted and empty while nothing is to say, so its first words are announced.
    expect(host.querySelector('[role="status"].automation-editor__label-note')?.textContent).toBe("");
    expect(host.querySelector('input[aria-label="Only with this label, optional"]')?.getAttribute("aria-describedby")).toBeNull();
  });

  it("create-artifact lists the Artifacts nodes in reach by name", async () => {
    await render(draftWith(onArtifact("edited"), [{ kind: "create-artifact", node: shelf, title: "Digest", labels: ["weekly", "digest"] }]));
    expect(host.querySelector('[aria-label="Artifacts node"]')?.textContent).toContain("Specs");
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Artifact title"]')?.value).toBe("Digest");
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Labels, optional"]')?.value).toBe("weekly, digest");
  });
});
