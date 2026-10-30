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
export const makeHeadlessFilesService = (): FilesService =>
  makeFilesService({
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
