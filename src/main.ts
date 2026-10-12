import "./style.css";
import { nodeBase, persistence, storeGet, storePut } from "./store";
import { hue, parseLink, parseSites, type Site } from "./sites";
import {
  createLocalIdentity, currentSession, finishSignIn, localIdentityKey, officialViso, personaName, pull, push, signOut, startSignIn, type Session,
} from "./sync";

const home = document.getElementById("home")!;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const urlOf = (s: Site) => `${nodeBase}/v1/contract/web/${s.key}/${s.hash}`;

let sites: Site[] = [];
let editing: string | null = null; // key of the site in the form, null = adding
let where = "";
let me: Session | null | undefined; // undefined = still checking
let key: string | null = null; // secret of an identity made here, for backup
let syncMsg = "";

const keepLocal = async (ts: number) => { await storePut("sites", JSON.stringify(sites)); await storePut("sites-ts", String(ts)); };

async function save() {
  const ts = Date.now();
  await keepLocal(ts);
  if (me) await publish(me, ts);
}

async function publish(who: Session, ts: number) {
  try { await push(who, JSON.stringify(sites), ts); syncMsg = "Synced."; }
  catch (e) { syncMsg = `Not synced: ${(e as Error).message ?? e}`; }
  drawSync();
}

/** Newest list wins: take the published one, or publish ours. */
async function sync() {
  if (!me) return;
  syncMsg = "Syncing…"; drawSync();
  const remote = await pull(me), localTs = Number(await storeGet("sites-ts")) || 0;
  if (remote && remote.ts > localTs) {
    sites = parseSites(remote.list);
    await keepLocal(remote.ts);
    syncMsg = "Synced.";
    drawHome();
  } else if (!remote || localTs > remote.ts) await publish(me, localTs || Date.now());
  else { syncMsg = "Synced."; drawSync(); }
}

// Viso is a page of its own: inside the node's container, leaving FH goes through the shell.
const goTo = (href: string) => (window.parent !== window ? parent.postMessage({ __freenet_shell__: true, type: "navigate", href }, "*") : void (location.href = href));

function drawSync() {
  const box = home.querySelector<HTMLElement>("#sync");
  if (!box) return;
  box.innerHTML = me === undefined ? `<p class="muted">Checking your sign-in…</p>`
    : me ? `<p>Your list follows the ${key ? "identity" : "Viso persona"} <code>${esc(personaName(me.persona).slice(0, 12))}…</code> on every node.
        <span class="muted">${esc(syncMsg)}</span> <button id="so" type="button" class="link">Sign out</button></p>
        ${key ? `<p class="muted">This identity was made here: its key is the only way to get it back on another node. Keep it secret.
          <button id="kshow" type="button" class="link">Show key</button> <button id="kdl" type="button" class="link">Download key</button></p>
          <p><code id="kval" hidden>${esc(key)}</code></p>` : ""}`
    : `<p><b>Same list on every node.</b> <span class="muted">Sign in and FH keeps your list on Freenet. It is public: anyone who knows your identity can read it.</span></p>
        <div class="row wrap"><input id="vurl" value="${esc(officialViso())}" spellcheck="false" aria-label="Your Viso site" /><button id="vgo" type="button">Sign in with Viso</button></div>
        <div class="row wrap"><button id="lnew" type="button" class="ghost">Create an identity here</button>
          <input id="lkey" type="password" placeholder="…or paste your identity key" spellcheck="false" autocomplete="off" /><button id="limport" type="button" class="ghost">Use key</button></div>
        <p class="err" role="alert">${esc(syncMsg)}</p>`;
  const on = (id: string, f: () => unknown) => { const b = box.querySelector<HTMLElement>(`#${id}`); if (b) b.onclick = f; };
  const fail = (e: unknown) => { syncMsg = String((e as Error).message ?? e); drawSync(); };
  on("so", async () => {
    if (key && !confirm("Signing out deletes the identity key from this node. Without your backup it is lost. Sign out?")) return;
    await signOut(); me = null; key = null; syncMsg = ""; drawSync();
  });
  on("kshow", () => { const k = box.querySelector<HTMLElement>("#kval")!; k.hidden = !k.hidden; });
  on("kdl", () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([`FH identity key: keep it secret.\n${key}\n`], { type: "text/plain" }));
    a.download = `identity-${personaName(me!.persona).slice(0, 8)}.txt`;
    a.click();
  });
  on("vgo", async () => { try { goTo(await startSignIn(box.querySelector<HTMLInputElement>("#vurl")!.value.trim())); } catch (e) { fail(e); } });
  const local = async (k?: string) => {
    try { await createLocalIdentity(k); [me, key] = [await currentSession(), await localIdentityKey()]; await sync(); } catch (e) { fail(e); }
  };
  on("lnew", () => local());
  on("limport", () => local(box.querySelector<HTMLInputElement>("#lkey")!.value));
}

// Sites open in a new tab: the node refuses to have its app shells framed (X-Frame-Options: DENY, the shell
// holds the app's identity token), and a popup escapes FH's sandbox, so the node wraps the site in its own shell.
function drawHome() {
  const e = editing ? sites.find((s) => s.key === editing) : undefined;
  home.innerHTML = `
    <header>
      <p class="kicker">Fisherman's Horizon</p>
      <h1>Your Freenet, in one place.</h1>
      <p class="lede">Pin the sites you use and open them from one place.</p>
    </header>
    <section id="sync" class="sync"></section>
    <section class="grid">
      ${sites.map((s) => `
        <article class="tile" style="--h:${hue(s.key)}">
          <a class="face" href="${esc(urlOf(s))}" target="_blank" rel="noopener noreferrer">
            <span class="glyph">${esc([...s.name][0]?.toUpperCase() ?? "?")}</span>
            <span class="name">${esc(s.name)}</span>
            <span class="key">${s.key.slice(0, 6)}…${s.key.slice(-4)}${esc(s.hash)}</span>
          </a>
          <div class="acts">
            <button data-edit="${s.key}" title="Edit">&#9998;</button>
            <button data-del="${s.key}" title="Remove">&times;</button>
          </div>
        </article>`).join("")}
      <form class="tile add" id="add">
        <p class="label">${e ? "Edit site" : "Add a site"}</p>
        <input name="name" placeholder="Name" maxlength="60" value="${esc(e?.name ?? "")}" />
        <input name="link" placeholder="Link or contract key" required value="${e ? esc(urlOf(e)) : ""}" />
        <p class="err" id="err" role="alert"></p>
        <div class="row"><button type="submit">${e ? "Save" : "Add"}</button>${e ? `<button type="button" id="cancel">Cancel</button>` : ""}</div>
      </form>
    </section>
    <details>
      <summary>Copy your list</summary>
      <p class="muted">Export it, or paste a list here and import it (it replaces the current one).</p>
      <textarea id="json" rows="6" spellcheck="false">${esc(JSON.stringify(sites, null, 1))}</textarea>
      <button id="import" type="button">Import</button>
    </details>
    <footer>
      <span class="muted">${where}</span> &middot;
      <a href="https://github.com/scobru/FH" target="_blank" rel="noopener noreferrer">github.com/scobru/FH</a> &middot; MIT
    </footer>`;

  drawSync();
  home.querySelector<HTMLFormElement>("#add")!.onsubmit = async (ev) => {
    ev.preventDefault();
    const f = new FormData(ev.target as HTMLFormElement);
    const link = parseLink(String(f.get("link")));
    const err = home.querySelector("#err")!;
    if (!link) return void (err.textContent = "Paste a Freenet site link (…/v1/contract/web/<key>/) or its key.");
    if (link.key !== editing && sites.some((s) => s.key === link.key)) return void (err.textContent = "Already on your list.");
    const site = { name: String(f.get("name")).trim().slice(0, 60) || link.key.slice(0, 8), ...link };
    if (editing) {
      sites = sites.map((s) => (s.key === editing ? site : s));
    } else sites.push(site);
    editing = null;
    drawHome();
    await save();
  };
  home.querySelector<HTMLButtonElement>("#cancel")?.addEventListener("click", () => { editing = null; drawHome(); });
  home.querySelector<HTMLButtonElement>("#import")!.onclick = async () => {
    const next = parseSites(home.querySelector<HTMLTextAreaElement>("#json")!.value);
    if (!next.length) return;
    sites = next;
    drawHome();
    await save();
  };
}

// one delegated click handler for the tiles' buttons
document.addEventListener("click", async (ev) => {
  const b = (ev.target as HTMLElement).closest<HTMLElement>("[data-edit],[data-del]");
  if (!b) return;
  const d = b.dataset;
  if (d.edit) { editing = d.edit; drawHome(); home.querySelector<HTMLInputElement>("input[name=name]")?.focus(); }
  else if (d.del) {
    sites = sites.filter((s) => s.key !== d.del);
    drawHome();
    await save();
  }
});

home.innerHTML = `<p class="muted loading">Loading your sites…</p>`;
const q = new URLSearchParams(location.search);
if (q.has("viso") || q.has("whoiam")) { // back from Viso with its proof (or a refusal)
  try { await finishSignIn(q); } catch (e) { syncMsg = String((e as Error).message ?? e); }
  history.replaceState(null, "", location.pathname); // drop the one-time query
}
sites = parseSites(await storeGet("sites"));
where = { node: "Saved on your Freenet node", browser: "Saved in this browser", session: "Not saved: lost on reload" }[await persistence()];
drawHome();
me = await currentSession().catch(() => null);
key = me ? await localIdentityKey() : null;
drawSync();
await sync();
