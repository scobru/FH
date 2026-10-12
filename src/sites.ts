// A saved site: a Freenet web app, addressed by its contract key, plus an optional in-app route and group.
export interface Site { name: string; key: string; hash: string; group: string }

const KEY = /^[1-9A-HJ-NP-Za-km-z]{32,64}$/; // base58 contract key

/** Accept a bare contract key or any link to `/v1/contract/web/<key>/[#route]`, from any node. */
export function parseLink(input: string): { key: string; hash: string } | null {
  const m = input.trim().match(/^(?:https?:\/\/[^/]+)?(?:\/v1\/contract\/web\/)?([1-9A-HJ-NP-Za-km-z]{32,64})\/?(?:\?[^#]*)?(#.*)?$/);
  if (!m) return null;
  const hash = m[2] && m[2] !== "#" && m[2] !== "#/" ? m[2] : "";
  return { key: m[1], hash };
}

/** Sites from untrusted JSON (storage or an import): keep only well-formed entries, first copy of each key. */
export function parseSites(json: string | null): Site[] {
  let raw: unknown;
  try { raw = JSON.parse(json ?? "[]"); } catch { return []; }
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  return raw.flatMap((s) => {
    if (!s || typeof s.key !== "string" || !KEY.test(s.key) || seen.has(s.key)) return [];
    seen.add(s.key);
    const hash = typeof s.hash === "string" && s.hash.startsWith("#") ? s.hash.slice(0, 500) : "";
    const group = typeof s.group === "string" ? s.group.trim().slice(0, 40) : "";
    return [{ name: (typeof s.name === "string" && s.name.trim().slice(0, 60)) || s.key.slice(0, 8), key: s.key, hash, group }];
  });
}

/** Stable hue for a site's tile, from its key. */
export const hue = (key: string) => [...key].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);

/** Move the site `key` just before `before` (or to the end), taking that neighbour's group. */
export function moveSite(sites: Site[], key: string, before: string | null): Site[] {
  const s = sites.find((x) => x.key === key);
  if (!s || key === before) return sites;
  const rest = sites.filter((x) => x !== s), i = before ? rest.findIndex((x) => x.key === before) : -1;
  const at = i < 0 ? rest.length : i;
  const group = i < 0 ? s.group : rest[i].group;
  return [...rest.slice(0, at), { ...s, group }, ...rest.slice(at)];
}
