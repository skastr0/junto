import { describe, expect, it } from "vitest";
import { serializeCanvas, type CanvasDoc } from "../src/shared/canvas";
import {
  canvasBodySha256Of,
  intentSha256Of,
  verifyCanvasIntentMaterial,
  type CanvasIntentMaterial,
  type StoredCanvasIntentDocument,
} from "../src/main/junto/canvas-intent-identity";

const noteDoc = (text: string): CanvasDoc => ({
  nodes: [
    {
      id: "note",
      type: "text",
      x: 0,
      y: 0,
      width: 120,
      height: 60,
      text,
    },
  ],
  edges: [],
});

const materialOf = (
  input: ReadonlyMap<string, CanvasDoc>,
): CanvasIntentMaterial => {
  const documents = new Map(input);
  const storedDocuments = new Map<string, StoredCanvasIntentDocument>();
  const revisions = new Map<string, { readonly revisionSha256: string }>();
  for (const [name, document] of documents) {
    const rawBody = serializeCanvas(document);
    const revisionSha256 = canvasBodySha256Of(rawBody);
    storedDocuments.set(name, { document, rawBody, revisionSha256 });
    revisions.set(name, { revisionSha256 });
  }
  return {
    intentSha256: intentSha256Of(revisions),
    documents,
    storedDocuments,
  };
};

const alteredHex = (value: string): string =>
  `${value[0] === "0" ? "1" : "0"}${value.slice(1)}`;

const replaceStored = (
  material: CanvasIntentMaterial,
  name: string,
  replacement: StoredCanvasIntentDocument,
): CanvasIntentMaterial => ({
  ...material,
  storedDocuments: new Map(material.storedDocuments).set(name, replacement),
});

describe("authorial canvas intent identity", () => {
  it("pins the historical localeCompare order and identity bytes", () => {
    const revisions = new Map([
      ["alpha-", { revisionSha256: "0".repeat(64) }],
      ["alpha_", { revisionSha256: "1".repeat(64) }],
      ["alpha", { revisionSha256: "2".repeat(64) }],
    ]);

    expect([...revisions.keys()].sort((a, b) => a.localeCompare(b))).toEqual([
      "alpha",
      "alpha_",
      "alpha-",
    ]);
    expect(intentSha256Of(revisions)).toBe(
      "c6f7c2d0959b933cd6c4b8cc816f7495d5919c9cd427b22a3d862876a822dc7b",
    );
  });

  it("verifies coherent raw and semantic authority material", () => {
    const material = materialOf(
      new Map([
        ["alpha", noteDoc("one")],
        ["beta", noteDoc("two")],
      ]),
    );

    expect(() => verifyCanvasIntentMaterial(material)).not.toThrow();
  });

  it("rejects one-component body, hash, name, document, and intent substitutions", () => {
    const material = materialOf(new Map([["alpha", noteDoc("one")]]));
    const stored = material.storedDocuments.get("alpha")!;

    const bodySubstitution = replaceStored(material, "alpha", {
      ...stored,
      rawBody: stored.rawBody.replace("one", "owe"),
    });
    expect(() => verifyCanvasIntentMaterial(bodySubstitution)).toThrow(
      /raw body hash mismatch/,
    );

    const hashSubstitution = replaceStored(material, "alpha", {
      ...stored,
      revisionSha256: alteredHex(stored.revisionSha256),
    });
    expect(() => verifyCanvasIntentMaterial(hashSubstitution)).toThrow(
      /raw body hash mismatch/,
    );

    const nameSubstitution: CanvasIntentMaterial = {
      ...material,
      storedDocuments: new Map([["alphb", stored]]),
    };
    expect(() => verifyCanvasIntentMaterial(nameSubstitution)).toThrow(
      /key mismatch/,
    );

    const documentSubstitution: CanvasIntentMaterial = {
      ...material,
      documents: new Map([["alpha", noteDoc("owe")]]),
    };
    expect(() => verifyCanvasIntentMaterial(documentSubstitution)).toThrow(
      /semantic document mismatch/,
    );

    const storedDocumentSubstitution = replaceStored(material, "alpha", {
      ...stored,
      document: noteDoc("owe"),
    });
    expect(() => verifyCanvasIntentMaterial(storedDocumentSubstitution)).toThrow(
      /semantic document mismatch/,
    );

    expect(() =>
      verifyCanvasIntentMaterial({
        ...material,
        intentSha256: alteredHex(material.intentSha256),
      }),
    ).toThrow(/portfolio hash mismatch/);
  });

  it("rejects a body with coordinated hash changes when its semantic document is stale", () => {
    const material = materialOf(new Map([["alpha", noteDoc("one")]]));
    const stored = material.storedDocuments.get("alpha")!;
    const rawBody = stored.rawBody.replace("one", "owe");
    const revisionSha256 = canvasBodySha256Of(rawBody);
    const revisions = new Map([["alpha", { revisionSha256 }]]);

    expect(() =>
      verifyCanvasIntentMaterial({
        ...material,
        intentSha256: intentSha256Of(revisions),
        storedDocuments: new Map([
          ["alpha", { ...stored, rawBody, revisionSha256 }],
        ]),
      }),
    ).toThrow(/semantic document mismatch/);
  });

});
