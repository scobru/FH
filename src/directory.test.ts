import { test } from "node:test";
import assert from "node:assert/strict";
import {
  adminsMsg, cleanText, dirDescriptions, entryMsg, isDirAdmin, legacyMigrationPlan, legacyRows, mine, resolveDesc, rows, workOf,
  type DirState, type LegacyDirState,
} from "./directory.ts";

const e = (name: string, ts: number, desc = "", by = "p1") => ({ by, name, desc, ts, nonce: 0, sig: "", cert: { base: "", challenge: "", ts: 0, sig: "" } });

test("rows: newest first, blocked and deleted sites hidden", () => {
  const s: DirState = {
    entries: { siteA: e("First", 2), siteB: e("B", 9), siteC: e("C", 1) },
    blocked: { ts: 1, list: ["siteC"], sig: "" },
  };
  assert.deepEqual(rows(s).map((r) => [r.site, r.name]), [["siteB", "B"], ["siteA", "First"]]);
});

test("entry and admins messages and work match the contract's format", async () => {
  assert.equal(entryMsg("S", "P", { name: "N", desc: "D", ts: 3 }), "fhd1|S|P|N|D|3");
  assert.equal(entryMsg("S", "P", { name: "", desc: "", ts: 4, deleted: true }), "fhd1|S|P|[deleted]|4");
  assert.equal(adminsMsg({ ts: 5, list: ["aa", "bb"] }), "fha1|5|aa,bb");
  assert.equal(cleanText(" a|b\nc ", 60), "a b c");
  const n = await mine("x", 8);
  assert.ok(workOf("x", n) >= 8);
});

test("isDirAdmin recognizes root admin and delegated admins case-insensitively", () => {
  const root = "464b576da4cc5bcf31febd41a863ac251d04024c19f1786b24ca6620a0cce53b";
  const del = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const state: Pick<DirState, "admins"> = { admins: { ts: 1, list: [del], sig: "" } };
  assert.equal(isDirAdmin(null, root, state), false);
  assert.equal(isDirAdmin(root.toUpperCase(), root, state), true);
  assert.equal(isDirAdmin(del.toUpperCase(), root, state), true);
  assert.equal(isDirAdmin("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", root, state), false);
});

test("rows ignore deleted entries", () => {
  const s: DirState = {
    entries: {
      siteA: { ...e("A", 1), deleted: true },
      siteB: e("B", 2),
    },
    blocked: { ts: 0, list: [], sig: "" },
  };
  assert.deepEqual(rows(s).map((r) => r.site), ["siteB"]);
});

test("dirDescriptions indexes descriptions by site key and lowercased name", () => {
  const s: DirState = {
    entries: {
      site1: e("FreePolls", 1, "Polls on Freenet"),
      site2: e("FreeBird", 2, "Twitterish experiment"),
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

test("legacyRows and legacyMigrationPlan filter deleted, blocked, and already-migrated sites", () => {
  const k1 = "4dg9mbpxeuMbQhh6Kr2ZjeHFtijMJAK5RoMbxT6rTyMP";
  const k2 = "CDC7PTxNxfaNnJ3RJs8UrNHTScpT2NTujhvUiwirVejE";
  const k3 = "GzHy3jnEtj26EoGqMsBpoawcY378hK9kp91rTcNYiAac";
  const kBlocked = "5jQAw8QEzaWvC1ZZKnjQwgv7dtCZ9X8vHjTheCRBBygN";
  const legacy: LegacyDirState = {
    entries: {
      [k1]: { p1: { name: "First", desc: "one", ts: 10, nonce: 0, sig: "", cert: { base: "", challenge: "", ts: 0, sig: "" } } },
      [k2]: { p1: { name: "Second", desc: "two", ts: 20, nonce: 0, sig: "", cert: { base: "", challenge: "", ts: 0, sig: "" } } },
      [k3]: { p1: { name: "Deleted", desc: "", ts: 30, nonce: 0, sig: "", cert: { base: "", challenge: "", ts: 0, sig: "" }, deleted: true } },
      [kBlocked]: { p1: { name: "Spam", desc: "", ts: 40, nonce: 0, sig: "", cert: { base: "", challenge: "", ts: 0, sig: "" } } },
    },
    blocked: { ts: 1, list: [kBlocked], sig: "" },
  };
  assert.deepEqual(legacyRows(legacy).map((r) => r.site), [k2, k1]);

  const currentEmpty: DirState = { entries: {}, blocked: { ts: 0, list: [], sig: "" } };
  const rootPlan = legacyMigrationPlan(currentEmpty, legacy, true);
  assert.deepEqual(rootPlan.entries.map((r) => r.site), [k2, k1]);
  assert.deepEqual(rootPlan.blocked, [kBlocked]);

  const delegatedPlan = legacyMigrationPlan({ entries: { [k2]: e("Second", 99) }, blocked: { ts: 0, list: [], sig: "" } }, legacy, false);
  assert.deepEqual(delegatedPlan.entries.map((r) => r.site), [k1]);
  assert.deepEqual(delegatedPlan.blocked, []);
});
