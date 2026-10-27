import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { parseFilePath } from "@shared/files";
import { asNodeId } from "@shared/model";
import { themeFor } from "../../lib/theme";
import { themeMode$ } from "../../lib/theme-mode";
import type { BoxComment } from "../file-view/box-tools";
import { Eyebrow } from "../ui";
import "../file-view/file-view.css";

const PdfViewer = lazy(() => import("../file-view/PdfViewer").then((m) => ({ default: m.PdfViewer })));
const ImageViewer = lazy(() => import("../file-view/ImageViewer").then((m) => ({ default: m.ImageViewer })));

/**
 * Dev gallery for the file viewers (plan 0.11, F6): a three-page PDF and an
 * image made here, in the viewers as the Files modal shows them, for judging
 * by eye in both themes. Route: `#/gallery/files`. There is no Files node, so
 * nothing is in reach to extract to and the bytes are handed over directly.
 */
const PAGES: ReadonlyArray<ReadonlyArray<string>> = [
  ["Junto fixture page one", "A box drawn here becomes an image artifact.", "Text on this page selects and copies."],
  ["Junto fixture page two", "Quarterly numbers, the table below.", "North 412   South 388   East 297"],
  ["Junto fixture page three", "The last page, for stepping and the page field."],
];

/** A valid PDF: Helvetica lines and a ruled box per page, with a correct xref. */
const galleryPdf = (pages: ReadonlyArray<ReadonlyArray<string>>): Uint8Array => {
  const objects: string[] = [];
  const pageIds = pages.map((_, index) => 4 + index * 2);
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  pages.forEach((lines, index) => {
    const pageId = pageIds[index]!;
    const text = lines.map((line, at) => `BT /F1 ${at === 0 ? 24 : 14} Tf 72 ${700 - at * 36} Td (${line}) Tj ET`).join("\n");
    const stream = `${text}\n0.2 0.4 0.8 RG 2 w 72 360 468 200 re S\n0.95 0.75 0.3 rg 96 400 120 120 re f`;
    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageId + 1} 0 R >>`;
    objects[pageId + 1] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = body.length;
    body += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xrefAt = body.length;
  body += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id += 1) body += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return new TextEncoder().encode(body);
};

/** A 640 by 400 gradient with a grid, as a blob URL. */
const useGalleryImage = (): string | null => {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 400;
    const context = canvas.getContext("2d");
    if (context === null) return;
    const gradient = context.createLinearGradient(0, 0, 640, 400);
    const hues = themeFor("dark");
    gradient.addColorStop(0, hues.indigo!);
    gradient.addColorStop(1, hues.amber!);
    context.fillStyle = gradient;
    context.fillRect(0, 0, 640, 400);
    context.strokeStyle = hues.ink!;
    for (let x = 0; x <= 640; x += 80) context.strokeRect(x, 0, 0, 400);
    for (let y = 0; y <= 400; y += 80) context.strokeRect(0, y, 640, 0);
    let made: string | null = null;
    canvas.toBlob((blob) => {
      if (blob === null) return;
      made = URL.createObjectURL(blob);
      setUrl(made);
    }, "image/png");
    return () => {
      if (made !== null) URL.revokeObjectURL(made);
    };
  }, []);
  return url;
};

const NODE = asNodeId("files-gallery");

export function FileViewGallery() {
  useEffect(() => {
    document.title = "Gallery, file viewers";
    // `#/gallery/files?theme=bright` or `?theme=dark` shows one theme whatever the app is set to.
    const asked = window.location.hash.match(/[?&]theme=(dark|bright)/u)?.[1];
    if (asked === "dark" || asked === "bright") themeMode$.set(asked);
  }, []);
  const pdf = useMemo(() => galleryPdf(PAGES), []);
  const image = useGalleryImage();
  const [said, setSaid] = useState("No comment yet");
  const onComment = (comment: BoxComment): void =>
    setSaid(
      `Comment on ${comment.page === undefined ? "the image" : `page ${comment.page}`} at ${comment.box.x.toFixed(2)}, ${comment.box.y.toFixed(2)}, shot ${comment.shot.width} by ${comment.shot.height}`,
    );
  return (
    <main className="min-h-screen bg-ground p-6 text-ink" data-testid="file-view-gallery">
      <p className="mb-4 text-dim" data-testid="file-view-gallery-said" role="status">
        {said}
      </p>
      <div className="grid grid-cols-2 gap-6">
        <section className="grid gap-2">
          <Eyebrow>PDF, three pages</Eyebrow>
          <div className="h-[760px] overflow-hidden rounded-lg border border-stroke" data-testid="gallery-pdf">
            <Suspense fallback={null}>
              <PdfViewer
                canvasName=""
                nodeId={NODE}
                path={parseFilePath("docs/sample.pdf")!}
                url=""
                data={pdf}
                boxes={[{ id: "thread-1", page: 1, box: { x: 0.55, y: 0.48, w: 0.3, h: 0.12 }, label: "A comment thread" }]}
                onComment={onComment}
              />
            </Suspense>
          </div>
        </section>
        <section className="grid gap-2">
          <Eyebrow>Image, 640 by 400</Eyebrow>
          <div className="h-[760px] overflow-hidden rounded-lg border border-stroke" data-testid="gallery-image">
            {image === null ? null : (
              <Suspense fallback={null}>
                <ImageViewer canvasName="" nodeId={NODE} path={parseFilePath("img/gradient.png")!} url={image} onComment={onComment} />
              </Suspense>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
