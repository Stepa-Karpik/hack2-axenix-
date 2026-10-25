// @ts-nocheck -- executed with native Node TypeScript stripping.
import test from "node:test";
import assert from "node:assert/strict";
import { methodReturnText } from "./methodResultView.ts";
test("native long result and arrays display exact tokens beyond JS integer precision", () => {
  const raw =
    '{"complete":true,"completion":"return","returnValue":9007199254740995,"exception":null,"argumentsAfter":[]}';
  assert.equal(
    methodReturnText(raw, JSON.parse(raw).returnValue),
    "9007199254740995",
  );
  const array =
    '{"returnValue":[9007199254740995,-9223372036854775808],"exception":null}';
  assert.equal(
    methodReturnText(array, JSON.parse(array).returnValue),
    "[9007199254740995,-9223372036854775808]",
  );
});
test("native result token scanner preserves escaped strings commas braces and null without evaluation", () => {
  for (const value of [
    '"a,}\\\"b"',
    "null",
    '{"nested":[1,2],"text":"x,y"}',
    "-0.0",
  ]) {
    assert.equal(
      methodReturnText('{"returnValue":' + value + ',"exception":null}', null),
      value,
    );
  }
  assert.equal(
    methodReturnText(null, 9007199254740995),
    "Точное значение доступно только в исходном канале результата",
  );
  assert.equal(methodReturnText(undefined, 7), "7");
});
