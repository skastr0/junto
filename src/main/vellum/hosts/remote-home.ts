export const isSafeRemoteHomePath = (value: string): boolean => {
  if (
    !value.startsWith("/") ||
    value === "/" ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    return false;
  }
  const segments = value.slice(1).split("/");
  return segments.every(
    (segment) => segment.length > 0 && segment !== "." && segment !== "..",
  );
};

export const decodeRemoteHomeDirectoryOutput = (
  output: string,
): string | null => {
  if (!output.endsWith("\n")) return null;
  const path = output.slice(0, -1);
  if (path.includes("\n") || path.trim() !== path) return null;
  return isSafeRemoteHomePath(path) ? path : null;
};
