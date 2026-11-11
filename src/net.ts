// Network side of the FreeNames lookup (rules in names.ts) and of the app directory (rules in directory.ts).
import { hexToBytes } from "@noble/hashes/utils.js";
import zoneWasm from "./fn-zone.wasm?url";
import registryWasm from "./fn-registry.wasm?url";
import * as ed from "@noble/ed25519";
import directoryWasm from "./directory.wasm?url";
import { contract, getJson, putJson, updateJson } from "./store";
import { APP_PATH, type Cert, type Session } from "./sync";
import { EMPTY_DIR, blockMsg, cleanText, entryMsg, mine, type DirState } from "./directory";
import { FREENAMES_PATH, REGISTRY_ADMIN, isKey, parseName, resolveOwner, type RegState, type Zone } from "./names";

const enc = new TextEncoder();
const withApp = (keyHex: string) => new Uint8Array([...hexToBytes(keyHex), ...enc.encode(FREENAMES_PATH)]);

/** The contract key a FreeNames name points to, or null (unknown name, unset sub-name, or the network did not answer). */
export async function resolveName(input: string): Promise<string | null> {
  const p = parseName(input);
  if (!p) return null;
  let owner: string | null = p.first;
  if (!isKey(p.first)) {
    const reg = await getJson<RegState>(await contract(registryWasm, withApp(REGISTRY_ADMIN)));
    owner = reg && resolveOwner(reg, p.first);
  }
  if (!owner) return null;
  const zone = await getJson<Zone>(await contract(zoneWasm, withApp(owner)));
  return zone?.records[p.sub]?.target || null;
}

// ---- app directory (directory/src/lib.rs): one instance, parameters = admin key || FH's app path ----

/** The directory admin: associated with the admin Viso persona (5jQAw8QEzaWvC1ZZKnjQwgv7dtCZ9X8vHjTheCRBBygN). */
export const DIRECTORY_ADMIN = "464b576da4cc5bcf31febd41a863ac251d04024c19f1786b24ca6620a0cce53b";
const directory = () => contract(directoryWasm, new Uint8Array([...hexToBytes(DIRECTORY_ADMIN), ...enc.encode(APP_PATH)]));

/** Load the directory. The first visitor on a node creates it (empty). */
export async function loadDirectory(): Promise<DirState> {
  const c = await directory();
  const s = await getJson<DirState>(c);
  if (s) return s;
  await putJson(c, EMPTY_DIR);
  return (await getJson<DirState>(c)) ?? EMPTY_DIR;
}

/** List a site under your identity: sign the entry and mine the proof of work (a few seconds). */
export async function listSite(me: Session, site: string, name: string, desc: string) {
  const e = { name: cleanText(name, 60), desc: cleanText(desc, 200), ts: Date.now() };
  if (!e.name) throw new Error("A name is needed.");
  const msg = entryMsg(site, me.persona, e);
  const entry = { ...e, sig: await me.sign(msg), nonce: await mine(msg), cert: me.cert };
  await loadDirectory(); // also makes sure it exists
  await updateJson(await directory(), { entries: { [site]: { [me.persona]: entry } } });
}

/** Remove your listing of a site: sign a deletion entry and mine the proof of work. */
export async function removeSite(me: Session, site: string) {
  const e = { name: "", desc: "", ts: Date.now(), deleted: true };
  const msg = entryMsg(site, me.persona, e);
  const entry = { ...e, sig: await me.sign(msg), nonce: await mine(msg), cert: me.cert };
  await loadDirectory();
  await updateJson(await directory(), { entries: { [site]: { [me.persona]: entry } } });
}

/** Update a listing: if the site key changed, register the new key and delete the old key atomically. */
export async function updateSite(me: Session, oldSite: string, newSite: string, name: string, desc: string) {
  if (oldSite === newSite) {
    return listSite(me, newSite, name, desc);
  }
  const ts = Date.now();
  const newE = { name: cleanText(name, 60), desc: cleanText(desc, 200), ts };
  if (!newE.name) throw new Error("A name is needed.");
  const newMsg = entryMsg(newSite, me.persona, newE);
  const newEntry = { ...newE, sig: await me.sign(newMsg), nonce: await mine(newMsg), cert: me.cert };

  const delE = { name: "", desc: "", ts: ts + 1, deleted: true };
  const delMsg = entryMsg(oldSite, me.persona, delE);
  const delEntry = { ...delE, sig: await me.sign(delMsg), nonce: await mine(delMsg), cert: me.cert };

  await loadDirectory();
  await updateJson(await directory(), {
    entries: {
      [newSite]: { [me.persona]: newEntry },
      [oldSite]: { [me.persona]: delEntry },
    },
  });
}

/** Admin only: replace the blocklist (site keys hidden from the directory). Supports Viso session or admin secret hex. */
export async function blockSites(admin: Session | string, list: string[]) {
  const ts = Date.now();
  const msg = blockMsg({ ts, list });
  let sig: string;
  let cert: Cert | undefined;
  if (typeof admin === "string") {
    sig = ed.etc.bytesToHex(await ed.signAsync(enc.encode(msg), hexToBytes(admin)));
  } else {
    sig = await admin.sign(msg);
    cert = admin.cert;
  }
  await loadDirectory();
  await updateJson(await directory(), { blocked: { ts, list, sig, ...(cert ? { cert } : {}) } });
}
