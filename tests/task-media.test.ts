import { describe, expect, it } from "vitest";
import {
  base64DecodedByteLength,
  isTaskMediaPart,
  taskMediaParts,
  validateTaskMediaParts,
  TASK_MEDIA_MAX_PARTS,
} from "../src/shared/task";
import type { Task } from "../src/shared/work-model";

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("task media helpers", () => {
  it("accepts raw image parts and rejects disallowed types", () => {
    expect(
      validateTaskMediaParts([
        { kind: "raw", bytesBase64: PNG, mediaType: "image/png" },
      ]),
    ).toBeUndefined();
    expect(
      validateTaskMediaParts([
        { kind: "raw", bytesBase64: PNG, mediaType: "image/svg+xml" },
      ]),
    ).toMatch(/not allowed/);
    expect(
      validateTaskMediaParts([
        { kind: "text", text: "nope" },
      ]),
    ).toMatch(/must be a raw part/);
  });

  it("enforces part count and decodes base64 length", () => {
    const many = Array.from({ length: TASK_MEDIA_MAX_PARTS + 1 }, () => ({
      kind: "raw" as const,
      bytesBase64: PNG,
      mediaType: "image/png",
    }));
    expect(validateTaskMediaParts(many)).toMatch(/at most/);
    expect(base64DecodedByteLength(PNG)).toBe(70);
    expect(base64DecodedByteLength("")).toBe(0);
  });

  it("extracts media from history[0] only", () => {
    const task: Task = {
      id: "t1",
      state: "submitted",
      history: [
        {
          messageId: "m1",
          role: "user",
          parts: [
            { kind: "text", text: "brief" },
            { kind: "raw", bytesBase64: PNG, mediaType: "image/png" },
          ],
        },
        {
          messageId: "m2",
          role: "agent",
          parts: [
            { kind: "raw", bytesBase64: PNG, mediaType: "image/png" },
          ],
        },
      ],
    };
    const media = taskMediaParts(task);
    expect(media).toHaveLength(1);
    expect(isTaskMediaPart(media[0]!)).toBe(true);
  });
});
