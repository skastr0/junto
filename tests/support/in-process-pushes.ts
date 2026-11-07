/**
 * What the core pushes reaches main's subscribers in the same process, as the
 * port relay does in the app (`main-side/window-pushes.ts`): the form a test
 * provides when it listens for a push.
 */
import { deliverPush } from "../../src/app/core-process/main-side/core-pushes";
import { CorePushes } from "../../src/core/push";

export const inProcessPushes = CorePushes.toPort(deliverPush);

/** The same pushes as a value, for code that takes them as an argument. */
export const inProcessPushesShape = CorePushes.over(deliverPush);
