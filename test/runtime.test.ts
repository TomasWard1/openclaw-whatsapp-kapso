import { test } from "node:test";
import assert from "node:assert/strict";
import { setKapsoRuntime, getKapsoRuntime, __resetKapsoRuntime } from "../src/runtime.ts";

test("getKapsoRuntime throws before set", () => {
  __resetKapsoRuntime();
  assert.throws(() => getKapsoRuntime(), /not initialized/);
});

test("setKapsoRuntime then getKapsoRuntime returns the same ref", () => {
  __resetKapsoRuntime();
  const rt = { hello: "world" };
  setKapsoRuntime(rt);
  assert.strictEqual(getKapsoRuntime(), rt);
  __resetKapsoRuntime();
});
