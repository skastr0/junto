import { isAbsolute, sep } from "node:path";
import { deny, machineName, nodeFacts } from "./host-deps";
import { peerSubscribers } from "./peer-subscribers";
import { makeFilesService, type FilesService } from "./service";
import { trashMove } from "./trash-move";

/**
 * The Files service in a windowless core (0.12, X1c): the same service the app
 * builds, with no shell and no window. Its only subscribers are peers over the
 * link, so a change goes to `peerSubscribers`; it has no screen, so opening
 * and revealing are refused (no op of the `files` channel reaches them); and
 * the root index runs in process, as `FilesServiceDeps.index` leaves it unset.
 */
/**
 * The far trusts nothing in the copy it serves (X6, remote-security F3): a
 * root a peer reaches is absolute as named, is not `/`, does not hold this
 * machine's Junto home, and is not inside it. Realpath scoping and the deny
 * list on every path under it are the service's own, as for any node.
 */
export const servesPeerRoot = (juntoHomes: () => Promise<ReadonlyArray<string>>) =>
  async (named: string, real: string): Promise<boolean> => {
    if (!isAbsolute(named) || real === sep) return false;
    const inside = (child: string, parent: string): boolean => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
    return (await juntoHomes()).every((home) => !inside(home, real) && !inside(real, home));
  };

export const makeHeadlessFilesService = (): FilesService =>
  makeFilesService({
    servesRoot: servesPeerRoot(deny),
    node: nodeFacts,
    machineName,
    deny,
    trash: trashMove(),
    openPath: async () => "This machine has no screen to open a file on.",
    reveal: () => undefined,
    send: (subscriber, event) => {
      peerSubscribers.deliver(subscriber, event);
    },
  });
