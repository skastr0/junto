/**
 * A unit test runs the core and main in one process, with no port between
 * them: what the core publishes is handed straight to main's subscribers, as
 * the port relay does in the app (`main-side/window-pushes.ts`).
 */
import { sendPushesTo } from "../src/main/core-process/push";
import { deliverPush } from "../src/main/core-process/main-side/core-pushes";

sendPushesTo(deliverPush);
