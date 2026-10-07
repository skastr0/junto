import type { Node } from "./kinds";

/** Empty region objects carry no authored setting in the column representation. */
export const normalizeNode = (node: Node): Node => {
  if (node.kind !== "region") return node;
  const defaults = node.defaults === undefined ? undefined : { ...node.defaults };
  if (defaults?.page !== undefined && Object.keys(defaults.page).length === 0) delete defaults.page;
  const emptyDefaults = defaults !== undefined && Object.keys(defaults).length === 0;
  const emptyContract = node.contract !== undefined && Object.keys(node.contract).length === 0;
  if (!emptyDefaults && !emptyContract && defaults?.page === node.defaults?.page) return node;
  const { defaults: _defaults, contract: _contract, ...rest } = node;
  return { ...rest,
    ...(defaults === undefined || emptyDefaults ? {} : { defaults }),
    ...(node.contract === undefined || emptyContract ? {} : { contract: node.contract }),
  };
};
