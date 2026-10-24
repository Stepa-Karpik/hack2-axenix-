// @ts-nocheck -- Trusted editor model; never executes user programs.
import test from "node:test";
import assert from "node:assert/strict";
import {
  parseCases,
  writeCases,
  newCase,
  oracleExit,
  withOracleExit,
} from "./testCases.ts";
test("form and JSON roundtrip preserve UTF-8, whitespace, stable ids and empty arguments", () => {
  const value = [
    {
      id: "fixed",
      name: "Кириллица 📦",
      stdinUtf8: "  привет\n\n",
      argv: ["", "two words", "\n"],
      tags: { keep: [1, "x"] },
    },
    { id: "nullable", name: null },
  ];
  const parsed = parseCases(writeCases(value));
  assert.equal(parsed.error, null);
  assert.deepEqual(parsed.cases, value);
  assert.deepEqual(newCase("case-id", "Имя"), {
    id: "case-id",
    name: "Имя",
    stdinUtf8: "",
    argv: [],
  });
});
test("absent oracle differs from expected empty stdout, stderr and explicit zero", () => {
  const cases = [
    { id: "none" },
    {
      id: "empty",
      expectedStdout: "",
      expectedStderr: "",
      expectedExitCode: 0,
    },
    { id: "legacy", expectedExitCodes: [2], expectedExitCode: 1 },
  ];
  const parsed = parseCases(writeCases(cases));
  assert.equal(parsed.error, null);
  assert.deepEqual(parsed.cases, cases);
  assert.equal(oracleExit(cases[0]), null);
  assert.equal(oracleExit(cases[1]), 0);
  assert.equal(oracleExit(cases[2]), 2);
  assert.deepEqual(withOracleExit(cases[2], 3), {
    ...cases[2],
    expectedExitCodes: [3],
  });
  assert.deepEqual(withOracleExit(cases[2], null), { id: "legacy" });
});
test("invalid raw JSON and unknown fields are rejected without repairing the user's text", () => {
  for (const raw of [
    "{",
    "null",
    "[null]",
    '[{"id":"a","typo":1}]',
    '[{"id":"a"},{"id":"a"}]',
    '[{"id":"../bad"}]',
    '[{"id":"a","expectedExitCode":0.5}]',
    '[{"id":"a","expectedExitCodes":[0,1]}]',
  ]) {
    assert.ok(parseCases(raw).error, raw);
    assert.equal(parseCases(raw).cases, null);
  }
  assert.deepEqual(parseCases("[]"), {
    cases: [],
    error: "Добавьте хотя бы один тест",
  });
});
test("input and argv budgets count actual UTF-8 bytes and retain empty arguments", () => {
  assert.equal(parseCases(writeCases([{ id: "a", argv: [""] }])).error, null);
  assert.ok(parseCases(writeCases([{ id: "a", argv: ["\0"] }])).error);
  assert.equal(
    parseCases(writeCases([{ id: "a", argv: ["я".repeat(4096)] }])).error,
    null,
  );
  assert.ok(
    parseCases(writeCases([{ id: "a", argv: ["я".repeat(4097)] }])).error,
  );
  assert.ok(
    parseCases(writeCases([{ id: "a", argv: Array(9).fill("x".repeat(8192)) }]))
      .error,
  );
  assert.ok(
    parseCases(writeCases([{ id: "a", stdinUtf8: "я".repeat(524289) }])).error,
  );
  assert.ok(
    parseCases(writeCases([{ id: "a", stdinUtf8: "я".repeat(524289) }])).cases,
  );
  assert.ok(parseCases('[{"id":"a","stdinUtf8":"\\ud800"}]').error);
});
test("case count and string arrays match the supported runner contract", () => {
  assert.equal(
    parseCases(
      writeCases(Array.from({ length: 100 }, (_, i) => ({ id: "t" + i }))),
    ).error,
    null,
  );
  assert.ok(
    parseCases(
      writeCases(Array.from({ length: 101 }, (_, i) => ({ id: "t" + i }))),
    ).error,
  );
  assert.ok(parseCases(writeCases([{ id: "a", argv: [1] }])).error);
  assert.ok(
    parseCases(writeCases([{ id: "a", argv: Array(101).fill("") }])).error,
  );
});

test("opaque metadata cannot silently round large integers or turn overflow into null", () => {
  for (const raw of [
    '[{"id":"a","tags":{"number":9007199254740993}}]',
    '[{"id":"a","tags":[1e999]}]',
  ]) {
    const result = parseCases(raw);
    assert.equal(result.cases, null);
    assert.match(result.error!, /нельзя сохранить точно/);
  }
  assert.equal(
    parseCases('[{"id":"a","tags":{"number":"9007199254740993"}}]').error,
    null,
  );
});
