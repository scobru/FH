// Small per-user store, kept by the node so it survives reloads inside the sandboxed Freenet container,
// where the page has no storage. It talks to FreePolls' identity delegate (src/identity.wasm, same build):
// the delegate namespaces its store by the calling app's contract id, so FH's data is FH's alone.
// Falls back to localStorage (dev server), then to memory for the session.
import { blake3 } from "@noble/hashes/blake3.js";
import {
  FreenetWsApi, DelegateRequest, ContractKey, ContractContainer, ContractType, WasmContractV1, GetRequest, PutRequest,
  UpdateRequest, UpdateData, UpdateDataType, DeltaUpdate, type DelegateResponse, type ResponseHandler,
} from "@freenetorg/freenet-stdlib";
import { ApplicationMessageT, ContractCodeT } from "@freenetorg/freenet-stdlib/common";
import {
  ApplicationMessagesT, ClientRequestT, ClientRequestType, DelegateCodeT, DelegateContainerT, DelegateKeyT,
  DelegateRequestType, DelegateType, InboundDelegateMsgT, InboundDelegateMsgType, RegisterDelegateT, RelatedContractsT, WasmDelegateV1T,
} from "@freenetorg/freenet-stdlib/client-request";
import identityWasmUrl from "./identity.wasm?url";

const enc = new TextEncoder();

/** Origin of the node: the page's own in production, VITE_NODE (or the default port) under `npm run dev`. */
export const nodeBase = import.meta.env.DEV
  ? `http://${import.meta.env.VITE_NODE ?? "127.0.0.1:7509"}`
  : `${location.protocol}//${location.host}`;

interface Waiter { resolve(r: DelegateResponse): void; reject(e: Error): void }
const waiters: Waiter[] = [];
let apiP: Promise<FreenetWsApi> | undefined;

function api(): Promise<FreenetWsApi> {
  return (apiP ??= new Promise((resolve, reject) => {
    const h: ResponseHandler = {
      onContractPut() {}, onContractGet() {}, onContractUpdate() {}, onContractUpdateNotification() {}, onContractNotFound() {},
      onDelegateResponse: (r) => waiters.shift()?.resolve(r),
      onErr: (e) => console.error(e.cause),
      onOpen: () => resolve(a),
      onClose: () => {
        apiP = undefined;
        waiters.splice(0).forEach((w) => w.reject(new Error("socket closed"))); // their replies will never come
        reject(new Error("socket closed"));
      },
    };
    // the shell only proxies sockets to its own origin, scheme included
    const a = new FreenetWsApi(new URL(`${nodeBase.replace(/^http/, "ws")}/v1/contract/command`), h, ""); // empty token inside the shell
  }));
}

// The socket can drop right after the page opens (while the shell re-authenticates): retry a couple of times.
async function retrying<T>(f: () => Promise<T>, tries = 3): Promise<T> {
  for (let i = 1; ; i++) {
    try { return await f(); }
    catch (e) {
      if (i >= tries || !/closed/i.test(String(e))) throw e;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
}

// Delegate replies carry no request id: calls go one at a time and are matched by order.
let chain: Promise<unknown> = Promise.resolve();
function sendDelegate(req: DelegateRequest, timeoutMs = 8000): Promise<DelegateResponse> {
  const run = async () => {
    let waiter!: Waiter;
    const reply = new Promise<DelegateResponse>((resolve, reject) => {
      waiter = { resolve, reject };
      waiters.push(waiter);
      setTimeout(() => {
        const i = waiters.indexOf(waiter);
        if (i >= 0) { waiters.splice(i, 1); reject(new Error("delegate timeout")); }
      }, timeoutMs);
    });
    reply.catch(() => {}); // a failed send below rejects it too: not an unhandled rejection
    // the SDK has no delegate method yet: use its low-level sender
    ((await api()) as unknown as { sendRequest(r: ClientRequestT): void }).sendRequest(new ClientRequestT(ClientRequestType.DelegateRequest, req));
    return reply;
  };
  const p = chain.then(run);
  chain = p.catch(() => {});
  return p;
}

/** Register the delegate (idempotent) and return its key: blake3(blake3(wasm)) for empty parameters. */
async function register(): Promise<DelegateKeyT> {
  const code = new Uint8Array(await (await fetch(identityWasmUrl)).arrayBuffer());
  const codeHash = blake3(code);
  const key = new DelegateKeyT(Array.from(blake3(codeHash)), Array.from(codeHash));
  const wasm = new WasmDelegateV1T([], new DelegateCodeT(Array.from(code), Array.from(codeHash)), key);
  // the node ignores cipher and nonce since freenet-core #4146 but still checks their sizes
  await sendDelegate(new DelegateRequest(DelegateRequestType.RegisterDelegate,
    new RegisterDelegateT(new DelegateContainerT(DelegateType.WasmDelegateV1, wasm), new Array(32).fill(0), new Array(24).fill(0))));
  return key;
}

let keyP: Promise<DelegateKeyT | null> | undefined;
const delegate = () => (keyP ??= retrying(register).catch((e) => { console.warn("store delegate unavailable:", e); return null; }));

async function call(payload: object): Promise<Record<string, any>> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const key = await delegate();
  if (!key) throw new Error("no delegate");
  return retrying(async () => {
    const msg = new InboundDelegateMsgT(InboundDelegateMsgType.common_ApplicationMessage, new ApplicationMessageT(Array.from(enc.encode(JSON.stringify(payload))), [], false));
    const r = await sendDelegate(new DelegateRequest(DelegateRequestType.ApplicationMessages, new ApplicationMessagesT(key, [], [msg])));
    // duck-typed: bundlers can duplicate the SDK classes, which breaks instanceof
    const m = r.values.map((v) => v.inbound).find((x) => Array.isArray((x as ApplicationMessageT | null)?.payload)) as ApplicationMessageT | undefined;
    if (!m) throw new Error("empty delegate reply");
    const out = JSON.parse(new TextDecoder().decode(new Uint8Array(m.payload)));
    if (out.err) throw new Error(out.err);
    return out;
  });
}

const mem = new Map<string, string>();
const lsKey = (k: string) => `fh-${k}`;

/** Where the data lives, for the UI to tell the user. */
export const persistence = async (): Promise<"node" | "browser" | "session"> => {
  if (await delegate()) return "node";
  try { localStorage.setItem(lsKey("probe"), "1"); return "browser"; } catch { return "session"; }
};

export async function storeGet(key: string): Promise<string | null> {
  let local: string | null = null;
  try { local = localStorage.getItem(lsKey(key)); } catch { /* sandbox: no storage */ }
  try { return (await call({ op: "get", key })).value ?? local; } catch { /* no delegate */ }
  return local ?? mem.get(key) ?? null;
}

export async function storePut(key: string, value: string) {
  mem.set(key, value);
  try { localStorage.setItem(lsKey(key), value); } catch { /* sandbox: no storage */ }
  try { await call({ op: "put", key, value }); } catch (e) { if (await delegate()) console.warn("delegate store failed:", e); }
}

// ---- contracts ----

/** Contract code + key. Instance id = blake3(blake3(wasm) || params), same as freenet-stdlib. */
export async function contract(wasmUrl: string, params: Uint8Array) {
  const code = new Uint8Array(await (await fetch(wasmUrl)).arrayBuffer());
  const codeHash = blake3(code);
  return { code, codeHash, params, key: new ContractKey(blake3(new Uint8Array([...codeHash, ...params])), codeHash) };
}
type Contract = Awaited<ReturnType<typeof contract>>;

const timeout = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms))]);

// get() responses are matched by arrival order: one at a time
let getChain: Promise<unknown> = Promise.resolve();
/** A contract's JSON state, or null if the network does not have it (or does not answer in time). */
export function getJson<T>(c: Contract): Promise<T | null> {
  const run = () => retrying(async () => {
    const r = await timeout((await api()).get(new GetRequest(c.key, false)), 30_000);
    return JSON.parse(new TextDecoder().decode(new Uint8Array(r.state))) as T;
  }).catch(() => null);
  const p = getChain.then(run);
  getChain = p.catch(() => {});
  return p;
}

/** Create the contract with this state, or merge it into the existing one. */
export const putJson = async (c: Contract, state: object) =>
  (await api()).put(new PutRequest(new ContractContainer(ContractType.WasmContractV1,
    new WasmContractV1(new ContractCodeT(Array.from(c.code), Array.from(c.codeHash)), Array.from(c.params), c.key)),
  Array.from(enc.encode(JSON.stringify(state))), new RelatedContractsT()));

export const updateJson = async (c: Contract, delta: object) =>
  (await api()).update(new UpdateRequest(c.key, new UpdateData(UpdateDataType.DeltaUpdate, new DeltaUpdate(Array.from(enc.encode(JSON.stringify(delta)))))));
