import { lstatSync } from "node:fs";
import { LINUX_RELEASE_FENCE_PATH } from "@shared/linux-release-fence";

const isMissing = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error as { readonly code?: unknown }).code === "ENOENT";

/**
 * Read-only fail-closed projection of the root-owned Linux release fence.
 *
 * Metadata validation is intentionally not an "inactive" escape hatch. Any
 * occupied, unreadable, replaced, or malformed fixed path closes admission;
 * only root repair may make the path absent again.
 */
export const linuxReleaseFenceActive = (
  platform: NodeJS.Platform = process.platform,
  observe: (path: string) => unknown = lstatSync,
): boolean => {
  if (platform !== "linux") return false;
  try {
    observe(LINUX_RELEASE_FENCE_PATH);
    return true;
  } catch (error) {
    return !isMissing(error);
  }
};
