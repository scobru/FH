// App directory rules, shared with directory/src/lib.rs (same messages, same limits). Network part: net.ts.
import { sha256 } from "@noble/hashes/sha2.js";
import type { Cert } from "./sync";

export const POW_BITS = 12; // must match the contract (sha256)
export interface DirEntry { by: string; name: string; desc: string; ts: number; nonce: number; sig: string; cert: Cert; deleted?: boolean }
export interface LegacyDirEntry { name: string; desc: string; ts: number; nonce: number; sig: string; cert: Cert; deleted?: boolean }
export interface Blocklist { ts: number; list: string[]; sig: string; cert?: Cert }
export interface Admins { ts: number; list: string[]; sig: string; cert?: Cert }
export interface DirState { entries: Record<string, DirEntry>; blocked: Blocklist; admins?: Admins } // site -> entry
export interface LegacyDirState { entries: Record<string, Record<string, LegacyDirEntry>>; blocked: Blocklist } // site -> persona -> entry
export const EMPTY_DIR: DirState = { entries: {}, blocked: { ts: 0, list: [], sig: "" }, admins: { ts: 0, list: [], sig: "" } };

const enc = new TextEncoder();
export const entryMsg = (site: string, persona: string, e: Pick<DirEntry, "name" | "desc" | "ts"> & { deleted?: boolean }) =>
  e.deleted ? `fhd1|${site}|${persona}|[deleted]|${e.ts}` : `fhd1|${site}|${persona}|${e.name}|${e.desc}|${e.ts}`;
export const blockMsg = (b: Pick<Blocklist, "ts" | "list">) => `fhb1|${b.ts}|${b.list.join(",")}`;
export const adminsMsg = (a: Pick<Admins, "ts" | "list">) => `fha1|${a.ts}|${a.list.join(",")}`;

/** Whether `persona` is the root admin or a delegated admin in `state.admins`. */
export function isDirAdmin(persona: string | null | undefined, rootAdmin: string, state?: Pick<DirState, "admins"> | null): boolean {
  if (!persona) return false;
  const p = persona.toLowerCase();
  if (p === rootAdmin.toLowerCase()) return true;
  return state?.admins?.list?.some((a) => a.toLowerCase() === p) ?? false;
}

/** Name and description the contract accepts: no control characters, no `|`. */
export const cleanText = (s: string, max: number) => [...s.replace(/[\p{Cc}|]+/gu, " ").trim()].slice(0, max).join("");

const zeroBits = (h: Uint8Array) => { let n = 0; for (const b of h) { n += Math.clz32(b) - 24; if (b) break; } return n; };
export const workOf = (msg: string, nonce: number) => zeroBits(sha256(enc.encode(`${msg}|${nonce}`)));

/** The smallest nonce with `bits` of work on `msg`. Yields to the page now and then. */
export async function mine(msg: string, bits = POW_BITS): Promise<number> {
  for (let n = 0; ; n++) {
    if (workOf(msg, n) >= bits) return n;
    if (n % 20000 === 19999) await new Promise((r) => setTimeout(r));
  }
}

export interface Row { site: string; name: string; desc: string; by: string; ts: number }

/** One row per active site, newest first. */
export function rows(s: DirState): Row[] {
  return Object.entries(s.entries).flatMap(([site, e]) => {
    if (!e || e.deleted || s.blocked.list.includes(site)) return [];
    return [{ site, name: e.name, desc: e.desc, by: e.by, ts: e.ts }];
  }).sort((a, b) => b.ts - a.ts);
}

/** Extract active rows from a legacy (pre-admin-only) directory state, newest first. */
export function legacyRows(s: LegacyDirState | null | undefined): Row[] {
  if (!s?.entries) return [];
  return Object.entries(s.entries).flatMap(([site, m]) => {
    const all = Object.entries(m).filter(([, e]) => !e.deleted).sort(([pa, a], [pb, b]) => a.ts - b.ts || (pa < pb ? -1 : 1));
    if (!all.length || s.blocked?.list?.includes(site)) return [];
    const [by, e] = all[0];
    return [{ site, name: e.name, desc: e.desc, by, ts: Math.max(...all.map(([, x]) => x.ts)) }];
  }).sort((a, b) => b.ts - a.ts);
}

/** Determine which active sites and blocklist keys from `legacy` still need to be migrated into `current`. */
export function legacyMigrationPlan(
  current: DirState,
  legacy: LegacyDirState | null | undefined,
  isRoot: boolean,
): { entries: Row[]; blocked: string[] } {
  if (!legacy) return { entries: [], blocked: [] };
  const isSiteKey = (s: string) => /^[A-Za-z0-9]{32,64}$/.test(s);
  const blocked = isRoot && current.blocked.list.length === 0
    ? (legacy.blocked?.list ?? []).filter(isSiteKey).slice(0, 10_000)
    : [];
  const entries = legacyRows(legacy)
    .filter((r) => isSiteKey(r.site) && !(r.site in current.entries) && !current.blocked.list.includes(r.site) && !blocked.includes(r.site) && !!cleanText(r.name, 60))
    .slice(0, 1000);
  return { entries, blocked };
}

export interface DirDescs {
  byKey: Record<string, string>;
  byName: Record<string, string>;
}

export const KNOWN_APP_DESCS: Record<string, string> = {
  "fishermans horizon": "Your Freenet, in one place.",
  "fisherman's horizon": "Your Freenet, in one place.",
};

/** Index descriptions from directory state by site key and normalized name. */
export function dirDescriptions(s: DirState): DirDescs {
  const byKey: Record<string, string> = {};
  const byName: Record<string, string> = {};
  for (const r of rows(s)) {
    if (r.desc) {
      if (r.site) byKey[r.site] = r.desc;
      if (r.name) byName[r.name.trim().toLowerCase()] = r.desc;
    }
  }
  return { byKey, byName };
}

/** If a site has no custom description, inherit it from the directory (by key or name) or known apps. */
export function resolveDesc(
  site: { key?: string; name?: string; desc?: string },
  descs?: DirDescs | null
): string {
  if (site.desc?.trim()) return site.desc.trim();
  if (descs) {
    if (site.key && descs.byKey[site.key]) return descs.byKey[site.key];
    const norm = site.name?.trim().toLowerCase();
    if (norm && descs.byName[norm]) return descs.byName[norm];
  }
  const norm = site.name?.trim().toLowerCase();
  if (norm && KNOWN_APP_DESCS[norm]) return KNOWN_APP_DESCS[norm];
  return "";
}
