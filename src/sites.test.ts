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

test("parseSites drops junk and duplicates", () => {
  const sites = parseSites(JSON.stringify([
    { name: " Freefold ", key: K, hash: "#/x", group: " Social " },
    { name: "dup", key: K, hash: "" },
    { name: "bad", key: "nope" },
    { key: K.replace("4", "5"), hash: "javascript:x" },
    null,
  ]));
  assert.deepEqual(sites, [
    { name: "Freefold", key: K, hash: "#/x", group: "Social" },
    { name: K.replace("4", "5").slice(0, 8), key: K.replace("4", "5"), hash: "", group: "" },
  ]);
  assert.deepEqual(parseSites("{"), []);
  assert.deepEqual(parseSites('{"a":1}'), []);
});

test("moveSite reorders and adopts the neighbour's group", () => {
  const site = (key: string, group = "") => ({ name: key, key, hash: "", group });
  const list = [site("a"), site("b", "g"), site("c", "g")];
  assert.deepEqual(moveSite(list, "a", "c").map((s) => [s.key, s.group]), [["b", "g"], ["a", "g"], ["c", "g"]]);
  assert.deepEqual(moveSite(list, "b", null).map((s) => s.key), ["a", "c", "b"]);
  assert.equal(moveSite(list, "a", "a"), list);
});
