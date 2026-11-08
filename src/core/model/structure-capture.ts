/**
 * While set in a fiber, every canvas change a canvas command makes in it is
 * handed here instead of published: the authority judges a batch in a
 * savepoint it rolls back, keeps each change as a `structure.changed` entry,
 * and the change lands, and is published, when its entry applies through
 * `ModelService.fold` (0.11/06 F4). Unset, a command publishes as it always
 * has. The tag stands alone so the driver can set it without the model.
 */
import { Context } from "effect";
import type { Changed } from "@shared/model";

export const StructureCapture = Context.Reference<((change: Changed) => void) | undefined>(
  "@junto/StructureCapture",
  { defaultValue: () => undefined },
);
