import { act } from "react";
import { vi } from "vitest";

/**
 * Lets a lazily loaded surface (the editors, the diff view, the file tree)
 * arrive and draw: waits for the imports a render started, then for the
 * render they wake.
 */
export const settleLazy = async (): Promise<void> => {
  await act(async () => {
    await vi.dynamicImportSettled();
  });
};
