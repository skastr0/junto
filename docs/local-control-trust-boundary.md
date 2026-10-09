# Local control trust boundary

Junto control transports are owner-local Unix-domain sockets. Their directories are
0700; live socket paths are 0600. Terminal and browser control keep a rotating
transport-token file at 0600. Work control identifies seats through a main-issued
generation credential in `JUNTO_WORK_TOKEN`, not a credential file. Startup fails
closed when those modes cannot be established, a path is a symlink/non-socket,
or the pre-bind socket has a live or ambiguous listener. Stale cleanup is limited
to the exact socket inode observed refusing connections; token cleanup is limited
to the exact exclusive temporary inode created by the process.

Terminal control intentionally treats the machine's Unix account as its administrator
boundary: a same-UID process that can read its token can administer terminal
sessions. It must not be treated as a browser or work authorization grant.

Owner control and the core's link socket use that same account boundary.
The CLI refuses owner and machine commands when `JUNTO_WORK_TOKEN` is present,
even if its value is empty or malformed. This client guard prevents confused
use; a same-account process can omit the variable or connect directly. The
server does not distinguish that process from the operator. A machine link
also requires a hello matching the pinned peer before admitting its channels;
each channel still checks its own operation and resource authority.

Work and native overseer control resolve a live seat generation credential
through the main-owned registry. Main injects it at spawn; the CLI reads and
presents it. Descendants holding the credential act as that seat.
Edges decide ordinary work reach; closed overseer operations also require the
seat's current human-granted authority. These planes accept no caller-chosen
seat id. Missing credentials receive a clear environment-forwarding diagnosis,
with no disk or process inspection fallback. Unpublished, suspended
and revoked credentials refuse admission. Ending a generation revokes its
credential and derived authority; asynchronous admission cannot retain an old
generation or seat after a change.

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
