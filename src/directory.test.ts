import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanText, dirDescriptions, entryMsg, mine, resolveDesc, rows, workOf, type DirState } from "./directory.ts";

const e = (name: string, ts: number, desc = "") => ({ name, desc, ts, nonce: 0, sig: "", cert: { base: "", challenge: "", ts: 0, sig: "" } });

test("rows: one per site, earliest entry speaks, blocked sites hidden", () => {
  const s: DirState = {
    entries: { siteA: { p2: e("Later", 5), p1: e("First", 2) }, siteB: { p1: e("B", 9) }, siteC: { p1: e("C", 1) } },
    blocked: { ts: 1, list: ["siteC"], sig: "" },
  };
  assert.deepEqual(rows(s).map((r) => [r.site, r.name, r.count]), [["siteB", "B", 1], ["siteA", "First", 2]]);
});

test("entry message and work match the contract's format", async () => {
  assert.equal(entryMsg("S", "P", { name: "N", desc: "D", ts: 3 }), "fhd1|S|P|N|D|3");
  assert.equal(entryMsg("S", "P", { name: "", desc: "", ts: 4, deleted: true }), "fhd1|S|P|[deleted]|4");
  assert.equal(cleanText(" a|b\nc ", 60), "a b c");
  const n = await mine("x", 8);
  assert.ok(workOf("x", n) >= 8);
});

test("rows ignore deleted entries", () => {
  const s: DirState = {
    entries: {
      siteA: { p1: { ...e("A", 1), deleted: true } },
      siteB: { p1: e("B", 2) },
    },
    blocked: { ts: 0, list: [], sig: "" },
  };
  assert.deepEqual(rows(s).map((r) => r.site), ["siteB"]);
});

test("dirDescriptions indexes descriptions by site key and lowercased name", () => {
  const s: DirState = {
    entries: {
      site1: { p1: e("FreePolls", 1, "Polls on Freenet") },
      site2: { p1: e("FreeBird", 2, "Twitterish experiment") },
    },
    blocked: { ts: 0, list: [], sig: "" },
  };
  const descs = dirDescriptions(s);
  assert.equal(descs.byKey["site1"], "Polls on Freenet");
  assert.equal(descs.byKey["site2"], "Twitterish experiment");
  assert.equal(descs.byName["freepolls"], "Polls on Freenet");
  assert.equal(descs.byName["freebird"], "Twitterish experiment");
});

test("resolveDesc prioritizes explicit user desc, then directory by key, then by name, then known apps", () => {
  const descs = {
    byKey: { key1: "Directory desc for key1" },
    byName: { freepolls: "Directory desc for FreePolls" },
  };

  // Explicit user description wins
  assert.equal(resolveDesc({ key: "key1", name: "FreePolls", desc: "User custom desc" }, descs), "User custom desc");

  // Inherits by key when desc is empty
  assert.equal(resolveDesc({ key: "key1", name: "Other", desc: "" }, descs), "Directory desc for key1");
  assert.equal(resolveDesc({ key: "key1", name: "Other" }, descs), "Directory desc for key1");

  // Inherits by name when key is not in directory
  assert.equal(resolveDesc({ key: "keyUnknown", name: "FreePolls", desc: "" }, descs), "Directory desc for FreePolls");
  assert.equal(resolveDesc({ key: "keyUnknown", name: "  freepolls  " }, descs), "Directory desc for FreePolls");

  // Fallback to known app (e.g. Fishermans Horizon)
  assert.equal(resolveDesc({ key: "fhKey", name: "Fishermans Horizon", desc: "" }, descs), "Your Freenet, in one place.");
  assert.equal(resolveDesc({ key: "fhKey", name: "Fisherman's Horizon" }, descs), "Your Freenet, in one place.");

  // Returns empty string when no match
  assert.equal(resolveDesc({ key: "keyUnknown", name: "UnknownApp", desc: "" }, descs), "");
});
