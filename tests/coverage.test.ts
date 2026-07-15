import assert from "node:assert/strict";
import test from "node:test";
import type { ExtractionProposal, TargetFieldSchema } from "@kontourai/traverse";
import { checkSchemaCoverage } from "../src/coverage.js";

function proposal(fieldPath: string, overrides: Partial<ExtractionProposal> = {}): ExtractionProposal {
  return {
    fieldPath,
    candidateValue: "value",
    confidence: 0.9,
    provenance: { excerpt: "value", locator: "chars:0-5" },
    extractor: "example-extractor:v1",
    ...overrides,
  };
}

const schema: TargetFieldSchema[] = [
  { path: "a.one", type: "number", required: true },
  { path: "a.two", type: "string" },
  { path: "b.list", type: "array", required: true },
];

test("every declared field covered yields no gaps and lists covered in schema order", () => {
  const result = checkSchemaCoverage(schema, [
    proposal("b.list", { candidateValue: ["x"] }),
    proposal("a.two"),
    proposal("a.one", { candidateValue: 1 }),
  ]);
  assert.deepEqual(result.covered, ["a.one", "a.two", "b.list"]);
  assert.deepEqual(result.gaps, []);
});

test("a declared field the extractor never produced is a gap carrying its required flag", () => {
  const result = checkSchemaCoverage(schema, [proposal("a.two")]);
  assert.deepEqual(result.covered, ["a.two"]);
  assert.deepEqual(result.gaps, [
    { fieldPath: "a.one", required: true },
    { fieldPath: "b.list", required: true },
  ]);
});

test("a schema field without an explicit required flag reports required: false", () => {
  const result = checkSchemaCoverage([{ path: "a.two", type: "string" }], []);
  assert.deepEqual(result.gaps, [{ fieldPath: "a.two", required: false }]);
});

test("gaps preserve schema order regardless of proposal order", () => {
  const wide: TargetFieldSchema[] = [
    { path: "p1", type: "string" },
    { path: "p2", type: "string" },
    { path: "p3", type: "string" },
    { path: "p4", type: "string" },
  ];
  const result = checkSchemaCoverage(wide, [proposal("p3")]);
  assert.deepEqual(result.covered, ["p3"]);
  assert.deepEqual(result.gaps.map((gap) => gap.fieldPath), ["p1", "p2", "p4"]);
});

test("a proposal whose fieldPath is not declared is neither covered nor a gap", () => {
  const result = checkSchemaCoverage(schema, [
    proposal("a.one", { candidateValue: 1 }),
    proposal("a.two"),
    proposal("b.list", { candidateValue: [] }),
    proposal("undeclared.extra"),
  ]);
  assert.deepEqual(result.covered, ["a.one", "a.two", "b.list"]);
  assert.deepEqual(result.gaps, []);
  assert.ok(!result.covered.includes("undeclared.extra"));
});

test("multiple proposals for one declared path count that path as covered exactly once", () => {
  const result = checkSchemaCoverage([{ path: "a.one", type: "number" }], [
    proposal("a.one", { candidateValue: 1 }),
    proposal("a.one", { candidateValue: 2, pathIndices: [1] }),
  ]);
  assert.deepEqual(result.covered, ["a.one"]);
  assert.deepEqual(result.gaps, []);
});

test("no proposals makes every declared field a gap; covered and gaps stay disjoint and total", () => {
  const result = checkSchemaCoverage(schema, []);
  assert.deepEqual(result.covered, []);
  assert.deepEqual(result.gaps.map((gap) => gap.fieldPath), ["a.one", "a.two", "b.list"]);
  const union = [...result.covered, ...result.gaps.map((gap) => gap.fieldPath)];
  assert.equal(union.length, schema.length);
});

test("an empty schema is vacuously fully covered", () => {
  const result = checkSchemaCoverage([], [proposal("anything")]);
  assert.deepEqual(result.covered, []);
  assert.deepEqual(result.gaps, []);
});

test("a schema that repeats a declared path reports it once per occurrence", () => {
  const result = checkSchemaCoverage(
    [
      { path: "dup", type: "string" },
      { path: "dup", type: "string", required: true },
    ],
    [],
  );
  assert.deepEqual(result.gaps, [
    { fieldPath: "dup", required: false },
    { fieldPath: "dup", required: true },
  ]);
});
