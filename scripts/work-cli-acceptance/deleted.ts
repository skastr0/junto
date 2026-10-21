/** Deleted commands: each is refused as gone. Owner: pty-contract. */
import type { AcceptanceArea } from "./area";

export const deletedArea: AcceptanceArea = {
  name: "deleted",
  owner: "pty-contract",
  run: async () => [],
};
