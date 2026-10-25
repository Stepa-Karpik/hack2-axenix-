// @ts-nocheck -- Native Node test runner.
import test from "node:test";
import assert from "node:assert/strict";
import {diagnosticText} from "./diagnostics.ts";
import {isSaveShortcut} from "./shortcuts.ts";
test("bare method gets concise class advice without changing source or hiding raw diagnostic",()=>{
  const d={code:"PARSE_ERROR",message:'Parse error Encountered static. Was expecting class interface record'};
  assert.match(diagnosticText(d,'static int test(int n) {return n+1;}'),/внутри класса/);
  assert.doesNotMatch(diagnosticText(d,'class Main { void test( }'),/внутри класса/);
  assert.equal(d.message,'Parse error Encountered static. Was expecting class interface record');
});
test("Save matches physical key and logical English/Russian fallback, without AltGr",()=>{
  const e={ctrlKey:true,metaKey:false,altKey:false,code:"KeyS",key:"ы"};
  assert.equal(isSaveShortcut(e),true);
  assert.equal(isSaveShortcut({...e,code:"Unidentified"}),true);
  assert.equal(isSaveShortcut({...e,code:"",key:"S"}),true);
  assert.equal(isSaveShortcut({...e,ctrlKey:false}),false);
  assert.equal(isSaveShortcut({...e,altKey:true}),false);
});
