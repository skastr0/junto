import { serveEngine } from "./port.js";

const handle = serveEngine((message) => self.postMessage(message));
self.onmessage = (event) => handle(event.data);
