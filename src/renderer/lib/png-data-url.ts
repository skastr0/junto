/** PNG bytes as a data URL, so an image can be shown without a blob URL to revoke. Pure. */
export const pngDataUrl = (png: Uint8Array): string => {
  let binary = "";
  const chunk = 0x8000;
  for (let at = 0; at < png.length; at += chunk) {
    binary += String.fromCharCode(...png.subarray(at, at + chunk));
  }
  return `data:image/png;base64,${btoa(binary)}`;
};
