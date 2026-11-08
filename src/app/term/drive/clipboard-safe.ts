/**
 * Grok clipboard preflight — abort paste when an image is advertised by the
 * pasteboard. This is deliberately a pure metadata check. Reading clipboard
 * contents (including `osascript clipboard info`) asks macOS to decode image
 * payloads and used to flood the main process with ImageIO/JP2 failures on
 * every delivery retry.
 */

const IMAGE_CLIPBOARD_FORMAT =
  /^(?:image\/|public\.(?:png|tiff|jpeg|jpg|gif|bmp)|com\.compuserve\.gif|neXT TIFF|PNG|TIFF|JPEG|JPG|GIF|BMP$)/i;

export const clipboardFormatsAreSafeForGrok = (
  formats: ReadonlyArray<string>,
): boolean => !formats.some((format) => IMAGE_CLIPBOARD_FORMAT.test(format));
