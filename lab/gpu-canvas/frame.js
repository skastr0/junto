// The canvas as a page of its own, from another site than the window's page,
// so Chromium gives it its own process: as a frame inside the window's page,
// or as a second view in the window.

import { bindInput } from "./input.js";
import { serveEngine } from "./port.js";

const query = new URLSearchParams(location.search);
const canvas = document.querySelector("canvas");
const size = () => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio });

// As a frame the engine answers its parent page. As a view of its own it
// answers over a port the main process hands to both pages.
let post = (message) => parent.postMessage(message, "*");
if (query.get("port") === "1") {
  const waiting = [];
  post = (message) => waiting.push(message);
  addEventListener("message", (event) => {
    if (event.data !== "lab-port" || !event.ports[0]) return;
    const port = event.ports[0];
    port.onmessage = (e) => handle(e.data);
    post = (message) => port.postMessage(message);
    for (const message of waiting) post(message);
  });
} else {
  addEventListener("message", (event) => handle(event.data));
}
const handle = serveEngine((message) => post(message));

handle({ type: "init", canvas, scale: Number(query.get("scale") ?? 1), soft: query.get("soft") === "1", ...size() });
bindInput(canvas, handle);
addEventListener("resize", () => handle({ type: "resize", ...size() }));
