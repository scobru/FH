import { test } from "node:test";
import assert from "node:assert/strict";
import { parseName } from "./names.ts";

test("parseName takes FreeNames' forms only", () => {
  assert.deepEqual(parseName(" Scobru/FreeTunes "), { first: "scobru", sub: "freetunes" });
  assert.deepEqual(parseName("scobru"), { first: "scobru", sub: "@" });
  assert.deepEqual(parseName("fn:" + "ab".repeat(32)), { first: "ab".repeat(32), sub: "@" });
  assert.equal(parseName("a/b/c"), null);
  assert.equal(parseName("-bad"), null);
  assert.equal(parseName("http://127.0.0.1:7509/v1/contract/web/x/"), null);
});
