# FH

**Fisherman's Horizon**: a home page for [Freenet](https://freenet.org). Pin the Freenet sites you use, see them as tiles, open them from one place.

Named after the town on the bridge in Final Fantasy VIII: built from recycled parts, no army, everyone welcome.

![FH home](screenshot.png)

## What it does

- **Tiles.** Add a site by pasting its link (`http://<node>/v1/contract/web/<key>/`, from any node, with or without an in-app `#route`) or its bare contract key. Edit, remove. A tile opens the site in a new browser tab.
- **Saved on your node.** The list lives in the node, so it survives reloads inside the sandboxed Freenet container (where pages have no storage). Under `npm run dev` it falls back to `localStorage`. The footer says where it is saved.
- **Same list on every node.** Sign in with your [Viso](https://github.com/scobru/viso) persona, or create an identity in FH (a key you back up and paste on another node). FH then keeps the list in a Freenet contract and, on each node, takes whichever list is newest. The list is **public**: anyone who knows your identity can read it.
- **Copy your list.** Export the JSON, or import one.

## How it works

- UI: TypeScript + Vite, no framework. One page, `src/main.ts`.
- List contract (`contract/`, Rust to WASM): one instance per identity. Parameters = persona public key (32 bytes) || app path (`/v1/contract/web/<FH id>/`). State is JSON `{ list, ts, sig, cert }`: the list string as signed, signed with `fhl1|<params_hex>|<ts>|<list>` by an app key, and `cert`, the persona's delegation of that key for this app path ([whoiam-delegation](https://github.com/scobru/freenames), as in FreePolls). Each node has its own app key; the newest signed list wins (ties broken by signature, so every merge order converges). Max 64 KB.
- Identity: as in FreePolls. *Sign in with Viso* asks Viso to sign `wd1.<app key>.<nonce>` for FH's address. *Create an identity here* makes an ed25519 key on the node and signs the same proof itself.
- Storage: FreePolls' identity delegate (`src/identity.wasm`, the same build as [`scobru/freepolls`](https://github.com/scobru/freepolls) `delegate/`). It keeps a small key/value store per calling web app, namespaced by the app's contract id as attested by the node, so other apps cannot read FH's list. FH only uses `get` / `put` of the key `sites`, never the signing key.
- Why not tabs inside FH: the node serves every app shell with `X-Frame-Options: DENY` (freenet-core `server/client_api.rs`), on purpose: the shell holds the app's identity token, so framing it would allow clickjacking. Framing the app's inner `?__sandbox=1` page instead would make FH proxy its socket under FH's own token, so every site would run as FH. A new tab escapes FH's sandbox and the node wraps the site in its own shell.

## Limitations

- No in-app tabs (see above). That needs a change in freenet-core, for example a shell that a trusted launcher may frame.
- Without sign-in, the list belongs to the node: a different node starts empty.
- The synced list is public, not encrypted.
- A Viso delegation does not expire and cannot be revoked yet: whoever controls a node you signed in from can rewrite your list.
- No unread badges or previews yet: FH does not read the sites' contracts.

## Roadmap

1. Encrypt the synced list.
2. Site names through [FreeNames](https://github.com/scobru/freenames) instead of keys.
3. A public directory of Freenet apps to add with one click (like FreePolls' registry).
4. Live tiles: a small `postMessage` protocol (`{ type: "summary", unread: 3 }`) so sites can show badges in FH.

## Development

```bash
# list contract: test, build, copy the wasm into the UI (needs the wasm32-unknown-unknown target)
cargo test
cargo build --release --target wasm32-unknown-unknown -p fh-list
cp target/wasm32-unknown-unknown/release/fh_list.wasm src/contract.wasm

npm install
npm test           # link and list parsing, Viso proof
echo VITE_NODE=127.0.0.1:7509 > .env.local   # optional: the node to use under npm run dev
npm run dev        # http://localhost:5173
```

## Publishing

```bash
npm run build
fdev website init fh              # once: creates the signing key. Back it up!
fdev website publish dist --key fh
# later releases:
fdev website update dist --key fh
```

`publish` prints the site URL, `http://127.0.0.1:7509/v1/contract/web/<key>/`.

## License

MIT, see [LICENSE](LICENSE).
