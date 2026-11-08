import { Layer } from "effect";
import { ModelActorRefs } from "./actor-refs";
import { ModelRecords } from "./records";
import { ModelService } from "./service";

/** One memoized model, records leaf and actor-reference service per StateEngine. */
export const ModelLive = Layer.provideMerge(
  ModelActorRefs.layer,
  Layer.provideMerge(ModelService.layer, ModelRecords.layer),
);
