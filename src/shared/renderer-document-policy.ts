/**
 * The app document opts in to having its JavaScript call stack read by main
 * while it is unresponsive (Chromium's Document-Policy opt-in behind
 * `WebFrameMain.collectJavaScriptCallStack`). Main records that stack to the
 * hang log; nothing leaves the machine. Every server of the renderer HTML
 * sends it: the packaged protocol, and the e2e loopback server.
 */
export const RENDERER_DOCUMENT_POLICY_HEADER = "Document-Policy";
export const RENDERER_DOCUMENT_POLICY = "include-js-call-stacks-in-crash-reports";
