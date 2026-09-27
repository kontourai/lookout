import assert from "node:assert/strict";
import test from "node:test";
import { canonicalJson, compareCodeUnits } from "../src/canonical-json.js";

test("canonical JSON writes keys in code-unit order, including integer-like keys", () => {
  const value = { b: 1, "10": 2, "9": 3, "äb": 4, zb: 5, B: 6, nested: { "2": [undefined, Number.NaN, "Ä"], "1": null }, skipped: undefined };
  assert.equal(
    canonicalJson(value),
    '{"10":2,"9":3,"B":6,"b":1,"nested":{"1":null,"2":[null,null,"Ä"]},"zb":5,"äb":4}',
  );
  // Same data as JSON.stringify, only the key order differs.
  assert.deepEqual(JSON.parse(canonicalJson(value)), JSON.parse(JSON.stringify(value)));
});

test("canonical JSON refuses values JSON cannot encode", () => {
  assert.throws(() => canonicalJson(undefined), TypeError);
  assert.throws(() => canonicalJson({ big: 1n }), TypeError);
});

test("code-unit comparison ignores case folding and collation", () => {
  assert.deepEqual(["b", "Ä", "10", "9", "B", "z"].sort(compareCodeUnits), ["10", "9", "B", "b", "z", "Ä"]);
  assert.equal(compareCodeUnits("same", "same"), 0);
});
