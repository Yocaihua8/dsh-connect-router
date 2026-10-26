import { test } from "node:test";
import assert from "node:assert/strict";
import {
  opencodeModels,
  workbuddyModel,
  selectModels,
} from "../src/host/catalog.js";
test("缺失价格和能力不当作免费或支持", () => {
  const [m] = opencodeModels({
    connected: ["a"],
    all: [{ id: "a", models: { m: { id: "m" } } }],
  });
  assert.equal(m?.cost, "unknown");
  assert.equal(m?.contextWindow, undefined);
  assert.equal(m?.tools, false);
  assert.equal(workbuddyModel({ id: "x" }).cost, "unknown");
});
test("明确零价格才是免费，不自动选择付费", () => {
  const models = opencodeModels({
    connected: ["a"],
    all: [
      {
        id: "a",
        models: {
          f: { id: "f", cost: { input: 0, output: 0 } },
          p: { id: "p", cost: { input: 1, output: 2 } },
        },
      },
    ],
  });
  assert.equal(models[0]?.cost, "free");
  assert.equal(models[1]?.cost, "paid");
  assert.deepEqual(selectModels(models, []), []);
  assert.deepEqual(
    selectModels(models, ["a/f"]).map((m) => m.cost),
    ["free"],
  );
});
