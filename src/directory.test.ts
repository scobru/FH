import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanText, entryMsg, mine, rows, workOf, type DirState } from "./directory.ts";

const e = (name: string, ts: number) => ({ name, desc: "", ts, nonce: 0, sig: "", cert: { base: "", challenge: "", ts: 0, sig: "" } });

test("rows: one per site, earliest entry speaks, blocked sites hidden", () => {
  const s: DirState = {
    entries: { siteA: { p2: e("Later", 5), p1: e("First", 2) }, siteB: { p1: e("B", 9) }, siteC: { p1: e("C", 1) } },
    blocked: { ts: 1, list: ["siteC"], sig: "" },
  };
  assert.deepEqual(rows(s).map((r) => [r.site, r.name, r.count]), [["siteB", "B", 1], ["siteA", "First", 2]]);
});

test("entry message and work match the contract's format", async () => {
  assert.equal(entryMsg("S", "P", { name: "N", desc: "D", ts: 3 }), "fhd1|S|P|N|D|3");
  assert.equal(cleanText(" a|b\nc ", 60), "a b c");
  const n = await mine("x", 8);
  assert.ok(workOf("x", n) >= 8);
});
