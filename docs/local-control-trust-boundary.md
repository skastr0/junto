# Local control trust boundary

Vellum control transports are owner-local Unix-domain sockets. Their directories are
0700; live socket paths and rotating bearer-token files are 0600. Startup fails
closed when those modes cannot be established, a path is a symlink/non-socket, or
the pre-bind socket has a live or ambiguous listener. Stale cleanup is limited to
the exact socket inode observed refusing connections; token cleanup is limited to
the exact exclusive temporary inode created by the process.

Terminal control intentionally treats the station Unix account as its administrator
boundary: a same-UID process that can read its token can administer terminal
sessions. It must not be treated as a browser or work authorization grant.

Browser and work control retain their independent gates after local token admission:
browser uses Unix peer process-bind plus human-authored edge scope, and work uses
peer process-bind plus canvas-derived edge authorization. Tokens are transport
credentials only; they are never identity or authority delegation.

All control transports impose bounded frames/bodies, admitted-client work, and
shutdown drains. Errors must stay bounded and never include tokens, capability
secrets, request bodies, terminal input, page data, or remote endpoint secrets.
