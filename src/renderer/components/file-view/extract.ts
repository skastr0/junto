/**
 * Extract as artifact (plan 0.11, F8): a box drawn on a PDF page or an image
 * becomes a `file` artifact in an Artifacts node in reach of the Files node.
 * The PNG goes into the content store; the artifact's body names its source
 * as the Files node, the path relative to its root, the page and the box,
 * never an absolute path, because the artifact crosses to every machine.
 */
import type { FileSource } from "@shared/artifact";
import type { Canvas } from "@shared/model";
import { titleOf } from "@shared/model/title";
import type { NodeId } from "@shared/physics/schema";
import { reaches } from "@shared/region-reach";
import { mintItemId } from "@shared/resource-command";
import { applyArtifactOp } from "../../lib/artifacts-source";
import { pngDataUrl } from "../../lib/png-data-url";
import { cropOf, extractTitle, fileNameOf, type ViewBox } from "./file-view-model";

/** A rendered box: the PNG bytes and their size in pixels. */
export type BoxShot = { readonly png: Uint8Array; readonly width: number; readonly height: number };

/** An Artifacts node an extract may land in. */
export type ExtractTarget = { readonly id: NodeId; readonly title: string };

/** The Artifacts nodes in reach of a Files node, by the same region reach every resource uses. */
export const extractTargets = (canvas: Pick<Canvas, "nodes">, filesNode: NodeId): ReadonlyArray<ExtractTarget> =>
  [...canvas.nodes.values()]
    .filter((node) => node.kind === "artifacts" && reaches(canvas, filesNode, node.id))
    .map((node) => ({ id: node.id, title: titleOf(node) }))
    .sort((a, b) => a.title.localeCompare(b.title) || (a.id < b.id ? -1 : 1));

export const canvasPng = async (canvas: HTMLCanvasElement): Promise<BoxShot> => {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (blob === null) throw new Error("The box could not be drawn as PNG.");
  return { png: new Uint8Array(await blob.arrayBuffer()), width: canvas.width, height: canvas.height };
};

/**
 * The box on an image as PNG, cut from the file's own pixels. An image has
 * no finer copy than its pixels, so it is never scaled up; a PDF renders at
 * twice its size instead (`pdf-engine.ts`).
 */
export const imageBoxShot = async (url: string, box: ViewBox): Promise<BoxShot> => {
  const { image, release } = await decodedImage(url);
  try {
    const crop = cropOf(box, image.naturalWidth, image.naturalHeight, 1);
    const canvas = document.createElement("canvas");
    canvas.width = crop.w;
    canvas.height = crop.h;
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("The box could not be drawn.");
    const ratio = 1 / crop.scale;
    context.drawImage(image, crop.x * ratio, crop.y * ratio, crop.w * ratio, crop.h * ratio, 0, 0, crop.w, crop.h);
    return await canvasPng(canvas);
  } finally {
    release();
  }
};

/**
 * The image decoded from its bytes. A `junto-file:` address is read through
 * fetch, so the canvas it is drawn on is never tainted by another origin; a
 * `blob:` address (the gallery's) is this page's own and decodes as is.
 */
const decodedImage = async (url: string): Promise<{ readonly image: HTMLImageElement; readonly release: () => void }> => {
  const own = url.startsWith("blob:");
  const source = own ? url : URL.createObjectURL(await fetchBlob(url));
  const release = (): void => {
    if (!own) URL.revokeObjectURL(source);
  };
  try {
    const image = new Image();
    image.src = source;
    await image.decode();
    return { image, release };
  } catch (error) {
    release();
    throw error;
  }
};

const fetchBlob = async (url: string): Promise<Blob> => {
  const response = await fetch(url);
  if (!response.ok) throw new Error("The image could not be read.");
  return response.blob();
};

export type ExtractOutcome =
  | { readonly kind: "created"; readonly artifactId: string; readonly target: ExtractTarget }
  | { readonly kind: "queued"; readonly target: ExtractTarget }
  | { readonly kind: "failed"; readonly line: string };

const base64Of = (png: Uint8Array): string => pngDataUrl(png).slice("data:image/png;base64,".length);

/** Put the shot in the content store, then create the artifact on `target`. */
export const extractToArtifact = async ({
  canvasName,
  target,
  source,
  shot,
}: {
  readonly canvasName: string;
  readonly target: ExtractTarget;
  readonly source: FileSource;
  readonly shot: BoxShot;
}): Promise<ExtractOutcome> => {
  const put = window.junto?.contentPutImage;
  if (put === undefined) return { kind: "failed", line: "The content store is not available in this window." };
  const name = fileNameOf(source.path).replace(/\.[^.]*$/, "") || "extract";
  const stored = await put({
    bytesBase64: base64Of(shot.png),
    mediaType: "image/png",
    displayName: `${name}${source.page === undefined ? "" : `-p${source.page}`}.png`,
  }).catch((error: unknown) => ({ ok: false as const, error: error instanceof Error ? error.message : String(error) }));
  if (!stored.ok) return { kind: "failed", line: stored.error };
  const artifactId = mintItemId();
  const ruling = await applyArtifactOp(canvasName, target.id, artifactId, {
    op: "create",
    title: extractTitle(source.path, source.page),
    body: { type: "file", content: stored.ref, source },
  });
  if (ruling.kind === "applied") return { kind: "created", artifactId, target };
  if (ruling.kind === "queued") return { kind: "queued", target };
  return { kind: "failed", line: ruling.error.message };
};
