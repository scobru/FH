// Network side of the FreeNames lookup (rules in names.ts) and of the app directory (rules in directory.ts).
import { hexToBytes } from "@noble/hashes/utils.js";
import zoneWasm from "./fn-zone.wasm?url";
import registryWasm from "./fn-registry.wasm?url";
import * as ed from "@noble/ed25519";
import directoryWasm from "./directory.wasm?url";
import legacyDirectoryWasm from "./directory-legacy.wasm?url";
import { contract, getJson, putJson, updateJson } from "./store";
import { APP_PATH, type Cert, type Session } from "./sync";
import {
  EMPTY_DIR, adminsMsg, blockMsg, cleanText, entryMsg, legacyMigrationPlan, mine,
  type DirEntry, type DirState, type LegacyDirState,
} from "./directory";
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
const legacyDirectory = () => contract(legacyDirectoryWasm, new Uint8Array([...hexToBytes(DIRECTORY_ADMIN), ...enc.encode(APP_PATH)]));

/** Read the previous (open-submission) directory contract state, or null if absent/unreachable. */
export async function loadLegacyDirectory(): Promise<LegacyDirState | null> {
  try {
    return await getJson<LegacyDirState>(await legacyDirectory());
  } catch {
    return null;
  }
}

/**
 * Migrate active sites (and blocklist when signed in as root admin and current blocklist is empty)
 * from the previous directory contract into the new admin-only directory in a single batch update.
 */
export async function migrateLegacyDirectory(me: Session, current: DirState, legacy?: LegacyDirState | null): Promise<number> {
  const src = legacy ?? (await loadLegacyDirectory());
  const isRoot = me.persona.toLowerCase() === DIRECTORY_ADMIN.toLowerCase();
  const { entries: planEntries, blocked: planBlocked } = legacyMigrationPlan(current, src, isRoot);
  if (!planEntries.length && !planBlocked.length) return 0;

  const baseTs = Date.now();
  const entries: Record<string, DirEntry> = {};
  for (let i = 0; i < planEntries.length; i++) {
    const r = planEntries[i];
    const e = { name: cleanText(r.name, 60), desc: cleanText(r.desc, 200), ts: baseTs - i };
    const msg = entryMsg(r.site, me.persona, e);
    entries[r.site] = { by: me.persona, ...e, sig: await me.sign(msg), nonce: await mine(msg), cert: me.cert };
  }

  const update: Partial<DirState> = {};
  if (Object.keys(entries).length) update.entries = entries;
  if (planBlocked.length) {
    const { sig, cert } = await signRootAction(me, blockMsg({ ts: baseTs, list: planBlocked }));
    update.blocked = { ts: baseTs, list: planBlocked, sig, ...(cert ? { cert } : {}) };
  }

  await loadDirectory();
  await updateJson(await directory(), update);
  return planEntries.length;
}

/** Load the directory. The first visitor on a node creates it (empty). */
export async function loadDirectory(): Promise<DirState> {
  const c = await directory();
  const s = await getJson<DirState>(c);
  if (s) return s;
  await putJson(c, EMPTY_DIR);
  return (await getJson<DirState>(c)) ?? EMPTY_DIR;
}

/** Admin only: list a site in the directory. */
export async function listSite(me: Session, site: string, name: string, desc: string) {
  const e = { name: cleanText(name, 60), desc: cleanText(desc, 200), ts: Date.now() };
  if (!e.name) throw new Error("A name is needed.");
  const msg = entryMsg(site, me.persona, e);
  const entry = { by: me.persona, ...e, sig: await me.sign(msg), nonce: await mine(msg), cert: me.cert };
  await loadDirectory(); // also makes sure it exists
  await updateJson(await directory(), { entries: { [site]: entry } });
}

/** Admin only: remove a listing from the directory. */
export async function removeSite(me: Session, site: string) {
  const e = { name: "", desc: "", ts: Date.now(), deleted: true };
  const msg = entryMsg(site, me.persona, e);
  const entry = { by: me.persona, ...e, sig: await me.sign(msg), nonce: await mine(msg), cert: me.cert };
  await loadDirectory();
  await updateJson(await directory(), { entries: { [site]: entry } });
}

/** Admin only: update a listing; if the site key changed, register the new key and delete the old key atomically. */
export async function updateSite(me: Session, oldSite: string, newSite: string, name: string, desc: string) {
  if (oldSite === newSite) {
    return listSite(me, newSite, name, desc);
  }
  const ts = Date.now();
  const newE = { name: cleanText(name, 60), desc: cleanText(desc, 200), ts };
  if (!newE.name) throw new Error("A name is needed.");
  const newMsg = entryMsg(newSite, me.persona, newE);
  const newEntry = { by: me.persona, ...newE, sig: await me.sign(newMsg), nonce: await mine(newMsg), cert: me.cert };

  const delE = { name: "", desc: "", ts: ts + 1, deleted: true };
  const delMsg = entryMsg(oldSite, me.persona, delE);
  const delEntry = { by: me.persona, ...delE, sig: await me.sign(delMsg), nonce: await mine(delMsg), cert: me.cert };

  await loadDirectory();
  await updateJson(await directory(), {
    entries: {
      [newSite]: newEntry,
      [oldSite]: delEntry,
    },
  });
}

async function signRootAction(admin: Session | string, msg: string): Promise<{ sig: string; cert?: Cert }> {
  if (typeof admin === "string") {
    return { sig: ed.etc.bytesToHex(await ed.signAsync(enc.encode(msg), hexToBytes(admin))) };
  }
  return { sig: await admin.sign(msg), cert: admin.cert };
}

/** Root admin only: replace the blocklist (site keys hidden from the directory). Supports Viso session or admin secret hex. */
export async function blockSites(admin: Session | string, list: string[]) {
  const ts = Date.now();
  const { sig, cert } = await signRootAction(admin, blockMsg({ ts, list }));
  await loadDirectory();
  await updateJson(await directory(), { blocked: { ts, list, sig, ...(cert ? { cert } : {}) } });
}

/** Root admin only: replace the delegated admins list (lowercase 64-char hex pubkeys). */
export async function setAdmins(admin: Session | string, list: string[]) {
  const ts = Date.now();
  const { sig, cert } = await signRootAction(admin, adminsMsg({ ts, list }));
  await loadDirectory();
  await updateJson(await directory(), { admins: { ts, list, sig, ...(cert ? { cert } : {}) } });
}
