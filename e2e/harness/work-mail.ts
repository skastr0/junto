import type { Page } from "@playwright/test";
import type { Message } from "../../src/shared/work-model";

export const readSeatMailbox = (page: Page, canvasName: string, nodeId: string): Promise<ReadonlyArray<Message>> =>
  page.evaluate(async ({ canvasName, nodeId }) => {
    const messages: Message[] = [];
    let beforePosition: number | undefined;
    do {
      const page = await window.junto!.workMailPage({ canvasName, nodeId, limit: 200,
        ...(beforePosition === undefined ? {} : { beforePosition }) });
      messages.push(...page.items.map((item) => item.message));
      beforePosition = page.nextBeforePosition;
    } while (beforePosition !== undefined);
    return messages;
  }, { canvasName, nodeId });
