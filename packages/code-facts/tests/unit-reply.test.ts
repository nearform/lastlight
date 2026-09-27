/**
 * THE reply rule — `findUnitObject` + `isUsableUnitReply` (`src/unit-response.ts`).
 *
 * The core handler (`apps/server/src/workflows/handlers/survey-units.ts`)
 * decides its retry and whether to cache off the same two rules, and its test
 * carries a VERBATIM copy of `CASES` below. If a case changes here, change it
 * there: two readers of one reply that disagree is a reading the handler
 * cached and ingest calls `invalid` forever.
 */
import { describe, expect, it } from "vitest";

import { findUnitObject, isUsableUnitReply } from "../src/unit-response.js";

const OBJ = '{"unitId":"u-001","answers":[],"defects":[]}';

/** [name, raw, unitId, the expected `unitId` of the object found — or null for none]. */
const CASES: [string, string, string, string | null][] = [
  ["plain", OBJ, "u-001", "u-001"],
  ["plain, surrounding whitespace", `\n  ${OBJ}\n`, "u-001", "u-001"],
  ["fenced", "```json\n" + OBJ + "\n```", "u-001", "u-001"],
  ["fenced, no language tag", "```\n" + OBJ + "\n```", "u-001", "u-001"],
  ["prose around", `Here is my answer:\n${OBJ}\nHope that helps.`, "u-001", "u-001"],
  ["stray unclosed brace in prose before", `The config uses { braces. ${OBJ}`, "u-001", "u-001"],
  ["stray brace and quote in prose before", `Note: {"unfinished ${OBJ}`, "u-001", "u-001"],
  ["balanced non-JSON braces in prose before", `A set {a, b} then ${OBJ}`, "u-001", "u-001"],
  ["brace inside a JSON string", '{"unitId":"u-001","answers":[],"defects":[],"note":"a } and a {"}', "u-001", "u-001"],
  ["nested under a key", `{"result":${OBJ}}`, "u-001", "u-001"],
  ["nested in an array under a key", `{"units":[{"unitId":"u-000"},${OBJ}]}`, "u-001", "u-001"],
  ["two objects, the second matches", `{"unitId":"u-999","answers":[],"defects":[]}\n${OBJ}`, "u-001", "u-001"],
  ["a quoted snippet before the fenced answer", 'Example: {"unitId":"u-999"}\n```json\n' + OBJ + "\n```", "u-001", "u-001"],
  ["top-level match wins over a nested one", `{"unitId":"u-001","answers":[],"defects":[],"echo":{"unitId":"u-001","answers":[1],"defects":[]}}`, "u-001", "u-001"],
  ["truncated / unclosed", '{"unitId":"u-001","answers":[{"obligation":"O-1"', "u-001", null],
  ["only another unit's object", '{"unitId":"u-002","answers":[],"defects":[]}', "u-001", null],
  ["nested two levels deep is not found", `{"a":{"b":${OBJ}}}`, "u-001", null],
  ["unitId is a number, not the string", '{"unitId":1,"answers":[],"defects":[]}', "1", null],
  ["none", "I could not produce an answer.", "u-001", null],
  ["empty", "", "u-001", null],
  ["line copied with the tag's zero padding", '{"unitId":"u-001","answers":[],"defects":[{"family":"state","claim":"c","line": 0142,"evidence":{}}]}', "u-001", "u-001"],
];

describe("findUnitObject — the canonical case table", () => {
  it.each(CASES)("%s", (_name, raw, unitId, expected) => {
    const found = findUnitObject(raw, unitId);
    if (expected === null) expect(found).toBeNull();
    else expect(found?.unitId).toBe(expected);
  });

  it("returns the top-level object when a nested copy also matches", () => {
    const raw = `{"unitId":"u-001","answers":[],"defects":[],"echo":{"unitId":"u-001","answers":[1],"defects":[]}}`;
    expect(findUnitObject(raw, "u-001")?.answers).toEqual([]);
  });
});

/** [name, value, unitId, usable]. */
const USABLE: [string, unknown, string, boolean][] = [
  ["answers and defects arrays", { unitId: "u-001", answers: [], defects: [] }, "u-001", true],
  ["entries are not inspected", { unitId: "u-001", answers: [{ nonsense: true }], defects: [42] }, "u-001", true],
  ["another unit's id", { unitId: "u-002", answers: [], defects: [] }, "u-001", false],
  ["no defects", { unitId: "u-001", answers: [] }, "u-001", false],
  ["no answers", { unitId: "u-001", defects: [] }, "u-001", false],
  ["answers is an object", { unitId: "u-001", answers: {}, defects: [] }, "u-001", false],
  ["null", null, "u-001", false],
  ["an array", [{ unitId: "u-001", answers: [], defects: [] }], "u-001", false],
];

describe("isUsableUnitReply — the structural rule", () => {
  it.each(USABLE)("%s", (_name, value, unitId, usable) => {
    expect(isUsableUnitReply(value, unitId)).toBe(usable);
  });
});
