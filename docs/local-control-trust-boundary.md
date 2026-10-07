# Local control trust boundary

Junto control transports are owner-local Unix-domain sockets. Their directories are
0700; live socket paths are 0600. Terminal and browser control still keep a
rotating bearer-token file at 0600. Work control does not: the seat credential
lives in `JUNTO_WORK_TOKEN`, not on disk. Startup fails closed when those modes
cannot be established, a path is a symlink/non-socket, or the pre-bind socket
has a live or ambiguous listener. Stale cleanup is limited to the exact socket
inode observed refusing connections; token cleanup is limited to the exact
exclusive temporary inode created by the process.

Terminal control intentionally treats the station Unix account as its administrator
boundary: a same-UID process that can read its token can administer terminal
sessions. It must not be treated as a browser or work authorization grant.

Browser control still admits by Unix peer process-bind plus human-authored edge
scope, after its own token file. Work control admits by the seat generation
credential plus canvas-derived edge authorization. The credential names the
generation. Edges still decide what that seat may do. Neither plane accepts a
caller-chosen node id.

All control transports impose bounded frames/bodies, admitted-client work, and
shutdown drains. Errors must stay bounded and never include tokens, capability
secrets, request bodies, terminal input, page data, or remote endpoint secrets.

Residual same-UID race: portable Node/POSIX does not expose an atomic
compare-identity-and-rename operation. Cleanup performs a final identity check
immediately before quarantine rename and verifies the moved inode before unlink.
If another same-UID process swaps the canonical entry in the irreducible gap,
the replacement can be moved into the owner-only quarantine but is never
unlinked; startup fails closed. Deterministic swaps before that final check stay
at the canonical path and fail without being moved.
