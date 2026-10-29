/**
 * The demo fixture's artifact inventory, decoded through the wire schemas the
 * Mac and the phone share (`src/shared/wire/`), so the fixture cannot drift
 * from what a Mac would accept: every head an `Artifact`, every body an
 * `ArtifactBody`, every version an `ArtifactVersionRecord`, labels canonical,
 * node colours the eight names, mentions resolving on the demo canvas, and
 * thread anchors the ruler admits.
 */
import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { AgentSignal } from "../src/shared/agent-signals";
import { ARTIFACT_TYPES, FIRST_ARTIFACT_VERSION, admitsAnchor, decodeArtifact, decodeArtifactBody } from "../src/shared/wire/artifact";
import { ArtifactVersionRecord } from "../src/shared/wire/artifact";
import { ARTIFACT_LABEL_COLOURS, ArtifactLabelColour, ArtifactLabels, decodeArtifactLabel } from "../src/shared/wire/artifact-labels";
import { ItemId, NodeId } from "../src/shared/wire/ids";
import { mentionLinksOf, mentionRefOf } from "../src/shared/wire/mention";
import { ActorSeatId } from "../src/shared/wire/resource-actor";
import {
  DEMO_ARTIFACTS,
  DEMO_ARTIFACT_LABEL_COLOURS,
  DEMO_ARTIFACT_ROADMAP_DRAFT,
  DEMO_ARTIFACT_THREADS,
  DEMO_CANVAS,
  DEMO_RESOURCE_NODES,
  DEMO_SEATS,
  DEMO_SIGNALS,
  DEMO_TASK_PRICING,
} from "../src/shared/wire/companion-demo-fixture";

const decode = <A>(schema: Schema.Schema<A, any, any>, value: unknown, what: string): A => {
  const result = Schema.decodeUnknownResult(schema)(value);
  if (!Result.isSuccess(result)) throw new Error(`${what}: ${JSON.stringify(result.failure.issue)}`);
  return result.success;
};

const nodeKindOf = (nodeId: string): string | undefined =>
  DEMO_RESOURCE_NODES.find((node) => node.id === nodeId)?.kind ??
  (DEMO_SEATS.some((seat) => seat.id === nodeId) ? "agent" : undefined);

describe("the demo artifact fixture, on the wire schemas", () => {
  it("holds the section-8 inventory: three Artifacts nodes with an Inbox, a task board and a page, one artifact of every type, an archived one, labels and node colours", () => {
    const artifactsNodes = DEMO_RESOURCE_NODES.filter((node) => node.kind === "artifacts");
    expect(artifactsNodes.length).toBe(3);
    expect(artifactsNodes.some((node) => node.label === "Inbox")).toBe(true);
    expect(DEMO_RESOURCE_NODES.some((node) => node.kind === "task")).toBe(true);
    expect(DEMO_RESOURCE_NODES.some((node) => node.kind === "page")).toBe(true);

    expect(new Set(DEMO_ARTIFACTS.map((artifact) => artifact.head.type))).toEqual(new Set(ARTIFACT_TYPES));
    expect(DEMO_ARTIFACTS.some((artifact) => artifact.head.archived)).toBe(true);
    expect(DEMO_ARTIFACTS.some((artifact) => artifact.head.labels.length > 0)).toBe(true);
    expect(DEMO_ARTIFACTS.some((artifact) => artifact.head.taskIds.length > 0)).toBe(true);
    expect(Object.keys(DEMO_ARTIFACT_LABEL_COLOURS).every((nodeId) => artifactsNodes.some((node) => node.id === nodeId))).toBe(true);
  });

  it("decodes every artifact head as an Artifact, on the node's own nodeId", () => {
    for (const artifact of DEMO_ARTIFACTS) {
      const decoded = decodeArtifact(artifact.head);
      expect(Result.isSuccess(decoded)).toBe(true);
      if (!Result.isSuccess(decoded)) continue;
      expect(decoded.success.artifactId).toBe(artifact.head.artifactId);
      expect(decoded.success.type).toBe(artifact.body.type);
      expect(DEMO_RESOURCE_NODES.some((node) => node.kind === "artifacts" && node.id === decoded.success.nodeId)).toBe(true);
      decode(ArtifactLabels, artifact.head.labels, "labels");
    }
  });

  it("decodes every body as an ArtifactBody, and every version as a contiguous ruled chain ending at the head", () => {
    for (const artifact of DEMO_ARTIFACTS) {
      expect(Result.isSuccess(decodeArtifactBody(artifact.body))).toBe(true);
      expect(artifact.versions.length).toBeGreaterThan(0);
      artifact.versions.forEach((version, at) => {
        decode(ArtifactVersionRecord, version, `version ${at + 1} of ${artifact.head.artifactId}`);
        expect(version.version).toBe(FIRST_ARTIFACT_VERSION + at);
        expect(version.artifactId).toBe(artifact.head.artifactId);
      });
      const last = artifact.versions[artifact.versions.length - 1]!;
      expect(last.version).toBe(artifact.head.version);
      expect(last.body).toEqual(artifact.body);
    }
  });

  it("decodes every label canonically and every node colour as one of the eight names", () => {
    for (const artifact of DEMO_ARTIFACTS) {
      for (const label of artifact.head.labels) {
        expect(Result.isSuccess(decodeArtifactLabel(label))).toBe(true);
      }
    }
    for (const [nodeId, colours] of Object.entries(DEMO_ARTIFACT_LABEL_COLOURS)) {
      for (const [label, colour] of Object.entries(colours)) {
        expect(Result.isSuccess(decodeArtifactLabel(label))).toBe(true);
        expect(Result.isSuccess(Schema.decodeUnknownResult(ArtifactLabelColour)(colour))).toBe(true);
      }
    }
    for (const colour of ARTIFACT_LABEL_COLOURS) {
      expect(Object.values(DEMO_ARTIFACT_LABEL_COLOURS).some((map) => Object.values(map).includes(colour))).toBeDefined();
    }
  });

  it("resolves every mention in a document on the demo canvas, covering each kind", () => {
    const kinds = new Set<string>();
    for (const artifact of DEMO_ARTIFACTS) {
      if (artifact.body.type !== "document") continue;
      const links = mentionLinksOf(artifact.body.markdown);
      for (const link of links) {
        const ref = mentionRefOf(link.target, nodeKindOf);
        expect(ref, `mention ${link.target.nodeId}${link.target.item ? `#${link.target.item}` : ""} in ${artifact.head.artifactId}`).toBeDefined();
        if (ref === undefined) continue;
        kinds.add(ref.kind);
        if (ref.kind === "artifact") expect(DEMO_ARTIFACTS.some((held) => held.head.artifactId === ref.artifactId && held.head.nodeId === ref.nodeId)).toBe(true);
        if (ref.kind === "task") expect(ref.taskId).toBe(DEMO_TASK_PRICING);
        if (ref.kind === "seat") expect(DEMO_SEATS.some((seat) => seat.id === ref.nodeId)).toBe(true);
        if (ref.kind === "page") expect(DEMO_RESOURCE_NODES.some((node) => node.kind === "page" && node.id === ref.nodeId)).toBe(true);
      }
    }
    expect(kinds).toEqual(new Set(["seat", "task", "artifact", "page"]));
  });

  it("anchors every artifact thread where the ruler admits one, on a real artifact", () => {
    expect(DEMO_ARTIFACT_THREADS.length).toBeGreaterThan(0);
    for (const thread of DEMO_ARTIFACT_THREADS) {
      decode(ItemId, thread.threadId, "threadId");
      const artifact = DEMO_ARTIFACTS.find((held) => held.head.artifactId === thread.artifactId);
      expect(artifact, `thread ${thread.threadId} names artifact ${thread.artifactId}`).toBeDefined();
      expect(admitsAnchor(artifact!.body as any, thread.anchor as any)).toBe(true);
      for (const post of thread.posts) {
        decode(ItemId, post.postId, "postId");
        if (post.from.kind === "seat") {
          decode(ActorSeatId, post.from.seatId, "post seatId");
          decode(NodeId, post.from.nodeId, "post nodeId");
        }
      }
    }
    expect(DEMO_ARTIFACT_THREADS.some((thread) => thread.anchor.kind === "text")).toBe(true);
  });

  it("carries the artifact-form signal, decoded as an AgentSignal on an Artifacts node", () => {
    const signals = DEMO_SIGNALS.map((signal) => decode(AgentSignal, signal, `signal ${signal.signalId}`));
    const formed = signals.filter((signal) => signal.form?.kind === "artifact");
    expect(formed.length).toBeGreaterThan(0);
    for (const signal of formed) {
      const form = signal.form as Extract<NonNullable<AgentSignal["form"]>, { kind: "artifact" }>;
      expect(form.nodeId).toBeDefined();
      expect(DEMO_RESOURCE_NODES.some((node) => node.kind === "artifacts" && node.id === form.nodeId)).toBe(true);
      decode(ArtifactLabels, form.labels, "signal form labels");
    }
    expect(DEMO_CANVAS).toBe("demo");
    expect(DEMO_ARTIFACT_ROADMAP_DRAFT).toBeDefined();
  });
});
