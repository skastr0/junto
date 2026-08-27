import type { CanvasDoc } from "../../src/shared/canvas";
import type {
  IntentFactBasis,
  SinkRef,
} from "../../src/shared/work-protocol";
import {
  createAuthorialTaskDependencyScopeCapability,
  createCurrentProjectedTaskDependencyScopeCapability,
  createRetainedProjectedTaskDependencyScopeCapability,
  type TaskDependencyScopeCapability,
} from "../../src/main/vellum/work/repository";
import {
  canvasBodySha256Of,
  intentSha256Of,
} from "../../src/main/vellum/canvas-intent-identity";
import type { CanvasAuthorityMaterialSnapshot } from "../../src/main/vellum/canvases";

export const authorialMaterialForTest = (input: {
  readonly generation: string;
  readonly documents: ReadonlyMap<
    string,
    { readonly document: CanvasDoc; readonly rawBody: string }
  >;
}): CanvasAuthorityMaterialSnapshot => {
  const documents = new Map<string, CanvasDoc>();
  const storedDocuments = new Map<
    string,
    {
      readonly document: CanvasDoc;
      readonly rawBody: string;
      readonly revisionSha256: string;
    }
  >();
  for (const [name, entry] of input.documents) {
    const revisionSha256 = canvasBodySha256Of(entry.rawBody);
    documents.set(name, entry.document);
    storedDocuments.set(name, {
      document: entry.document,
      rawBody: entry.rawBody,
      revisionSha256,
    });
  }
  return {
    generation: input.generation,
    intentSha256: intentSha256Of(storedDocuments),
    documents,
    storedDocuments,
  };
};

export const authorialTaskTopologyCapabilityForTest = (input: {
  readonly basis: IntentFactBasis;
  readonly sink: SinkRef;
  readonly document: CanvasDoc;
  readonly rawBody: string;
}): TaskDependencyScopeCapability => {
  if (input.basis.kind !== "authorial-intent") {
    throw new TypeError("authorial test topology requires an authorial basis");
  }
  const authority = authorialMaterialForTest({
    generation: input.basis.generation,
    documents: new Map([
      [
        input.sink.canvasName,
        { document: input.document, rawBody: input.rawBody },
      ],
    ]),
  });
  if (authority.intentSha256 !== input.basis.contentSha256) {
    throw new TypeError(
      "authorial test topology bytes do not match the exact seeded basis",
    );
  }
  return createAuthorialTaskDependencyScopeCapability({
    authority,
    authoringSink: input.sink,
  });
};

export const currentProjectedTaskTopologyCapabilityForTest = (input: {
  readonly basis: IntentFactBasis;
  readonly sink: SinkRef;
  readonly rawBody: string;
}): TaskDependencyScopeCapability => {
  if (input.basis.kind !== "projected-intent") {
    throw new TypeError("projected test topology requires a projected basis");
  }
  return createCurrentProjectedTaskDependencyScopeCapability({
    rawBody: input.rawBody,
    generation: input.basis.generation,
    contentSha256: input.basis.contentSha256,
    authoringSink: input.sink,
  });
};

export const retainedProjectedTaskTopologyCapabilityForTest = (input: {
  readonly basis: IntentFactBasis;
  readonly sink: SinkRef;
  readonly rawBody: string;
}): TaskDependencyScopeCapability => {
  if (input.basis.kind !== "projected-intent") {
    throw new TypeError("retained test topology requires a projected basis");
  }
  return createRetainedProjectedTaskDependencyScopeCapability({
    rawBody: input.rawBody,
    generation: input.basis.generation,
    contentSha256: input.basis.contentSha256,
    authoringSink: input.sink,
  });
};
