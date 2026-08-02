import { describe, expect, it } from "vitest";
import {
  contentObjectUrl,
  parseContentObjectUrl,
} from "../src/shared/content-url";
import type { ContentRef } from "../src/shared/content";
import {
  imageContentRefFromFile,
  markdownImageLine,
  mediaTypeFromImageExtension,
} from "../src/renderer/lib/image-content";

const ref = {
  sha256: "c".repeat(64),
  byteLength: 128,
  mediaType: "image/png",
  displayName: "shot.png",
} as ContentRef;

describe("image content helpers", () => {
  it("maps extensions to media types", () => {
    expect(mediaTypeFromImageExtension("png")).toBe("image/png");
    expect(mediaTypeFromImageExtension("jpg")).toBe("image/jpeg");
    expect(mediaTypeFromImageExtension("webp")).toBe("image/webp");
  });

  it("round-trips content URL as image file path", () => {
    const url = contentObjectUrl(ref);
    expect(imageContentRefFromFile(url)).toEqual(ref);
    expect(imageContentRefFromFile("docs/readme.md")).toBeUndefined();
    expect(
      imageContentRefFromFile(
        contentObjectUrl({
          ...ref,
          mediaType: "application/pdf" as ContentRef["mediaType"],
        }),
      ),
    ).toBeUndefined();
  });

  it("builds a markdown image line from a ContentRef", () => {
    const line = markdownImageLine(ref, "shot");
    expect(line.startsWith("![shot](")).toBe(true);
    const parsed = parseContentObjectUrl(line.slice("![shot](".length, -1));
    expect(parsed).toEqual(ref);
  });
});
