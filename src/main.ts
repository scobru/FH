import "./style.css";
import { nodeBase, persistence, storeGet, storePut } from "./store";
import { hue, moveSite, parseLink, parseSites, type Site } from "./sites";
import {
  createLocalIdentity, currentSession, finishSignIn, fromBase58, linkBase, localIdentityKey, officialViso, personaName, pull, push,
  signOut, startSignIn, type Session,
} from "./sync";
import { parseName } from "./names";
import { blockSites, listSite, loadDirectory, resolveName } from "./net";
import { rows } from "./directory";

const app = document.getElementById("home")!;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const $ = <T extends HTMLElement>(sel: string) => app.querySelector(sel) as T;
const urlOf = (s: Pick<Site, "key" | "hash">) => `${nodeBase}/v1/contract/web/${s.key}/${s.hash}`;
const errText = (e: unknown) => String((e as Error).message ?? e);

let sites: Site[] = [];
let editing: string | null = null; // key of the site in the form, null = adding
let where = "";
let me: Session | null | undefined; // undefined = still checking
let key: string | null = null; // secret of an identity made here, for backup
let syncMsg = "";

// ---------------- saving and sync ----------------
const keepLocal = async (ts: number) => { await storePut("sites", JSON.stringify(sites)); await storePut("sites-ts", String(ts)); };

async function save() {
  const ts = Date.now();
  await keepLocal(ts);
  if (me) await publish(me, ts);
}

async function publish(who: Session, ts: number) {
  try { await push(who, JSON.stringify(sites), ts); syncMsg = "Synced."; }
  catch (e) { syncMsg = `Not synced: ${errText(e)}`; }
  drawSync();
}

/** Newest list wins: take the published one, or publish ours. */
async function sync() {
  if (!me) return;
  syncMsg = "Syncing…"; drawSync();
  const remote = await pull(me.persona), localTs = Number(await storeGet("sites-ts")) || 0;
  if (remote && remote.ts > localTs) {
    sites = parseSites(remote.list);
    await keepLocal(remote.ts);
    syncMsg = "Synced.";
    if (!location.hash || location.hash === "#/") drawHome();
  } else if (!remote || localTs > remote.ts) await publish(me, localTs || Date.now());
  else { syncMsg = "Synced."; drawSync(); }
}

/** Add the sites that are not on the list yet; returns how many were added. */
async function addSites(add: Site[]) {
  const fresh = add.filter((s) => !sites.some((x) => x.key === s.key));
  if (fresh.length) { sites = [...sites, ...fresh]; await save(); }
  return fresh.length;
}

// Viso is a page of its own: inside the node's container, leaving FH goes through the shell.
const goTo = (href: string) => (window.parent !== window ? parent.postMessage({ __freenet_shell__: true, type: "navigate", href }, "*") : void (location.href = href));

async function copy(input: HTMLInputElement) {
  try { await navigator.clipboard.writeText(input.value); } catch { input.select(); } // the sandbox may refuse: leave it selected
}

// ---------------- sign-in box ----------------
function drawSync() {
  const box = app.querySelector<HTMLElement>("#sync");
  if (!box) return;
  const share = me ? `${linkBase()}#/u/${personaName(me.persona)}` : "";
  box.innerHTML = me === undefined ? `<p class="muted">Checking your sign-in…</p>`
    : me ? `<p>Your list follows the ${key ? "identity" : "Viso persona"} <code>${esc(personaName(me.persona).slice(0, 12))}…</code> on every node.
        <span class="muted">${esc(syncMsg)}</span> <button id="so" type="button" class="link">Sign out</button></p>
        <div class="row wrap"><input id="share" readonly value="${esc(share)}" aria-label="Link to your list" /><button id="copyshare" type="button" class="ghost">Copy share link</button></div>
        ${key ? `<p class="muted">This identity was made here: its key is the only way to get it back on another node. Keep it secret.
          <button id="kshow" type="button" class="link">Show key</button> <button id="kdl" type="button" class="link">Download key</button></p>
          <p><code id="kval" hidden>${esc(key)}</code></p>` : ""}`
    : `<p><b>Same list on every node.</b> <span class="muted">Sign in and FH keeps your list on Freenet. It is public: anyone who knows your identity can read it, and you can share it.</span></p>
        <div class="row wrap"><input id="vurl" value="${esc(officialViso())}" spellcheck="false" aria-label="Your Viso site" /><button id="vgo" type="button">Sign in with Viso</button></div>
        <div class="row wrap"><button id="lnew" type="button" class="ghost">Create an identity here</button>
          <input id="lkey" type="password" placeholder="…or paste your identity key" spellcheck="false" autocomplete="off" aria-label="Identity key" /><button id="limport" type="button" class="ghost">Use key</button></div>
        <p class="err" role="alert">${esc(syncMsg)}</p>`;
  const on = (id: string, f: () => unknown) => { const b = box.querySelector<HTMLElement>(`#${id}`); if (b) b.onclick = f; };
  const fail = (e: unknown) => { syncMsg = errText(e); drawSync(); };
  on("so", async () => {
    if (key && !confirm("Signing out deletes the identity key from this node. Without your backup it is lost. Sign out?")) return;
    await signOut(); me = null; key = null; syncMsg = ""; drawSync();
  });
  on("copyshare", () => copy(box.querySelector<HTMLInputElement>("#share")!));
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

// ---------------- tiles ----------------
// Sites open in a new tab: the node refuses to have its app shells framed (X-Frame-Options: DENY, the shell
// holds the app's identity token), and a popup escapes FH's sandbox, so the node wraps the site in its own shell.
const tile = (s: Pick<Site, "name" | "key" | "hash"> & { group?: string }, extra: string) => `
  <article class="tile" style="--h:${hue(s.key)}" data-key="${s.key}" data-find="${esc(`${s.name} ${s.group ?? ""} ${s.key}`.toLowerCase())}">
    <a class="face" href="${esc(urlOf(s))}" target="_blank" rel="noopener noreferrer">
      <span class="glyph"><span class="letter">${esc([...s.name][0]?.toUpperCase() ?? "?")}</span><img alt="" loading="lazy" src="${nodeBase}/v1/contract/web/${s.key}/favicon.ico" /></span>
      <span class="name">${esc(s.name)}</span>
      <span class="key">${s.key.slice(0, 6)}…${s.key.slice(-4)}${esc(s.hash)}</span>
    </a>${extra}
  </article>`;

/** Show a site's favicon where it has one; keep the letter otherwise. */
function icons() {
  app.querySelectorAll<HTMLImageElement>(".glyph img").forEach((img) => {
    const ok = () => { if (img.naturalWidth) img.parentElement!.classList.add("iconic"); else img.remove(); };
    if (img.complete) ok(); else { img.onload = ok; img.onerror = () => img.remove(); }
  });
}

const footer = () => `<footer><span class="muted">${where}</span> &middot;
  <a href="https://github.com/scobru/FH" target="_blank" rel="noopener noreferrer">github.com/scobru/FH</a> &middot; MIT</footer>`;

// ---------------- home ----------------
function drawHome() {
  const e = editing ? sites.find((s) => s.key === editing) : undefined;
  const groups = [...new Set(sites.map((s) => s.group))];
  const acts = (s: Site) => `
    <div class="acts">
      <button data-left="${s.key}" title="Move left" aria-label="Move ${esc(s.name)} left">&larr;</button>
      <button data-right="${s.key}" title="Move right" aria-label="Move ${esc(s.name)} right">&rarr;</button>
      <button data-edit="${s.key}" title="Edit" aria-label="Edit ${esc(s.name)}">&#9998;</button>
      <button data-del="${s.key}" title="Remove" aria-label="Remove ${esc(s.name)}">&times;</button>
    </div>`;
  app.innerHTML = `
    <header>
      <p class="kicker">Fisherman's Horizon</p>
      <h1>Your Freenet, in one place.</h1>
      <p class="lede">Pin the sites you use and open them from one place. <a href="#/apps">Find apps &rarr;</a></p>
    </header>
    <section id="sync" class="sync"></section>
    ${sites.length ? `<input id="q" class="search" type="search" placeholder="Search your sites (Ctrl+K), Enter opens the first" aria-label="Search your sites" autocomplete="off" />` : ""}
    ${groups.map((g) => `
      <section class="group">
        ${g ? `<h2>${esc(g)}</h2>` : ""}
        <div class="grid">${sites.filter((s) => s.group === g).map((s) => tile(s, acts(s))).join("")}</div>
      </section>`).join("")}
    <div class="grid">
      <form class="tile add" id="add">
        <p class="label">${e ? "Edit site" : "Add a site"}</p>
        <input name="name" placeholder="Name" maxlength="60" value="${esc(e?.name ?? "")}" aria-label="Name" />
        <input name="link" placeholder="Link, key or FreeNames name" required value="${e ? esc(urlOf(e)) : ""}" aria-label="Link, contract key or FreeNames name" />
        <input name="group" placeholder="Group (optional)" maxlength="40" list="groups" value="${esc(e?.group ?? "")}" aria-label="Group" />
        <datalist id="groups">${groups.filter(Boolean).map((g) => `<option value="${esc(g)}"></option>`).join("")}</datalist>
        <p class="err" id="err" role="alert"></p>
        <div class="row"><button type="submit">${e ? "Save" : "Add"}</button>${e ? `<button type="button" id="cancel">Cancel</button>` : ""}</div>
      </form>
    </div>
    <details>
      <summary>Copy your list</summary>
      <p class="muted">Export it, or paste a list here and import it (it replaces the current one).</p>
      <textarea id="json" rows="6" spellcheck="false" aria-label="Your list as JSON">${esc(JSON.stringify(sites, null, 1))}</textarea>
      <button id="import" type="button">Import</button>
    </details>
    ${footer()}`;

  drawSync();
  icons();
  $<HTMLFormElement>("#add").onsubmit = async (ev) => {
    ev.preventDefault();
    const f = new FormData(ev.target as HTMLFormElement), raw = String(f.get("link")).trim(), err = $("#err");
    let link = parseLink(raw);
    if (!link && parseName(raw)) {
      err.textContent = "Looking up the name on FreeNames…";
      const target = await resolveName(raw).catch(() => null);
      if (!target) return void (err.textContent = `FreeNames has no site for “${raw}” (or did not answer).`);
      link = { key: target, hash: "" };
    }
    if (!link) return void (err.textContent = "Paste a Freenet site link (…/v1/contract/web/<key>/), its key, or a FreeNames name.");
    if (link.key !== editing && sites.some((s) => s.key === link.key)) return void (err.textContent = "Already on your list.");
    const name = String(f.get("name")).trim().slice(0, 60) || (parseName(raw) ? raw : link.key.slice(0, 8));
    const site: Site = { name, ...link, group: String(f.get("group")).trim().slice(0, 40) };
    sites = editing ? sites.map((s) => (s.key === editing ? site : s)) : [...sites, site];
    editing = null;
    drawHome();
    await save();
  };
  app.querySelector<HTMLButtonElement>("#cancel")?.addEventListener("click", () => { editing = null; drawHome(); });
  $<HTMLButtonElement>("#import").onclick = async () => {
    const next = parseSites($<HTMLTextAreaElement>("#json").value);
    if (!next.length) return;
    sites = next;
    drawHome();
    await save();
  };

  // search: filter as you type, Enter opens the first match, Escape clears
  const q = app.querySelector<HTMLInputElement>("#q");
  if (q) {
    const filter = () => {
      const words = q.value.toLowerCase().split(/\s+/).filter(Boolean);
      app.querySelectorAll<HTMLElement>(".group .tile").forEach((t) => (t.hidden = !words.every((w) => t.dataset.find!.includes(w))));
      app.querySelectorAll<HTMLElement>(".group").forEach((g) => (g.hidden = !g.querySelector(".tile:not([hidden])")));
    };
    q.oninput = filter;
    q.onkeydown = (ev) => {
      if (ev.key === "Enter") app.querySelector<HTMLAnchorElement>(".group .tile:not([hidden]) a.face")?.click();
      if (ev.key === "Escape") { q.value = ""; filter(); }
    };
  }

  // drag a tile onto another to put it there, in that tile's group (the arrow buttons do the same from the keyboard)
  app.querySelectorAll<HTMLElement>(".group .tile").forEach((t) => {
    t.draggable = true;
    t.ondragstart = (ev) => { ev.dataTransfer!.setData("text/plain", t.dataset.key!); t.classList.add("dragging"); };
    t.ondragend = () => t.classList.remove("dragging");
    t.ondragover = (ev) => { ev.preventDefault(); t.classList.add("over"); };
    t.ondragleave = () => t.classList.remove("over");
    t.ondrop = async (ev) => {
      ev.preventDefault();
      const from = ev.dataTransfer!.getData("text/plain");
      if (!sites.some((s) => s.key === from)) return;
      sites = moveSite(sites, from, t.dataset.key!);
      drawHome();
      await save();
    };
  });
}

// ---------------- someone's shared list: #/u/<identity> ----------------
async function drawShared(id: string) {
  app.innerHTML = `<p><a href="#/">&larr; Your sites</a></p><h1>Shared list</h1><p class="muted">Loading the list of <code>${esc(id.slice(0, 12))}…</code></p>`;
  const bytes = fromBase58(id);
  const persona = bytes?.length === 32 ? [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("") : null;
  const shared = parseSites((persona && (await pull(persona))?.list) ?? null);
  if (location.hash !== `#/u/${id}`) return; // the user moved on while it loaded
  const has = (k: string) => sites.some((s) => s.key === k);
  app.innerHTML = `
    <p><a href="#/">&larr; Your sites</a></p>
    <header><p class="kicker">Shared list</p><h1>${shared.length} sites from <code>${esc(id.slice(0, 12))}…</code></h1>
      <p class="lede">${persona ? "Open them, or add them to your own list." : "This link is not a valid identity."}</p></header>
    ${shared.length ? `<p class="row"><button id="all" type="button" class="cta">Add all to my list</button> <span id="msg" class="muted"></span></p>
      <div class="grid">${shared.map((s) => tile(s, `<div class="acts on"><button data-take="${s.key}" ${has(s.key) ? "disabled" : ""} title="Add to my list" aria-label="Add ${esc(s.name)} to my list">${has(s.key) ? "&#10003;" : "+"}</button></div>`)).join("")}</div>`
      : persona ? `<p class="muted">Nothing found: the list is empty, or no node answered.</p>` : ""}
    ${footer()}`;
  icons();
  const all = app.querySelector<HTMLButtonElement>("#all");
  if (all) all.onclick = async () => { const n = await addSites(shared); await drawShared(id); $("#msg").textContent = `${n} added.`; };
  app.querySelectorAll<HTMLButtonElement>("[data-take]").forEach((b) => (b.onclick = async () => {
    await addSites(shared.filter((s) => s.key === b.dataset.take));
    b.disabled = true; b.innerHTML = "&#10003;";
  }));
}

// ---------------- app directory: #/apps ----------------
async function drawApps() {
  app.innerHTML = `
    <p><a href="#/">&larr; Your sites</a></p>
    <header><p class="kicker">Directory</p><h1>Freenet apps</h1>
      <p class="lede">Sites people listed. Add the ones you want to your list. <span class="muted">The first visit on a node can take up to 30 s.</span></p></header>
    <input id="q" class="search" type="search" placeholder="Search the directory (Ctrl+K)" aria-label="Search the directory" autocomplete="off" />
    <div id="list" class="muted">Loading…</div>
    <h2>List a site</h2>
    <form id="list-form" class="sync">
      ${me ? `<p class="muted">Listed under your identity, with a few seconds of proof of work against spam. Public and permanent: Freenet has no delete.</p>
        <div class="row wrap"><input name="link" required placeholder="Link, key or FreeNames name" aria-label="Link, contract key or FreeNames name" /><input name="name" required maxlength="60" placeholder="Name" aria-label="Name" /></div>
        <div class="row wrap"><input name="desc" maxlength="200" placeholder="What it is, in a line" aria-label="Description" /><button type="submit">List it</button></div>
        <p class="err" id="lmsg" role="alert"></p>`
      : `<p class="muted">Sign in on <a href="#/">your home page</a> to list a site.</p>`}
    </form>
    ${footer()}`;
  const form = $<HTMLFormElement>("#list-form");
  if (me) form.onsubmit = async (ev) => {
    ev.preventDefault();
    const f = new FormData(form), raw = String(f.get("link")).trim(), msg = $("#lmsg");
    try {
      const site = parseLink(raw)?.key ?? (parseName(raw) ? await resolveName(raw) : null);
      if (!site) throw new Error("Not a Freenet site link, key or known FreeNames name.");
      msg.textContent = "Working (proof of work, a few seconds)…";
      await listSite(me!, site, String(f.get("name")), String(f.get("desc")));
      msg.textContent = "Listed. It shows up here once the directory updates.";
      form.reset();
    } catch (e) { msg.textContent = errText(e); }
  };
  try {
    const list = rows(await loadDirectory());
    if (location.hash !== "#/apps") return; // the user moved on while it loaded
    const has = (k: string) => sites.some((s) => s.key === k);
    $("#list").className = "";
    $("#list").innerHTML = list.length ? `<ul class="apps">${list.map((r) => `
      <li data-find="${esc(`${r.name} ${r.desc} ${r.site}`.toLowerCase())}" style="--h:${hue(r.site)}">
        <a href="${esc(urlOf({ key: r.site, hash: "" }))}" target="_blank" rel="noopener noreferrer"><b>${esc(r.name)}</b></a>
        <span class="muted">${esc(r.desc)}</span>
        <small class="muted">${r.count > 1 ? `listed by ${r.count}` : `by ${esc(personaName(r.by).slice(0, 8))}…`}</small>
        <button data-add="${r.site}" data-name="${esc(r.name)}" type="button" ${has(r.site) ? "disabled" : ""}>${has(r.site) ? "On your list" : "+ Add"}</button>
      </li>`).join("")}</ul>` : `<p class="muted">No apps listed yet. Be the first, below.</p>`;
    app.querySelectorAll<HTMLButtonElement>("[data-add]").forEach((b) => (b.onclick = async () => {
      await addSites([{ name: b.dataset.name!, key: b.dataset.add!, hash: "", group: "" }]);
      b.disabled = true; b.textContent = "On your list";
    }));
    $<HTMLInputElement>("#q").oninput = (ev) => {
      const words = (ev.target as HTMLInputElement).value.toLowerCase().split(/\s+/).filter(Boolean);
      app.querySelectorAll<HTMLElement>(".apps li").forEach((li) => (li.hidden = !words.every((w) => li.dataset.find!.includes(w))));
    };
  } catch (e) { $("#list").textContent = `Could not load the directory: ${errText(e)}`; }
}

// ---------------- directory admin: #/admin (not linked anywhere) ----------------
async function drawAdmin() {
  app.innerHTML = `
    <p><a href="#/apps">&larr; Directory</a></p>
    <h1>Directory admin</h1>
    <p class="muted">Admin secret (hex) and the site keys to hide, one per line. This replaces the whole blocklist.</p>
    <div class="sync">
      <input id="sk" type="password" autocomplete="off" placeholder="Admin secret" aria-label="Admin secret" />
      <textarea id="bl" rows="6" aria-label="Hidden site keys"></textarea>
      <div class="row"><button id="go" type="button">Publish blocklist</button> <span id="msg"></span></div>
    </div>
    <h2>Listed sites</h2><div id="listed" class="muted">Loading…</div>`;
  const bl = $<HTMLTextAreaElement>("#bl");
  $("#go").onclick = async () => {
    const list = bl.value.split("\n").map((l) => l.trim()).filter(Boolean);
    $("#msg").textContent = "Sending…";
    try { await blockSites($<HTMLInputElement>("#sk").value.trim(), list); $("#msg").textContent = `Done: ${list.length} hidden.`; }
    catch (e) { $("#msg").textContent = `Error: ${errText(e)}`; }
  };
  try {
    const d = await loadDirectory();
    bl.value = d.blocked.list.join("\n");
    const list = rows(d);
    $("#listed").innerHTML = list.length ? `<ul>${list.map((r) =>
      `<li>${esc(r.name)} <small class="muted"><code>${esc(r.site)}</code></small> <button class="link" type="button" data-hide="${esc(r.site)}">Hide</button></li>`).join("")}</ul>` : "Nothing listed.";
    // adds the key to the blocklist above; nothing is sent until "Publish blocklist"
    app.querySelectorAll<HTMLButtonElement>("[data-hide]").forEach((b) => (b.onclick = () => {
      if (!bl.value.split("\n").includes(b.dataset.hide!)) bl.value = [bl.value.trim(), b.dataset.hide].filter(Boolean).join("\n");
      b.disabled = true;
    }));
  } catch (e) { $("#msg").textContent = `Could not load the directory: ${errText(e)}`; }
}

// ---------------- routing ----------------
function route() {
  // inside the Freenet container, keep the address bar in sync so the URL is shareable
  if (window.parent !== window) parent.postMessage({ __freenet_shell__: true, type: "hash", hash: location.hash || "#/" }, "*");
  const h = location.hash, u = h.match(/^#\/u\/([1-9A-HJ-NP-Za-km-z]{32,50})$/);
  if (u) return void drawShared(u[1]);
  if (h === "#/apps") return void drawApps();
  if (h === "#/admin") return void drawAdmin();
  drawHome();
}

// tile buttons on the home page
document.addEventListener("click", async (ev) => {
  const b = (ev.target as HTMLElement).closest<HTMLElement>("[data-edit],[data-del],[data-left],[data-right]");
  if (!b) return;
  const d = b.dataset, moved = d.left ?? d.right, i = sites.findIndex((s) => s.key === moved);
  if (d.edit) { editing = d.edit; drawHome(); $<HTMLInputElement>("input[name=name]").focus(); return; }
  if (d.del) sites = sites.filter((s) => s.key !== d.del);
  else if (d.left && i > 0) sites = moveSite(sites, d.left, sites[i - 1].key);
  else if (d.right && i >= 0 && i < sites.length - 1) sites = moveSite(sites, sites[i + 1].key, d.right);
  else return;
  drawHome();
  if (moved) app.querySelector<HTMLElement>(`[data-${d.left ? "left" : "right"}="${moved}"]`)?.focus(); // keep the keyboard on the moved tile
  await save();
});

// Ctrl+K (or /) jumps to the search
addEventListener("keydown", (ev) => {
  const q = app.querySelector<HTMLInputElement>("#q");
  if (q && ((ev.key === "k" && (ev.ctrlKey || ev.metaKey)) || (ev.key === "/" && !(ev.target as HTMLElement).closest("input,textarea")))) {
    ev.preventDefault();
    q.focus();
  }
});

app.innerHTML = `<p class="muted loading">Loading your sites…</p>`;
const query = new URLSearchParams(location.search);
if (query.has("viso") || query.has("whoiam")) { // back from Viso with its proof (or a refusal)
  try { await finishSignIn(query); } catch (e) { syncMsg = errText(e); }
  history.replaceState(null, "", location.pathname); // drop the one-time query
}
sites = parseSites(await storeGet("sites"));
where = { node: "Saved on your Freenet node", browser: "Saved in this browser", session: "Not saved: lost on reload" }[await persistence()];
me = await currentSession().catch(() => null); // before the first draw: the directory's form depends on it
key = me ? await localIdentityKey() : null;
addEventListener("hashchange", route);
route();
await sync();
