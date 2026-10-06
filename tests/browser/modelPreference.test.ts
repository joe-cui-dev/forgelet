import { expect, test } from "@jest/globals";
import { normalizeWorkbenchModel } from "../../src/browser/extension/modelPreference.js";

test("a stored Workbench model preference keeps its routable ids", () => {
  expect(normalizeWorkbenchModel("deepseek-flash")).toBe("deepseek-flash");
  expect(normalizeWorkbenchModel("deepseek-v4-pro")).toBe("deepseek-v4-pro");
});

test("the legacy deepseek-v4-flash preference migrates to deepseek-flash", () => {
  expect(normalizeWorkbenchModel("deepseek-v4-flash")).toBe("deepseek-flash");
});

test("anything else selects no model, so the Route decides", () => {
  expect(normalizeWorkbenchModel("default")).toBeUndefined();
  expect(normalizeWorkbenchModel("deepseek-chat")).toBeUndefined();
  expect(normalizeWorkbenchModel(undefined)).toBeUndefined();
});
