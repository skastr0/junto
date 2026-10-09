import { expect, it } from "vitest";
import { classifyMachineForm } from "../src/main/junto/hosts/machine-form";

it("classifies Apple hardware identifiers without guessing from machine names", () => {
  expect(classifyMachineForm("darwin", "Mac16,10\n")).toBe("mac-mini");
  expect(classifyMachineForm("darwin", "Mac14,12")).toBe("mac-mini");
  expect(classifyMachineForm("darwin", "Macmini9,1")).toBe("mac-mini");
  expect(classifyMachineForm("darwin", "Mac16,9")).toBe("mac-studio");
  expect(classifyMachineForm("darwin", "Mac13,2")).toBe("mac-studio");
  expect(classifyMachineForm("darwin", "MacBookPro18,3")).toBe("macbook");
  expect(classifyMachineForm("darwin", "Mac16,12")).toBe("macbook");
  expect(classifyMachineForm("darwin", "Mac17,7")).toBe("macbook");
  expect(classifyMachineForm("darwin", "Mac99,99")).toBe("mac");
  expect(classifyMachineForm("darwin", "mac-mini")).toBe("mac");
  expect(classifyMachineForm("linux", "Mac16,10")).toBe("linux");
});
