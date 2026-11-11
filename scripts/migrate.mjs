import fs from "fs";
import { blake3 } from "@noble/hashes/blake3.js";
import {
  FreenetWsApi,
  ContractKey,
  ContractContainer,
  ContractType,
  WasmContractV1,
  GetRequest,
  PutRequest,
  UpdateRequest,
  UpdateData,
  UpdateDataType,
  DeltaUpdate
} from "@freenetorg/freenet-stdlib";
import { ContractCodeT } from "@freenetorg/freenet-stdlib/common";
import { RelatedContractsT } from "@freenetorg/freenet-stdlib/client-request";

const oldState = JSON.parse(fs.readFileSync("old_dir_state.json", "utf8"));
console.log("Migrating", Object.keys(oldState.entries).length, "sites...");

const newCode = fs.readFileSync("src/directory.wasm");
const newCodeHash = blake3(newCode);
const newAdminHex = "464b576da4cc5bcf31febd41a863ac251d04024c19f1786b24ca6620a0cce53b";
const newAdminBytes = Buffer.from(newAdminHex, "hex");

const appPath = "/v1/contract/web/GyMDcXWozt4JNAz7mwPSpt9hjNyvijQRe4JhXzPAXPWm/";
const newParams = Buffer.concat([newAdminBytes, Buffer.from(appPath, "utf8")]);
const newInstanceKeyBytes = blake3(Buffer.concat([newCodeHash, newParams]));
const newKey = new ContractKey(Array.from(newInstanceKeyBytes), Array.from(newCodeHash));

const enc = new TextEncoder();

const api = await new Promise((resolve) => {
  const a = new FreenetWsApi(
    new URL("ws://127.0.0.1:7509/v1/contract/command"),
    {
      onOpen: () => resolve(a),
      onClose: () => {},
      onContractPut(r) { console.log("Put success:", r); },
      onContractGet() {},
      onContractUpdate(r) { console.log("Update success:", r); },
      onContractUpdateNotification() {},
      onContractNotFound(r) { console.log("Not found:", r.key); },
      onDelegateResponse() {},
      onErr(e) { console.error("Err:", e); }
    },
    ""
  );
});

console.log("WebSocket connected!");

// Check if new contract exists
let exists = false;
try {
  const res = await Promise.race([
    api.get(new GetRequest(newKey, false)),
    new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 4000))
  ]);
  if (res && res.state) {
    exists = true;
    console.log("New contract exists, updating state...");
  }
} catch (e) {
  console.log("Contract get result:", e.message);
}

if (!exists) {
  console.log("Putting new contract with migrated entries...");
  const initial = { entries: oldState.entries, blocked: { ts: 0, list: [], sig: "" } };
  const putReq = new PutRequest(
    new ContractContainer(
      ContractType.WasmContractV1,
      new WasmContractV1(
        new ContractCodeT(Array.from(newCode), Array.from(newCodeHash)),
        Array.from(newParams),
        newKey
      )
    ),
    Array.from(enc.encode(JSON.stringify(initial))),
    new RelatedContractsT()
  );
  await api.put(putReq);
} else {
  console.log("Updating existing new contract with migrated entries...");
  const updateReq = new UpdateRequest(
    newKey,
    new UpdateData(
      UpdateDataType.DeltaUpdate,
      new DeltaUpdate(Array.from(enc.encode(JSON.stringify({ entries: oldState.entries }))))
    )
  );
  await api.update(updateReq);
}

await new Promise((r) => setTimeout(r, 2000));
console.log("Migration complete!");
process.exit(0);
