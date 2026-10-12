// App directory rules, shared with directory/src/lib.rs (same messages, same limits). Network part: net.ts.
import { sha256 } from "@noble/hashes/sha2.js";
import type { Cert } from "./sync";

export const POW_BITS = 18; // must match the contract (sha256, a few seconds in the browser)
export interface DirEntry { name: string; desc: string; ts: number; nonce: number; sig: string; cert: Cert }
export interface Blocklist { ts: number; list: string[]; sig: string }
export interface DirState { entries: Record<string, Record<string, DirEntry>>; blocked: Blocklist } // site -> persona -> entry
export const EMPTY_DIR: DirState = { entries: {}, blocked: { ts: 0, list: [], sig: "" } };

const enc = new TextEncoder();
export const entryMsg = (site: string, persona: string, e: Pick<DirEntry, "name" | "desc" | "ts">) =>
  `fhd1|${site}|${persona}|${e.name}|${e.desc}|${e.ts}`;
export const blockMsg = (b: Pick<Blocklist, "ts" | "list">) => `fhb1|${b.ts}|${b.list.join(",")}`;

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

export interface Row { site: string; name: string; desc: string; by: string; count: number; ts: number }

/** One row per site, newest first: the earliest current entry speaks for it, the others are counted. */
export function rows(s: DirState): Row[] {
  return Object.entries(s.entries).flatMap(([site, m]) => {
    const all = Object.entries(m).sort(([pa, a], [pb, b]) => a.ts - b.ts || (pa < pb ? -1 : 1));
    if (!all.length || s.blocked.list.includes(site)) return [];
    const [by, e] = all[0];
    return [{ site, name: e.name, desc: e.desc, by, count: all.length, ts: Math.max(...all.map(([, x]) => x.ts)) }];
  }).sort((a, b) => b.ts - a.ts);
}
