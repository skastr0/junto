import { LINK_CHANNELS, type LinkChannels } from "../../src/main/junto/link/types";
import { unboundYet } from "../../src/main/junto/link/unbound";

/** Every catalog channel bound, as `setChannels` requires; the ones a test cares about replace the stubs. */
export const allChannels = (some: LinkChannels = {}): LinkChannels =>
  ({ ...Object.fromEntries(LINK_CHANNELS.map((name) => [name, unboundYet(name)])), ...some });
