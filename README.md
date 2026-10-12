# FH

**Fisherman's Horizon**: a home page for [Freenet](https://freenet.org). Pin the Freenet sites you use, see them as tiles, open them from one place.

Named after the town on the bridge in Final Fantasy VIII: built from recycled parts, no army, everyone welcome.

![FH home](screenshot.png)

## What it does

- **Tiles.** Add a site by pasting its link (`http://<node>/v1/contract/web/<key>/`, from any node, with or without an in-app `#route`) or its bare contract key. Edit, remove. A tile opens the site in a new browser tab.
- **Saved on your node.** The list lives in the node, so it survives reloads inside the sandboxed Freenet container (where pages have no storage). Under `npm run dev` it falls back to `localStorage`. The footer says where it is saved.
- **Move your list.** Copy the JSON to another node and import it there.

## How it works

- UI: TypeScript + Vite, no framework. One page, `src/main.ts`.
- Storage: FreePolls' identity delegate (`src/identity.wasm`, the same build as [`scobru/freepolls`](https://github.com/scobru/freepolls) `delegate/`). It keeps a small key/value store per calling web app, namespaced by the app's contract id as attested by the node, so other apps cannot read FH's list. FH only uses `get` / `put` of the key `sites`, never the signing key.
- Why not tabs inside FH: the node serves every app shell with `X-Frame-Options: DENY` (freenet-core `server/client_api.rs`), on purpose: the shell holds the app's identity token, so framing it would allow clickjacking. Framing the app's inner `?__sandbox=1` page instead would make FH proxy its socket under FH's own token, so every site would run as FH. A new tab escapes FH's sandbox and the node wraps the site in its own shell.

## Limitations

- No in-app tabs (see above). That needs a change in freenet-core, for example a shell that a trusted launcher may frame.
- The list belongs to the node, not to you: a different node starts empty (use *Move your list*). Freenet does not sync delegates across devices yet.
- No unread badges or previews yet: FH does not read the sites' contracts.

## Roadmap

1. List synced across nodes in a contract signed by your [Viso](https://github.com/scobru/viso) identity.
2. Site names through [FreeNames](https://github.com/scobru/freenames) instead of keys.
3. A public directory of Freenet apps to add with one click (like FreePolls' registry).
4. Live tiles: a small `postMessage` protocol (`{ type: "summary", unread: 3 }`) so sites can show badges in FH.

## Development

```bash
npm install
npm test           # link and list parsing
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
