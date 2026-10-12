// The list on every node: an identity (a Viso persona, or a key made here) owns one list contract
// (contract/src/lib.rs). As in FreePolls, the persona delegates a per-node app key with one "sign in" proof
// (whoiam-delegation, in the freenames repo); the app key signs each list. The list is public, not encrypted.
import * as ed from "@noble/ed25519";
import wasmUrl from "./contract.wasm?url";
import { contract, getJson, putJson, storeGet, storePut, updateJson } from "./store";
import { connectMessage, verifyProof } from "./whoiam";
export { fromBase58, personaName } from "./whoiam";

const { bytesToHex: hex, hexToBytes: unhex } = ed.etc;
const enc = new TextEncoder();

export interface Cert { base: string; challenge: string; ts: number; sig: string } // a whoiam delegation
interface ListState { list: string; ts: number; sig: string; cert: Cert | null }
export interface Session { persona: string; cert: Cert; sign: (msg: string) => Promise<string> }

/** The app's own path: delegations and the list's parameters are bound to it (in dev, "/"). */
export const APP_PATH = location.pathname;
export const linkBase = () => `${location.protocol}//${location.host}${APP_PATH}`; // Viso binds its proof to it
const LINK_MAX_AGE_MS = 10 * 60 * 1000;

const appSecret = async () => {
  let h = await storeGet("app-sk");
  if (!h) await storePut("app-sk", (h = hex(ed.utils.randomPrivateKey())));
  return h;
};

/** The signed-in identity, if its delegation still holds for this node's app key. */
export async function session(): Promise<Session | null> {
  const raw = await storeGet("session");
  if (!raw) return null;
  const { persona, cert } = JSON.parse(raw) as { persona: string; cert: Cert };
  const sk = unhex(await appSecret());
  if (cert.challenge.split(".")[1] !== hex(await ed.getPublicKeyAsync(sk))) return null; // app key changed: sign in again
  return { persona, cert, sign: async (m) => hex(await ed.signAsync(enc.encode(m), sk)) };
}

/** Forget the sign-in, and the identity key if it was made here (the user was told to save it first). */
export const signOut = async () => { await storePut("session", ""); await storePut("persona-key", ""); };

/** The official Viso web contract; any other Viso site on this node can be used instead. */
export const VISO_KEY = "GzHy3jnEtj26EoGqMsBpoawcY378hK9kp91rTcNYiAac";
export const officialViso = () => `${location.protocol}//${location.host}/v1/contract/web/${VISO_KEY}/`;

/** Where to send the user to sign in. Remembers the one-time challenge in the store. */
export async function startSignIn(visoUrl: string): Promise<string> {
  const u = new URL(visoUrl);
  if (u.host !== location.host || !/^\/v[12]\/contract\/web\/[^/]+\/?$/.test(u.pathname)) {
    throw new Error("Paste the address of your Viso site on this node (it starts with the same host as this page).");
  }
  const appKey = hex(await ed.getPublicKeyAsync(unhex(await appSecret())));
  const challenge = `wd1.${appKey}.${hex(crypto.getRandomValues(new Uint8Array(16)))}`;
  await storePut("signin-pending", challenge);
  return `${u.origin}${u.pathname}?connect=v1&challenge=${challenge}&return=${encodeURIComponent(linkBase())}`;
}

/** Handle Viso's callback: check challenge, freshness and signature, then keep the delegation. */
export async function finishSignIn(q: URLSearchParams): Promise<string> {
  if (q.get("viso") === "denied" || q.get("whoiam") === "denied") throw new Error("You chose not to share a persona.");
  const pending = await storeGet("signin-pending");
  await storePut("signin-pending", ""); // one use: burn it whatever happens next
  const persona = q.get("pk") ?? "";
  const cert: Cert = { base: linkBase(), challenge: q.get("challenge") ?? "", ts: Number(q.get("ts")), sig: q.get("sig") ?? "" };
  if (!pending || cert.challenge !== pending) throw new Error("This sign-in is unknown or was already used. Start again.");
  if (!Number.isFinite(cert.ts) || Math.abs(Date.now() - cert.ts) > LINK_MAX_AGE_MS) throw new Error("The proof is too old or its clock is off. Start again.");
  if (!(await verifyProof({ ...cert, pk: persona }))) throw new Error("Viso signature does not verify.");
  await storePut("session", JSON.stringify({ persona, cert }));
  return persona;
}

/** An identity made here instead of in Viso: a new key (or an imported one, hex) signs the same proof Viso would. */
export async function createLocalIdentity(secretHex?: string): Promise<string> {
  const sk = secretHex?.replace(/\s/g, "").toLowerCase() || hex(ed.utils.randomPrivateKey());
  if (!/^[0-9a-f]{64}$/.test(sk)) throw new Error("The key must be 64 hexadecimal characters.");
  const persona = hex(await ed.getPublicKeyAsync(sk));
  const appKey = hex(await ed.getPublicKeyAsync(unhex(await appSecret())));
  const cert: Cert = { base: linkBase(), challenge: `wd1.${appKey}.${hex(crypto.getRandomValues(new Uint8Array(16)))}`, ts: Date.now(), sig: "" };
  cert.sig = hex(await ed.signAsync(connectMessage(unhex(persona), cert.base, cert.challenge, cert.ts), sk));
  await storePut("persona-key", sk);
  await storePut("session", JSON.stringify({ persona, cert }));
  return persona;
}

/** The secret key of an identity made here (hex), for the user to back up; null for a Viso persona. */
export const localIdentityKey = async () => (await storeGet("persona-key")) || null;

/** The signed-in identity, re-signing the delegation of a key made here if this node's app key changed. */
export async function currentSession(): Promise<Session | null> {
  const s = await session();
  const key = await localIdentityKey();
  if (!s && key) { await createLocalIdentity(key); return session(); }
  return s;
}

// ---- the list contract: parameters = persona || app path ----
const listContract = (persona: string) => contract(wasmUrl, new Uint8Array([...unhex(persona), ...enc.encode(APP_PATH)]));
const paramsHex = (me: Session) => me.persona + hex(enc.encode(APP_PATH));
const remoteKnown = new Set<string>(); // personas whose list contract this page has seen on the network

/** A persona's published list (JSON) and its time, or null if there is none yet. Anyone can read it. */
export async function pull(persona: string): Promise<{ list: string; ts: number } | null> {
  const s = await getJson<ListState>(await listContract(persona));
  if (!s) return null;
  remoteKnown.add(persona);
  return s.ts ? { list: s.list, ts: s.ts } : null;
}

/** Sign and publish the list. The contract keeps whichever signed list is newest. */
export async function push(me: Session, list: string, ts: number) {
  const state: ListState = { list, ts, sig: await me.sign(`fhl1|${paramsHex(me)}|${ts}|${list}`), cert: me.cert };
  const c = await listContract(me.persona);
  if (remoteKnown.has(me.persona)) await updateJson(c, state);
  else { await putJson(c, state); remoteKnown.add(me.persona); }
}
