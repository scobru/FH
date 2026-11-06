import { test } from "node:test";
import assert from "node:assert/strict";
import { moveSite, parseLink, parseSites } from "./sites.ts";

const K = "4dg9mbpxeuMbQhh6Kr2ZjeHFtijMJAK5RoMbxT6rTyMP";

test("parseLink accepts keys and links from any node", () => {
  assert.deepEqual(parseLink(K), { key: K, hash: "" });
  assert.deepEqual(parseLink(` http://127.0.0.1:7509/v1/contract/web/${K}/ `), { key: K, hash: "" });
  assert.deepEqual(parseLink(`http://localhost:7510/v1/contract/web/${K}/?__sandbox=1#/f/abc`), { key: K, hash: "#/f/abc" });
  assert.deepEqual(parseLink(`/v1/contract/web/${K}#/`), { key: K, hash: "" });
  assert.equal(parseLink("https://example.com/"), null);
  assert.equal(parseLink(`javascript:alert(1)//${K}`), null);
  assert.equal(parseLink("0OIl" + K.slice(4)), null); // not base58
});

test("parseSites drops junk and duplicates and preserves group and desc", () => {
  const longDesc = "a".repeat(250);
  const sites = parseSites(JSON.stringify([
    { name: " Freefold ", key: K, hash: "#/x", group: " Social ", desc: " A private social network " },
    { name: "dup", key: K, hash: "" },
    { name: "bad", key: "nope" },
    { key: K.replace("4", "5"), hash: "javascript:x", desc: longDesc },
    { key: K.replace("4", "6"), desc: 123 },
    null,
  ]));
  assert.deepEqual(sites, [
    { name: "Freefold", key: K, hash: "#/x", group: "Social", desc: "A private social network" },
    { name: K.replace("4", "5").slice(0, 8), key: K.replace("4", "5"), hash: "", group: "", desc: "a".repeat(200) },
    { name: K.replace("4", "6").slice(0, 8), key: K.replace("4", "6"), hash: "", group: "", desc: "" },
  ]);
  assert.deepEqual(parseSites("{"), []);
  assert.deepEqual(parseSites('{"a":1}'), []);
});

test("moveSite reorders and adopts the neighbour's group", () => {
  const site = (key: string, group = "", desc = "") => ({ name: key, key, hash: "", group, desc });
  const list = [site("a"), site("b", "g", "note b"), site("c", "g", "note c")];
  assert.deepEqual(moveSite(list, "a", "c").map((s) => [s.key, s.group, s.desc]), [["b", "g", "note b"], ["a", "g", ""], ["c", "g", "note c"]]);
  assert.deepEqual(moveSite(list, "b", null).map((s) => s.key), ["a", "c", "b"]);
  assert.equal(moveSite(list, "a", "a"), list);
});
