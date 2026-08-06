/**
 * Stage clipboard/dropped image bytes on the herdr host, then paste the path
 * via stock `terminal.input`. No herdr protocol extensions.
 */
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isKnownHerdrHost, UnknownHerdrHostError } from "./hosts";

/** Match common agent clipboard-image caps (16 MiB). */
export const VELLUM_COMMAND_CLIPBOARD_IMAGE_MAX_BYTES = 16 * 1024 * 1024;

const ALLOWED_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp"]);

export type StageImageResult =
  | { readonly ok: true; readonly path: string; readonly extension: string; readonly byteLength: number }
  | { readonly ok: false; readonly error: string };

export const normalizeImageExtension = (extension: string): string | undefined => {
  const ext = extension.trim().replace(/^\./, "").toLowerCase();
  if (!ALLOWED_EXT.has(ext)) return undefined;
  return ext === "jpeg" ? "jpg" : ext;
};

export const decodeClipboardImageBase64 = (
  extension: string,
  dataBase64: string,
): { readonly ok: true; readonly extension: string; readonly bytes: Buffer } | { readonly ok: false; readonly error: string } => {
  const ext = normalizeImageExtension(extension);
  if (!ext) {
    return { ok: false, error: `clipboard image extension not allowed: ${extension.trim() || "(empty)"}` };
  }
  if (!dataBase64) return { ok: false, error: "clipboard image bytes required" };
  // Bound before decode so a hostile IPC caller cannot force huge peak alloc.
  const maxB64 = Math.ceil((VELLUM_COMMAND_CLIPBOARD_IMAGE_MAX_BYTES * 4) / 3) + 8;
  if (dataBase64.length > maxB64) {
    return {
      ok: false,
      error: `image too large (base64 length ${dataBase64.length}; max ~${maxB64})`,
    };
  }
  const bytes = Buffer.from(dataBase64, "base64");
  if (bytes.byteLength === 0) return { ok: false, error: "empty image" };
  if (bytes.byteLength > VELLUM_COMMAND_CLIPBOARD_IMAGE_MAX_BYTES) {
    return {
      ok: false,
      error: `image too large (${bytes.byteLength} bytes; max ${VELLUM_COMMAND_CLIPBOARD_IMAGE_MAX_BYTES})`,
    };
  }
  return { ok: true, extension: ext, bytes };
};

/** Bracketed paste so pane apps that enable it receive the path atomically. */
export const pastePathPayload = (absolutePath: string): string =>
  `\x1b[200~${absolutePath}\x1b[201~`;

const uniqueName = (extension: string): string =>
  `vellum-command-clip-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}.${extension}`;

export type StageRemoteImage = (
  hostId: string,
  remoteName: string,
  bytes: Uint8Array,
) => Promise<string>;

export type StageImageDeps = {
  readonly stageRemote?: StageRemoteImage;
};

/**
 * Write image bytes onto the host that owns the herdr pane.
 * local: $TMPDIR/vellum-command-herdr-images-<uid>/file
 * remote: /tmp/vellum-command-herdr-images/file via typed remote-plan stage + binary stdin
 *
 * The remote implementation is supplied by the scoped Herdr transport layer.
 */
export const stageImageOnHost = async (
  hostId: string,
  extension: string,
  dataBase64: string,
  deps: StageImageDeps = {},
): Promise<StageImageResult> => {
  if (!isKnownHerdrHost(hostId) || hostId.startsWith("-")) {
    return { ok: false, error: new UnknownHerdrHostError(hostId).message };
  }

  const decoded = decodeClipboardImageBase64(extension, dataBase64);
  if (!decoded.ok) return decoded;

  const name = uniqueName(decoded.extension);

  if (hostId === "local") {
    const uid =
      typeof process.getuid === "function" ? String(process.getuid()) : String(process.pid);
    const dir = join(tmpdir(), `vellum-command-herdr-images-${uid}`);
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const path = join(dir, name);
      await writeFile(path, decoded.bytes, { mode: 0o600 });
      return {
        ok: true,
        path,
        extension: decoded.extension,
        byteLength: decoded.bytes.byteLength,
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  if (!deps.stageRemote) {
    return { ok: false, error: "remote image staging transport is unavailable" };
  }
  try {
    const path = await deps.stageRemote(hostId, name, decoded.bytes);
    return {
      ok: true,
      path,
      extension: decoded.extension,
      byteLength: decoded.bytes.byteLength,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
};
