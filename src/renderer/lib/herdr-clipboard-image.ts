/**
 * Extract image payloads from browser ClipboardEvent / drag-drop DataTransfer
 * for the herdr terminal attach path. Mirrors herdr's remote bridge: bytes go
 * to the host via `terminal.clipboard_image`, which stages a temp file and
 * pastes the absolute path into the pane.
 */

/** Match herdr MAX_CLIPBOARD_IMAGE_PAYLOAD (16 MiB). */
export const HERDR_CLIPBOARD_IMAGE_MAX_BYTES = 16 * 1024 * 1024;

export interface HerdrClipboardImage {
  readonly extension: string;
  readonly dataBase64: string;
  readonly byteLength: number;
}

const MIME_TO_EXT: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
};

export const extensionFromMime = (mime: string): string | undefined => {
  const key = mime.trim().toLowerCase().split(";")[0]?.trim() ?? "";
  return MIME_TO_EXT[key];
};

export const extensionFromFileName = (name: string): string | undefined => {
  const match = /\.([a-z0-9]+)$/i.exec(name.trim());
  if (!match) return undefined;
  const ext = match[1]!.toLowerCase();
  if (ext === "jpeg") return "jpg";
  if (ext === "png" || ext === "jpg" || ext === "gif" || ext === "webp" || ext === "bmp") {
    return ext;
  }
  return undefined;
};

/** Encode binary without blowing the call stack on large images. */
export const uint8ToBase64 = (bytes: Uint8Array): string => {
  const chunk = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunk) {
    const slice = bytes.subarray(i, Math.min(i + chunk, bytes.length));
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
};

export const fileToHerdrClipboardImage = async (
  file: File,
): Promise<HerdrClipboardImage | { readonly error: string }> => {
  const extension =
    extensionFromMime(file.type) ?? extensionFromFileName(file.name) ?? "png";
  if (file.size <= 0) return { error: "empty image" };
  if (file.size > HERDR_CLIPBOARD_IMAGE_MAX_BYTES) {
    return { error: `image too large (${file.size} bytes; max ${HERDR_CLIPBOARD_IMAGE_MAX_BYTES})` };
  }
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  if (bytes.byteLength === 0) return { error: "empty image" };
  if (bytes.byteLength > HERDR_CLIPBOARD_IMAGE_MAX_BYTES) {
    return {
      error: `image too large (${bytes.byteLength} bytes; max ${HERDR_CLIPBOARD_IMAGE_MAX_BYTES})`,
    };
  }
  return {
    extension,
    dataBase64: uint8ToBase64(bytes),
    byteLength: bytes.byteLength,
  };
};

/**
 * Prefer clipboard items (screenshot paste) then FileList (file paste / drop).
 * Returns null when no image is present so callers can fall through to text paste.
 */
export const extractHerdrClipboardImage = async (
  data: DataTransfer | null | undefined,
): Promise<HerdrClipboardImage | { readonly error: string } | null> => {
  if (!data) return null;

  const candidates: File[] = [];
  if (data.items) {
    for (const item of Array.from(data.items)) {
      if (item.kind === "file" && item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) candidates.push(file);
      }
    }
  }
  if (candidates.length === 0 && data.files?.length) {
    for (const file of Array.from(data.files)) {
      if (file.type.startsWith("image/") || extensionFromFileName(file.name)) {
        candidates.push(file);
      }
    }
  }
  if (candidates.length === 0) return null;
  return fileToHerdrClipboardImage(candidates[0]!);
};
