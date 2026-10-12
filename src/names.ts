// FreeNames lookup (github.com/scobru/freenames): `name` or `name/sub` -> a contract key. Read-only, the same rules as
// FreeNames' own resolve (ui/src/names.ts and lib.ts there): the registry gives the name's owner (the admin's pin, else
// the strongest proof of work), the owner's zone gives the target. Both contracts are bound to FreeNames' app path,
// and their code must be the one FreeNames publishes (src/fn-*.wasm, copied from its repo). Network part: lookup.ts.
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

export const FREENAMES_KEY = "CDC7PTxNxfaNnJ3RJs8UrNHTScpT2NTujhvUiwirVejE";
export const FREENAMES_PATH = `/v1/contract/web/${FREENAMES_KEY}/`;
export const REGISTRY_ADMIN = "4498bd4c2ab992afa152bc9b968e246cf70dc4fa5a670b23c33e73b8516ce9f3"; // FreeNames' ui/src/lib.ts

export interface RegState { claims: Record<string, Record<string, { nonce: number }>>; pins: { map: Record<string, string> } }
export interface Zone { records: Record<string, { target: string }> }

const enc = new TextEncoder();
const validName = (n: string) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(n);
export const isKey = (s: string) => /^[0-9a-f]{64}$/.test(s);

/** `name`, `name/sub`, `<64 hex persona>` or `<persona>/sub`; the part after the slash defaults to the zone root `@`. */
export function parseName(input: string): { first: string; sub: string } | null {
  const [first, sub = "@", ...rest] = input.trim().toLowerCase().replace(/^fn:/, "").split("/");
  if (rest.length || !(isKey(first) || validName(first)) || !(sub === "@" || validName(sub))) return null;
  return { first, sub };
}

/** The owner of a registry name: the admin's pin if any ("" = reserved), else the claim with the lowest proof hash. */
export function resolveOwner(s: RegState, name: string): string | null {
  if (name in s.pins.map) return s.pins.map[name] || null;
  let best: { o: string; h: string } | null = null;
  for (const [o, c] of Object.entries(s.claims[name] ?? {})) {
    const h = bytesToHex(sha256(enc.encode(`fnc1|${REGISTRY_ADMIN}|${name}|${o}|${c.nonce}`)));
    if (!best || h < best.h) best = { o, h };
  }
  return best?.o ?? null;
}

