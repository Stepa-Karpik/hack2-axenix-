// @ts-nocheck -- Browser persistence hints, no execution authority.
import test from "node:test";
import assert from "node:assert/strict";
import {
  readPrepared,
  writePrepared,
  clearPrepared,
  preparedKey,
} from "./preparedProposal.ts";
const first = "11111111-1111-4111-8111-111111111111",
  second = "22222222-2222-4222-8222-222222222222";
function storage() {
  const data = new Map();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
    removeItem: (key) => data.delete(key),
  };
}
test("only validated project-scoped proposal ids are persisted", () => {
  const store = storage();
  store.setItem("unrelated-source-draft", "preserve");
  assert.equal(writePrepared("a", first, store), true);
  assert.equal(readPrepared("a", store), first);
  assert.equal(readPrepared("b", store), null);
  assert.equal(writePrepared("a", "../escape", store), false);
  assert.equal(readPrepared("a", store), first);
  assert.equal(store.getItem("unrelated-source-draft"), "preserve");
});
test("stale cleanup cannot remove an already changed hint and malformed entries do not become paths", () => {
  const store = storage();
  writePrepared("a", second, store);
  assert.equal(clearPrepared("a", first, store), false);
  assert.equal(readPrepared("a", store), second);
  assert.equal(clearPrepared("a", second, store), true);
  assert.equal(readPrepared("a", store), null);
  store.setItem(preparedKey("a"), "../../other");
  store.setItem(preparedKey("b"), first);
  assert.equal(readPrepared("a", store), null);
  assert.equal(readPrepared("b", store), first);
});
test("unavailable browser storage never blocks a current-session proposal", () => {
  const denied = {
    getItem() {
      throw Error("denied");
    },
    setItem() {
      throw Error("denied");
    },
    removeItem() {
      throw Error("denied");
    },
  };
  assert.equal(readPrepared("a", denied), null);
  assert.equal(writePrepared("a", first, denied), false);
  assert.equal(clearPrepared("a", first, denied), false);
});
