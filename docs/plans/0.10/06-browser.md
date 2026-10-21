# 06 Browser

Proposed owner: product (UI), remote (removal from Junto Remote). Reviewers:
canvas, cli.

## Target

The browser is a local tool on the operator's desktop machine. A page node
holds tabs. Seats connected to it by an edge drive it; seats in reach
comment on it by selecting a box on the page and mentioning someone. It
never runs on Junto Remote and pulls no GUI requirement onto Linux machines
without a window.

## Today

- About 14k lines in `src/main/junto/browser/`: a control plane over a unix
  socket (`control.ts`), warm sessions (`sessions.ts`, 2838 lines), Electron
  `WebContentsView`s under one hidden window (`composition-host.ts`), eval in
  an isolated world and `capturePage` screenshots (`view-adapter.ts:654-660`).
  No CDP.
- Profiles with their own `persist:` partitions, epoch admission, wipe and
  drain, an app-owned egress proxy (`profiles.ts`, `profile-gate.ts`,
  `profile-storage.ts`, `egress-proxy.ts`).
- Seats drive a page through a `navigates` edge granting `browser.automate`;
  admission binds the process to its node and issues a short-lived grant;
  deleting the edge tears the session down (`process-bind.ts`,
  `edge-grant.ts`, `edge-revocation.ts`).
- Cross-machine automation is already mostly gone: callers and pages not on
  this machine are refused (`edge-grant.ts:372-402`,
  `host-capability.ts:55-77`). Residue: `Page.host`, region `page_host`
  default, the host registry `browser` capability bit, the Inspector host
  picker, page hosts in canvas copies.
- One page node is one URL. No tabs. No comments.

## Design

- **Local.** A page node lives on the machine that created it, which must
  have a window. It is not carried to other machines (02). Seats on other
  machines cannot connect to it.
- **Tabs.** A page node holds an ordered list of tabs, each its own
  `WebContentsView` in the node's profile partition. `browser.automate`
  names the tab; with none it acts on the active tab. Seats can open and
  close tabs.
- **Automation.** Keep the edge model (`navigates`) and the grant machinery.
  Spike: a computer-use style driver on top of what exists (screenshot,
  `sendInputEvent` click and type, scroll, accessibility snapshot) so a seat
  can operate a page without writing scripts. Decide after the spike whether
  it embeds or stays a thin command set.
- **Comments.** A seat in reach (01) or the operator selects a box on the
  page; the thread subject is the page with a `box` anchor carrying the URL,
  the rectangle in page coordinates, the scroll offset and a cropped
  screenshot as content (03). Mentions as everywhere. Comment threads are
  universal facts even though the page is local: a seat elsewhere reads the
  thread and the crop, not the live page.
- **Less hostile.** Address bar, back and forward, reload, tab strip, a clear
  "which seat is driving" mark, and a takeover control for the operator.
  Needs design iteration with product-typography and product-keyboard.

## Kept, reshaped, deleted

| | |
|---|---|
| Kept | Control plane, sessions, profiles and isolation, egress proxy, view adapter, process binding and edge grants |
| Reshaped | Page node holds tabs; automation names a tab |
| Deleted | `Page.host`, `pages.host`, region `page_host` default, host registry `browser` capability and `BROWSER_HOST_CAPABILITY`, Inspector machine picker for pages, page hosts in canvas copies, `--host` and station remnants in `scripts/browser-cli.ts`, page `announces` to relay |
| New | Tabs, box comments, the driver spike result, browser chrome |

## Questions

- **remote**: Anything in the Linux desktop alpha or the machine bundle that
  still references the browser and must go with it?
- **cli**: Browser commands today live in `scripts/browser-cli.ts` and the
  control socket. Move them under `junto browser` with the seat's grant?
- **canvas**: A page node on a canvas edited from another machine: shown as a
  stub on that machine, or not drawn at all?
