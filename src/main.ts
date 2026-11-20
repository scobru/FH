import "./style.css";
import { nodeBase, onStateChange, persistence, stateHash, storeGet, storePut } from "./store";
import { dropSite, hue, moveSite, parseFollows, parseLink, parseSites, shareId, type Site } from "./sites";
import {
  createLocalIdentity, currentSession, finishSignIn, fromBase58, linkBase, localIdentityKey, officialViso,
  parsePersonaHex, personaName, pull, push, signOut, startSignIn, type Session,
} from "./sync";
import { parseName } from "./names";
import {
  blockSites, DIRECTORY_ADMIN, listSite, loadDirectory, loadLegacyDirectory, migrateLegacyDirectory, removeSite, resolveName, setAdmins, updateSite,
} from "./net";
import { dirDescriptions, isDirAdmin, legacyMigrationPlan, resolveDesc, rows, type DirDescs, type DirState } from "./directory";
import { startMusic, stopMusic } from "./music";

const app = document.getElementById("home")!;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const $ = <T extends HTMLElement>(sel: string) => app.querySelector(sel) as T;
const urlOf = (s: Pick<Site, "key" | "hash">) => `${nodeBase}/v1/contract/web/${s.key}/${s.hash}`;
const errText = (e: unknown) => String((e as Error).message ?? e);

let sites: Site[] = [];
let editing: string | null = null; // key of the site in the form, null = adding
let editingApp: { site: string; name: string; desc: string } | null = null; // app in directory form, null = adding
let lastDirState: DirState | null = null;
let autoMigrated = false;
let where = "";
let me: Session | null | undefined; // undefined = still checking
let key: string | null = null; // secret of an identity made here, for backup
let syncMsg = "";
let publishing = false; // the list is published (public, synced across nodes) only when the user turns this on
let signPanel = false; // sign-in form open in the top bar
let follows: string[] = []; // identities whose public lists the user follows
let watching = false; // optional: compare each site's contract state with the last one seen
let watchMsg = "";
let watch: Record<string, { h: string; new?: string }> = {}; // per site: state hash last seen, and a newer one if it changed since
let checking = false;
let viewMode: "tiles" | "minimal" = "tiles";
try {
  const saved = localStorage.getItem("fh-view");
  if (saved === "tiles" || saved === "minimal") viewMode = saved;
} catch { /* sandbox: no storage */ }
let dirDescs: DirDescs = { byKey: {}, byName: {} };
try {
  const savedDir = localStorage.getItem("fh-dir-cache");
  if (savedDir) dirDescs = JSON.parse(savedDir);
} catch { /* sandbox: no storage */ }
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "general";

// ---------------- saving and sync ----------------
const keepLocal = async (ts: number) => { await storePut("sites", JSON.stringify(sites)); await storePut("sites-ts", String(ts)); };

async function save() {
  const ts = Date.now();
  await keepLocal(ts);
  if (me && publishing) await publish(me, ts);
  void watchSites(); // new sites join the subscriptions
}

async function publish(who: Session, ts: number) {
  try { await push(who, JSON.stringify(sites), ts); syncMsg = "Synced."; }
  catch (e) { syncMsg = `Not synced: ${errText(e)}`; }
  drawSync();
}

/** Newest list wins: take the published one, or publish ours. An empty published list (retracted) never wipes ours. */
async function sync() {
  if (!me || !publishing) return;
  syncMsg = "Syncing…"; drawSync();
  const remote = await pull(me.persona), localTs = Number(await storeGet("sites-ts")) || 0;
  const retracted = !!remote && !parseSites(remote.list).length && sites.length > 0;
  if (remote && remote.ts > localTs && !retracted) {
    sites = parseSites(remote.list);
    await keepLocal(remote.ts);
    syncMsg = "Synced.";
    if (!location.hash || location.hash === "#/") drawHome();
  } else if (!remote || retracted || localTs > remote.ts) await publish(me, retracted ? Date.now() : localTs || Date.now());
  else { syncMsg = "Synced."; drawSync(); }
}

const setFollow = async (id: string, on: boolean) => {
  follows = on ? [...new Set([...follows, id])] : follows.filter((x) => x !== id);
  await storePut("follows", JSON.stringify(follows));
};

// ---- optional monitoring: has a site's contract state changed since the user last opened it? ----
// One GET per site at start-up (subscribing) captures its state hash; after that the node tells us about updates.
const saveWatch = () => storePut("watch-state", JSON.stringify(watch));
const changedKeys = () => Object.keys(watch).filter((k) => watch[k].new).sort().join();
const subscribed = new Set<string>();
const setWatchMsg = (m: string) => { watchMsg = m; const e = app.querySelector<HTMLElement>("#wmsg"); if (e) e.textContent = m; }; // no full redraw: it would steal focus

function noteHash(k: string, h: string) {
  const w = watch[k];
  if (!w) watch[k] = { h };
  else if (h !== w.h) w.new = h;
  else delete w.new;
}

const redrawIfChanged = (before: string) => {
  if (changedKeys() !== before && (!location.hash || location.hash === "#/") && !editing && !document.activeElement?.closest("input, textarea")) drawHome();
};

/** Subscribe to the sites not yet watched (all of them with `all`, to refresh their hashes). */
async function watchSites(all = false) {
  if (checking || !watching) return;
  checking = true;
  const before = changedKeys(), keys = sites.map((s) => s.key), todo = keys.filter((k) => all || !subscribed.has(k));
  try {
    for (const k of Object.keys(watch)) if (!keys.includes(k)) delete watch[k];
    for (const [i, k] of todo.entries()) {
      setWatchMsg(`Checking ${i + 1}/${todo.length}…`);
      const h = await stateHash(k, true);
      await new Promise((r) => setTimeout(r, 150)); // let the page breathe between big states
      if (!watching) return;
      if (!h) continue; // not reachable now: retried by "Check now"
      subscribed.add(k);
      noteHash(k, h);
    }
    await saveWatch();
    const n = Object.values(watch).filter((w) => w.new).length;
    watchMsg = n ? `${n} changed` : "Watching";
  } finally {
    checking = false; drawSync(); redrawIfChanged(before);
  }
}

// the node reports an update: read the new state's hash (the delta alone does not give it)
onStateChange(async (k) => {
  if (!watching || !watch[k]) return;
  const before = changedKeys(), h = await stateHash(k);
  if (!h) return;
  noteHash(k, h);
  await saveWatch();
  watchMsg = `${Object.values(watch).filter((w) => w.new).length} changed`; drawSync(); redrawIfChanged(before);
});

/** Add the sites that are not on the list yet (or enrich existing sites with missing group/desc); returns how many were added. */
async function addSites(add: Site[]) {
  let changed = false;
  let added = 0;
  const current = [...sites];
  for (const s of add) {
    const idx = current.findIndex((x) => x.key === s.key);
    if (idx < 0) {
      current.push(s);
      added++;
      changed = true;
    } else {
      const existing = current[idx];
      const newGroup = existing.group || s.group;
      const newDesc = existing.desc || s.desc;
      if (newGroup !== existing.group || newDesc !== existing.desc) {
        current[idx] = { ...existing, group: newGroup, desc: newDesc };
        changed = true;
      }
    }
  }
  if (changed) { sites = current; await save(); }
  return added;
}

// Viso is a page of its own: inside the node's container, leaving FH goes through the shell.
const goTo = (href: string) => (window.parent !== window ? parent.postMessage({ __freenet_shell__: true, type: "navigate", href }, "*") : void (location.href = href));

async function copy(input: HTMLInputElement) {
  try { await navigator.clipboard.writeText(input.value); } catch { input.select(); } // the sandbox may refuse: leave it selected
}

// ---------------- top bar: sign-in, publishing, monitoring ----------------
function drawSync() {
  const box = app.querySelector<HTMLElement>("#sync");
  if (!box) return;
  const share = me && publishing ? `${linkBase()}#/u/${personaName(me.persona)}` : "";
  const watchBtns = `<span class="spacer"></span><span class="muted" id="wmsg">${esc(watchMsg)}</span>
    ${watching ? `<button id="wnow" type="button" class="ghost" ${checking ? "disabled" : ""} title="Read every site's state again">Refresh</button>` : ""}
    <button id="watch" type="button" class="ghost" aria-pressed="${watching}" title="Optional: subscribe to each site's contract and mark the ones that changed since you last opened them">Watch sites: ${watching ? "on" : "off"}</button>`;
  box.innerHTML = me === undefined ? `<span class="muted">Checking your sign-in…</span>`
    : me ? `<span>${key ? "Identity" : "Viso persona"} <code>${esc(personaName(me.persona).slice(0, 8))}…</code></span>
        <button id="pub" type="button" class="ghost" aria-pressed="${publishing}" title="Off: your list stays on this node. On: it is kept on Freenet, synced across your nodes, and anyone who knows your identity can read it.">Publish list: ${publishing ? "on" : "off"}</button>
        ${publishing ? `<button id="copyshare" type="button" class="ghost">Copy share link</button><input id="share" readonly hidden value="${esc(share)}" aria-label="Link to your list" />` : ""}
        <span class="muted">${esc(syncMsg)}</span>
        ${key ? `<button id="kshow" type="button" class="link">Backup key</button>` : ""}
        <button id="so" type="button" class="link">Sign out</button>${watchBtns}
        ${key ? `<div class="panel" id="kpanel" hidden><p class="muted">This identity was made here: its key is the only way to get it back on another node. Keep it secret.
          <button id="kdl" type="button" class="link">Download key</button></p><p><code>${esc(key)}</code></p></div>` : ""}`
    : `<span class="muted">Not signed in. Your list stays on this node.</span>
        <button id="sin" type="button" class="ghost" aria-expanded="${signPanel}">Sign in</button>${watchBtns}
        <div class="panel" ${signPanel ? "" : "hidden"}>
          <p class="muted">Signing in only proves who you are: nothing is published until you turn on “Publish list”. A published list is public to anyone who knows your identity, so use a separate identity if you also use this Viso persona elsewhere (Radica, say).</p>
          <div class="row wrap"><input id="vurl" value="${esc(officialViso())}" spellcheck="false" aria-label="Your Viso site" /><button id="vgo" type="button">Sign in with Viso</button></div>
          <div class="row wrap"><button id="lnew" type="button" class="ghost">Create an identity here</button>
            <input id="lkey" type="password" placeholder="…or paste your identity key" spellcheck="false" autocomplete="off" aria-label="Identity key" /><button id="limport" type="button" class="ghost">Use key</button></div>
          <p class="err" role="alert">${esc(syncMsg)}</p>
        </div>`;
  const on = (id: string, f: () => unknown) => { const b = box.querySelector<HTMLElement>(`#${id}`); if (b) b.onclick = f; };
  const fail = (e: unknown) => { syncMsg = errText(e); signPanel = true; drawSync(); };
  on("so", async () => {
    if (key && !confirm("Signing out deletes the identity key from this node. Without your backup it is lost. Sign out?")) return;
    await signOut(); me = null; key = null; syncMsg = ""; drawSync();
  });
  on("sin", () => { signPanel = !signPanel; drawSync(); });
  on("pub", async () => {
    if (!me) return;
    if (!publishing) {
      publishing = true; await storePut("publish", "1"); await sync(); drawSync();
      return;
    }
    if (!confirm("Stop publishing? Your list is emptied on the network (copies others already saved stay). Your list on this node is kept.")) return;
    publishing = false; await storePut("publish", "");
    try { await push(me, "[]", Date.now()); syncMsg = "Unpublished."; } catch (e) { syncMsg = `Could not empty the published list: ${errText(e)}`; }
    drawSync();
  });
  on("copyshare", async () => {
    const i = box.querySelector<HTMLInputElement>("#share")!;
    try { await navigator.clipboard.writeText(i.value); syncMsg = "Share link copied."; drawSync(); }
    catch { i.hidden = false; i.select(); } // the sandbox may refuse: show it selected
  });
  on("kshow", () => { const k = box.querySelector<HTMLElement>("#kpanel")!; k.hidden = !k.hidden; });
  on("kdl", () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([`FH identity key: keep it secret.\n${key}\n`], { type: "text/plain" }));
    a.download = `identity-${personaName(me!.persona).slice(0, 8)}.txt`;
    a.click();
  });
  on("watch", async () => {
    watching = !watching; await storePut("watch", watching ? "1" : "");
    watchMsg = ""; drawSync();
    if (watching) void watchSites();
  });
  on("wnow", () => watchSites(true));
  on("vgo", async () => { try { goTo(await startSignIn(box.querySelector<HTMLInputElement>("#vurl")!.value.trim())); } catch (e) { fail(e); } });
  const local = async (k?: string) => {
    try { await createLocalIdentity(k); [me, key] = [await currentSession(), await localIdentityKey()]; signPanel = false; syncMsg = ""; await sync(); drawSync(); } catch (e) { fail(e); }
  };
  on("lnew", () => local());
  on("limport", () => local(box.querySelector<HTMLInputElement>("#lkey")!.value));
}

// ---------------- tiles ----------------
// Sites open in a new tab: the node refuses to have its app shells framed (X-Frame-Options: DENY, the shell
// holds the app's identity token), and a popup escapes FH's sandbox, so the node wraps the site in its own shell.
const badge = (k: string) => watch[k]?.new ? ` <span class="badge" title="Its contract state changed since you last opened it">updated</span>` : "";
const tile = (s: Pick<Site, "name" | "key" | "hash"> & { group?: string; desc?: string }, extra: string) => {
  const desc = resolveDesc(s, dirDescs);
  return `
  <article class="tile" style="--h:${hue(s.key)}" data-key="${s.key}" data-find="${esc(`${s.name} ${s.group ?? ""} ${desc} ${s.key}`.toLowerCase())}">
    <a class="face" href="${esc(urlOf(s))}" target="_blank" rel="noopener noreferrer">
      <span class="glyph"><span class="letter">${esc([...s.name][0]?.toUpperCase() ?? "?")}</span><img alt="" loading="lazy" src="${nodeBase}/v1/contract/web/${s.key}/favicon.ico" /></span>
      <span class="name">${esc(s.name)}</span>${badge(s.key)}
      ${desc ? `<span class="desc" title="${esc(desc)}">${esc(desc)}</span>` : ""}
      <span class="key">${s.key.slice(0, 6)}…${s.key.slice(-4)}${esc(s.hash)}</span>
    </a>${extra}
  </article>`;
};

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
  document.body.classList.toggle("minimal-mode", viewMode === "minimal");

  const eDesc = e ? resolveDesc(e, dirDescs) : "";
  const formHtml = `
      <form class="tile add" id="add">
        <p class="label">${e ? "Edit site" : "Add a site"}</p>
        <input name="name" placeholder="Name" maxlength="60" value="${esc(e?.name ?? "")}" aria-label="Name" />
        <input name="link" placeholder="Link, key or FreeNames name" required value="${e ? esc(urlOf(e)) : ""}" aria-label="Link, contract key or FreeNames name" />
        <input name="group" placeholder="Group (optional)" maxlength="40" list="groups" value="${esc(e?.group ?? "")}" aria-label="Group" />
        <datalist id="groups">${groups.filter(Boolean).map((g) => `<option value="${esc(g)}"></option>`).join("")}</datalist>
        <textarea name="desc" placeholder="${e && !e.desc && eDesc ? `Description (inherited: ${esc(eDesc)})` : "Description (optional)"}" maxlength="200" rows="2" aria-label="Description">${esc(e?.desc ?? "")}</textarea>
        <p class="err" id="err" role="alert"></p>
        <div class="row"><button type="submit">${e ? "Save" : "Add"}</button>${e ? `<button type="button" id="cancel">Cancel</button>` : ""}</div>
      </form>`;

  const followHtml = `
    <section class="group follow">
      <h2>Following</h2>
      <div class="row wrap">
        ${follows.map((id) => `<span class="chip"><a href="#/u/${id}" title="${esc(id)}">${esc(id.slice(0, 8))}…</a><button type="button" data-unfollow="${id}" aria-label="Unfollow ${esc(id.slice(0, 8))}">&times;</button></span>`).join("")}
        <form id="followf" class="row"><input name="id" required placeholder="Paste someone's share link to follow their list" aria-label="Share link or identity to follow" /><button type="submit">Follow</button></form>
      </div>
      <p class="err" id="ferr" role="alert"></p>
    </section>`;

  const copyListHtml = `
    <details>
      <summary>Copy your list</summary>
      <p class="muted">Export it, or paste a list here and import it (it replaces the current one).</p>
      <textarea id="json" rows="6" spellcheck="false" aria-label="Your list as JSON">${esc(JSON.stringify(sites, null, 1))}</textarea>
      <button id="import" type="button">Import</button>
    </details>`;

  if (viewMode === "tiles") {
    const acts = (s: Site) => `
      <div class="acts">
        <button data-left="${s.key}" title="Move left" aria-label="Move ${esc(s.name)} left">&larr;</button>
        <button data-right="${s.key}" title="Move right" aria-label="Move ${esc(s.name)} right">&rarr;</button>
        <button data-edit="${s.key}" title="Edit" aria-label="Edit ${esc(s.name)}">&#9998;</button>
        <button data-del="${s.key}" title="Remove" aria-label="Remove ${esc(s.name)}">&times;</button>
      </div>`;

    app.innerHTML = `
      <section id="sync" class="sync topbar"></section>
      <header>
        <div class="header-top">
          <p class="kicker">Fisherman's Horizon</p>
          <button id="toggle-view" class="view-toggle" type="button" title="Switch to Minimal view">&#9776; Minimal</button>
        </div>
        <h1>Your Freenet, in one place.</h1>
        <p class="lede">Pin the sites you use and open them from one place. <a href="#/apps">Find apps &rarr;</a></p>
      </header>
      ${sites.length ? `<input id="q" class="search" type="search" placeholder="Search your sites (Ctrl+K), Enter opens the first" aria-label="Search your sites" autocomplete="off" />` : ""}
      ${groups.map((g) => `
        <section class="group">
          ${g ? `<h2>${esc(g)}</h2>` : ""}
          <div class="grid">${sites.filter((s) => s.group === g).map((s) => tile(s, acts(s))).join("")}</div>
        </section>`).join("")}
      ${followHtml}
      ${formHtml}
      ${copyListHtml}
      ${footer()}`;
  } else {
    // Minimal (Linkhorse) mode
    app.innerHTML = `
      <section id="sync" class="sync topbar"></section>
      <div class="lh-layout">
        <aside class="lh-sidebar">
          <div class="lh-brand">
            <span class="lh-title">Fisherman's Horizon</span>
            <button id="toggle-view" class="view-toggle" type="button" title="Switch to Tiles view">&#8862; Tiles</button>
          </div>
          <button id="lh-add-btn" class="lh-add-btn" type="button">+ Add Link</button>
          <nav class="lh-nav">
            ${groups.map((g) => `<a href="#cat-${slug(g)}" data-group="${esc(g)}">${esc(g || "General")}</a>`).join("")}
          </nav>
          <div class="muted" style="margin-top:auto; font-size:.85rem; padding-top:16px;">
            <a href="#/apps">Apps directory &rarr;</a>
          </div>
        </aside>
        <main class="lh-main">
          ${sites.length ? `<input id="q" class="search" type="search" placeholder="Search your sites (Ctrl+K), Enter opens the first" aria-label="Search your sites" autocomplete="off" />` : ""}
          <div class="lh-groups">
            ${groups.map((g) => `
              <section class="lh-section" id="cat-${slug(g)}" data-group="${esc(g)}">
                <h2>${esc(g || "General")}</h2>
                <ul class="lh-list">
                  ${sites.filter((s) => s.group === g).map((s) => {
                    const desc = resolveDesc(s, dirDescs);
                    return `
                    <li class="lh-item" data-key="${s.key}" data-find="${esc(`${s.name} ${s.group ?? ""} ${desc} ${s.key}`.toLowerCase())}">
                      <a class="lh-link" href="${esc(urlOf(s))}" target="_blank" rel="noopener noreferrer">${esc(s.name)}</a>${badge(s.key)}
                      ${desc ? `<span class="lh-desc">${esc(desc)}</span>` : ""}
                      <div class="lh-acts">
                        <button data-edit="${s.key}" title="Edit" aria-label="Edit ${esc(s.name)}">&#9998;</button>
                        <button data-del="${s.key}" title="Remove" aria-label="Remove ${esc(s.name)}">&times;</button>
                      </div>
                    </li>
                  `;
                  }).join("")}
                </ul>
              </section>`).join("")}
          </div>
          ${followHtml}
          ${formHtml}
          ${copyListHtml}
          ${footer()}
        </main>
      </div>`;
  }

  drawSync();
  if (viewMode === "tiles") icons();

  $("#toggle-view")?.addEventListener("click", async () => {
    viewMode = viewMode === "tiles" ? "minimal" : "tiles";
    try { localStorage.setItem("fh-view", viewMode); } catch { /* sandbox: no storage */ }
    await storePut("view-mode", viewMode);
    drawHome();
  });

  $("#lh-add-btn")?.addEventListener("click", () => {
    $<HTMLElement>("#add")?.scrollIntoView({ behavior: "smooth" });
    $<HTMLInputElement>("#add input[name=link]")?.focus();
  });

  if (viewMode === "minimal") {
    app.querySelectorAll<HTMLAnchorElement>(".lh-nav a").forEach((a) => {
      a.onclick = (ev) => {
        ev.preventDefault();
        const grp = a.dataset.group;
        const sec = app.querySelector<HTMLElement>(`.lh-section[data-group="${grp}"]`);
        if (sec) sec.scrollIntoView({ behavior: "smooth", block: "start" });
      };
    });

    const sections = app.querySelectorAll<HTMLElement>(".lh-section");
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          const grp = (entry.target as HTMLElement).dataset.group;
          app.querySelectorAll(".lh-nav a").forEach((el) => {
            el.classList.toggle("active", el.getAttribute("data-group") === grp);
          });
          break;
        }
      }
    }, { rootMargin: "0px 0px -75% 0px" });
    sections.forEach((s) => observer.observe(s));
  }

  $<HTMLFormElement>("#add").onsubmit = async (ev) => {
    ev.preventDefault();
    const f = new FormData(ev.target as HTMLFormElement), raw = String(f.get("link")).trim(), err = $("#err");
    const sid = raw.includes("#/u/") ? shareId(raw) : null; // a pasted share link: follow that list
    if (sid) { await setFollow(sid, true); location.hash = `#/u/${sid}`; return; }
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
    const desc = String(f.get("desc") ?? "").trim().slice(0, 200);
    const site: Site = { name, ...link, group: String(f.get("group")).trim().slice(0, 40), desc };
    sites = editing ? sites.map((s) => (s.key === editing ? site : s)) : [...sites, site];
    editing = null;
    drawHome();
    await save();
  };
  $<HTMLFormElement>("#followf").onsubmit = async (ev) => {
    ev.preventDefault();
    const id = shareId(String(new FormData(ev.target as HTMLFormElement).get("id")));
    if (fromBase58(id ?? "")?.length !== 32) return void ($("#ferr").textContent = "That is not a share link or identity.");
    await setFollow(id!, true);
    location.hash = `#/u/${id}`;
  };
  app.querySelectorAll<HTMLButtonElement>("[data-unfollow]").forEach((b) => (b.onclick = async () => { await setFollow(b.dataset.unfollow!, false); drawHome(); }));
  const descEl = $<HTMLTextAreaElement>("#add textarea[name=desc]");
  if (descEl) {
    descEl.onkeydown = (ev) => {
      if (ev.key === "Enter" && !ev.shiftKey) {
        ev.preventDefault();
        $<HTMLFormElement>("#add").requestSubmit();
      }
    };
  }
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
      if (viewMode === "tiles") {
        app.querySelectorAll<HTMLElement>(".group .tile").forEach((t) => (t.hidden = !words.every((w) => t.dataset.find!.includes(w))));
        app.querySelectorAll<HTMLElement>(".group").forEach((g) => (g.hidden = !g.querySelector(".tile:not([hidden])")));
      } else {
        app.querySelectorAll<HTMLElement>(".lh-item").forEach((t) => (t.hidden = !words.every((w) => t.dataset.find!.includes(w))));
        app.querySelectorAll<HTMLElement>(".lh-section").forEach((g) => {
          const has = !words.length || !!g.querySelector(".lh-item:not([hidden])");
          g.hidden = !has;
          const navLink = app.querySelector<HTMLElement>(`.lh-nav [data-group="${g.dataset.group}"]`);
          if (navLink) navLink.hidden = !has;
        });
      }
    };
    q.oninput = filter;
    q.onkeydown = (ev) => {
      if (ev.key === "Enter") {
        const target = app.querySelector<HTMLAnchorElement>(viewMode === "tiles" ? ".group .tile:not([hidden]) a.face" : ".lh-item:not([hidden]) a.lh-link");
        target?.click();
      }
      if (ev.key === "Escape") { q.value = ""; filter(); }
    };
  }

  // drag a site onto another to put it there, in that site's group (the arrow buttons do the same from the keyboard)
  app.querySelectorAll<HTMLElement>(".group .tile, .lh-item").forEach((t) => {
    t.draggable = true;
    t.ondragstart = (ev) => { ev.dataTransfer!.setData("text/plain", t.dataset.key!); t.classList.add("dragging"); };
    t.ondragend = () => t.classList.remove("dragging");
    t.ondragover = (ev) => { ev.preventDefault(); t.classList.add("over"); };
    t.ondragleave = () => t.classList.remove("over");
    t.ondrop = async (ev) => {
      ev.preventDefault();
      const from = ev.dataTransfer!.getData("text/plain");
      if (!sites.some((s) => s.key === from)) return;
      sites = dropSite(sites, from, t.dataset.key!);
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
  const groups = [...new Set(shared.map((s) => s.group))];
  app.innerHTML = `
    <p><a href="#/">&larr; Your sites</a></p>
    <header><p class="kicker">Shared list</p><h1>${shared.length} sites from <code>${esc(id.slice(0, 12))}…</code></h1>
      <p class="lede">${persona ? "Open them, or add them to your own list." : "This link is not a valid identity."}</p></header>
    ${shared.length ? `
      <p class="row"><button id="all" type="button" class="cta">Add all to my list</button> <button id="fol" type="button" class="ghost cta"></button> <span id="msg" class="muted"></span></p>
      ${shared.length > 3 ? `<input id="q" class="search" type="search" placeholder="Search shared sites (Ctrl+K), Enter opens the first" aria-label="Search shared sites" autocomplete="off" />` : ""}
      ${groups.map((g) => `
        <section class="group">
          ${g ? `<h2>${esc(g)}</h2>` : ""}
          <div class="grid">${shared.filter((s) => s.group === g).map((s) => tile(s, `<div class="acts on"><button data-take="${s.key}" ${has(s.key) ? "disabled" : ""} title="Add to my list" aria-label="Add ${esc(s.name)} to my list">${has(s.key) ? "&#10003;" : "+"}</button></div>`)).join("")}</div>
        </section>`).join("")}`
      : persona ? `<p class="muted">Nothing found: the list is empty, or no node answered.</p>` : ""}
    ${footer()}`;
  icons();
  const fol = app.querySelector<HTMLButtonElement>("#fol");
  if (fol) {
    const label = () => (fol.textContent = follows.includes(id) ? "Following ✓" : "Follow this list");
    label();
    fol.onclick = async () => { await setFollow(id, !follows.includes(id)); label(); };
  }
  const all = app.querySelector<HTMLButtonElement>("#all");
  if (all) all.onclick = async () => { const n = await addSites(shared); await drawShared(id); $("#msg").textContent = `${n} added.`; };
  app.querySelectorAll<HTMLButtonElement>("[data-take]").forEach((b) => (b.onclick = async () => {
    await addSites(shared.filter((s) => s.key === b.dataset.take));
    b.disabled = true; b.innerHTML = "&#10003;";
  }));
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
}

// ---------------- app directory: #/apps ----------------
function radicaLinkHtml(dirState: DirState | null): string {
  const fromDir = dirState ? rows(dirState).find((r) => r.name.trim().toLowerCase() === "radica")?.site : undefined;
  const fromSites = sites.find((s) => s.name.trim().toLowerCase() === "radica")?.key;
  const key = fromDir ?? fromSites;
  return key
    ? `<a href="${esc(urlOf({ key, hash: "" }))}" target="_blank" rel="noopener noreferrer"><b>Radica</b></a>`
    : `<b>Radica</b>`;
}

function renderDirActions(dirState: DirState | null) {
  const box = app.querySelector<HTMLElement>("#dir-actions");
  if (!box) return;
  const canAdmin = !!(me && isDirAdmin(me.persona, DIRECTORY_ADMIN, dirState));
  const isRoot = !!(me && me.persona.toLowerCase() === DIRECTORY_ADMIN.toLowerCase());

  if (!canAdmin) {
    box.innerHTML = `
      <h2>Propose a site</h2>
      <div class="sync">
        <p>Directory listings are curated by admins.</p>
        <p class="muted">To propose a site, post its link and a short description in <code>r/FH</code> on ${radicaLinkHtml(dirState)}. Posted links will be reviewed by the admins.</p>
      </div>`;
    return;
  }

  box.innerHTML = `
    <h2>${editingApp ? `Edit “${esc(editingApp.name)}”` : "List a site"}</h2>
    <form id="list-form" class="sync">
      <p class="muted">${editingApp
        ? "Update this app’s name, description, or link. If you change the link, the new site is registered and the old one is removed from the directory."
        : `Admin mode · Proposals are collected in <code>r/FH</code> on ${radicaLinkHtml(dirState)}.${isRoot ? ` <a href="#/admin">Manage admins &amp; blocklist</a>` : ""}`}</p>
      <div class="row wrap"><input name="link" required placeholder="Link, key or FreeNames name" aria-label="Link, contract key or FreeNames name" value="${editingApp ? esc(urlOf({ key: editingApp.site, hash: "" })) : ""}" /><input name="name" required maxlength="60" placeholder="Name" aria-label="Name" value="${editingApp ? esc(editingApp.name) : ""}" /></div>
      <div class="row wrap"><input name="desc" maxlength="200" placeholder="What it is, in a line" aria-label="Description" value="${editingApp ? esc(editingApp.desc) : ""}" /><button type="submit">${editingApp ? "Save changes" : "List it"}</button>
        ${editingApp ? `<button type="button" id="cancel-edit" class="ghost">Cancel</button><button type="button" id="delete-app" class="ghost danger">Delete listing</button>` : ""}</div>
      <p class="err" id="lmsg" role="alert"></p>
    </form>`;

  const form = $<HTMLFormElement>("#list-form");
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    const f = new FormData(form), raw = String(f.get("link")).trim(), msg = $("#lmsg");
    try {
      let site = parseLink(raw)?.key;
      if (!site && parseName(raw)) {
        msg.textContent = "Looking up FreeNames name…";
        site = (await resolveName(raw).catch(() => null)) ?? undefined;
      }
      if (!site) throw new Error("Not a Freenet site link, key or known FreeNames name.");
      const name = String(f.get("name")).trim();
      const desc = String(f.get("desc")).trim();
      if (!name) throw new Error("A name is needed.");

      if (editingApp) {
        msg.textContent = "Working (updating directory)…";
        if (editingApp.site === site) {
          await listSite(me!, site, name, desc);
        } else {
          await updateSite(me!, editingApp.site, site, name, desc);
        }
        if (sites.some((s) => s.key === editingApp!.site)) {
          sites = sites.map((s) => (s.key === editingApp!.site ? { ...s, key: site!, name } : s));
          await save();
        }
        editingApp = null;
        msg.textContent = "Updated.";
      } else {
        msg.textContent = "Working (updating directory)…";
        await listSite(me!, site, name, desc);
        msg.textContent = "Listed. It shows up here once the directory updates.";
      }
      form.reset();
      await drawApps();
    } catch (e) { msg.textContent = errText(e); }
  };

  const cancel = box.querySelector<HTMLButtonElement>("#cancel-edit");
  if (cancel) cancel.onclick = () => { editingApp = null; drawApps(); };

  const delBtn = box.querySelector<HTMLButtonElement>("#delete-app");
  if (delBtn && editingApp) {
    const toDel = editingApp.site, toDelName = editingApp.name;
    delBtn.onclick = async () => {
      if (!confirm(`Remove “${toDelName}” from the public directory?`)) return;
      const msg = $("#lmsg");
      try {
        if (msg) msg.textContent = "Removing from directory…";
        await removeSite(me!, toDel);
        editingApp = null;
        await drawApps();
      } catch (e) {
        if (msg) msg.textContent = errText(e);
      }
    };
  }
}

async function drawApps() {
  app.innerHTML = `
    <p><a href="#/">&larr; Your sites</a></p>
    <header><p class="kicker">Directory</p><h1>Freenet apps</h1>
      <p class="lede">Curated Freenet sites. Add the ones you want to your list. <span class="muted">The first visit on a node can take up to 30 s.</span></p></header>
    <input id="q" class="search" type="search" placeholder="Search the directory (Ctrl+K)" aria-label="Search the directory" autocomplete="off" />
    <div id="list" class="muted">Loading…</div>
    <div id="dir-actions"></div>
    ${footer()}`;
  renderDirActions(lastDirState);

  try {
    let dirState = await loadDirectory();
    if (location.hash !== "#/apps") return; // the user moved on while it loaded
    let canAdmin = !!(me && isDirAdmin(me.persona, DIRECTORY_ADMIN, dirState));
    if (canAdmin && !autoMigrated && Object.keys(dirState.entries).length === 0) {
      autoMigrated = true;
      $("#list").textContent = "Checking previous directory for sites to migrate…";
      const migrated = await migrateLegacyDirectory(me!, dirState).catch(() => 0);
      if (migrated > 0) dirState = await loadDirectory();
      if (location.hash !== "#/apps") return;
      canAdmin = !!(me && isDirAdmin(me.persona, DIRECTORY_ADMIN, dirState));
    }
    lastDirState = dirState;
    dirDescs = dirDescriptions(dirState);
    try { localStorage.setItem("fh-dir-cache", JSON.stringify(dirDescs)); } catch { /* sandbox */ }
    storePut("dir-cache", JSON.stringify(dirDescs)).catch(() => {});
    const list = rows(dirState);
    const has = (k: string) => sites.some((s) => s.key === k);
    $("#list").className = "";
    $("#list").innerHTML = list.length ? `<ul class="apps">${list.map((r) => {
      const onList = has(r.site);
      const oldTile = !onList ? sites.find((s) => s.name.toLowerCase() === r.name.toLowerCase()) : null;
      return `
        <li data-find="${esc(`${r.name} ${r.desc} ${r.site}`.toLowerCase())}" style="--h:${hue(r.site)}">
          <a href="${esc(urlOf({ key: r.site, hash: "" }))}" target="_blank" rel="noopener noreferrer"><b>${esc(r.name)}</b></a>
          <span class="muted">${esc(r.desc)}</span>
          <small class="muted">by ${esc(personaName(r.by).slice(0, 8))}…</small>
          <div class="app-acts">
            ${onList ? `<button disabled type="button">On your list</button>`
              : oldTile ? `<button data-update-tile="${r.site}" data-old="${oldTile.key}" data-name="${esc(r.name)}" type="button" class="cta" title="Update URL on your home page">Update on list</button>`
              : `<button data-add="${r.site}" data-name="${esc(r.name)}" data-desc="${esc(r.desc)}" type="button">+ Add</button>`}
            ${canAdmin ? `
              <button data-edit-app="${r.site}" data-name="${esc(r.name)}" data-desc="${esc(r.desc)}" type="button" class="ghost" title="Edit this listing">Edit</button>
              <button data-del-app="${r.site}" data-name="${esc(r.name)}" type="button" class="ghost danger" title="Remove from directory">&times;</button>
            ` : ""}
          </div>
        </li>`;
    }).join("")}</ul>` : `<p class="muted">No apps listed yet.</p>`;

    renderDirActions(dirState);

    app.querySelectorAll<HTMLButtonElement>("[data-add]").forEach((b) => (b.onclick = async () => {
      await addSites([{ name: b.dataset.name!, key: b.dataset.add!, hash: "", group: "", desc: b.dataset.desc ?? "" }]);
      b.disabled = true; b.textContent = "On your list";
    }));

    app.querySelectorAll<HTMLButtonElement>("[data-update-tile]").forEach((b) => (b.onclick = async () => {
      const newKey = b.dataset.updateTile!, oldKey = b.dataset.old!, name = b.dataset.name!;
      sites = sites.map((s) => (s.key === oldKey ? { ...s, key: newKey, name } : s));
      await save();
      b.disabled = true;
      b.textContent = "On your list";
    }));

    app.querySelectorAll<HTMLButtonElement>("[data-edit-app]").forEach((b) => (b.onclick = () => {
      editingApp = { site: b.dataset.editApp!, name: b.dataset.name!, desc: b.dataset.desc! };
      drawApps();
      $<HTMLElement>("#list-form")?.scrollIntoView({ behavior: "smooth" });
      $<HTMLInputElement>("input[name=name]")?.focus();
    }));

    app.querySelectorAll<HTMLButtonElement>("[data-del-app]").forEach((b) => (b.onclick = async () => {
      const site = b.dataset.delApp!, name = b.dataset.name!;
      if (!confirm(`Remove “${name}” from the public directory?`)) return;
      try {
        const msg = $("#lmsg");
        if (msg) msg.textContent = "Removing from directory…";
        await removeSite(me!, site);
        if (editingApp?.site === site) editingApp = null;
        await drawApps();
      } catch (e) {
        alert(`Could not remove: ${errText(e)}`);
      }
    }));

    const q = $<HTMLInputElement>("#q");
    const filter = () => {
      const words = q.value.toLowerCase().split(/\s+/).filter(Boolean);
      app.querySelectorAll<HTMLElement>(".apps li").forEach((li) => (li.hidden = !words.every((w) => li.dataset.find!.includes(w))));
    };
    q.oninput = filter;
    q.onkeydown = (ev) => {
      if (ev.key === "Enter") app.querySelector<HTMLAnchorElement>(".apps li:not([hidden]) a")?.click();
      if (ev.key === "Escape") { q.value = ""; filter(); }
    };
    if (q.value) filter();
  } catch (e) { $("#list").textContent = `Could not load the directory: ${errText(e)}`; }
}

// ---------------- directory admin: #/admin (not linked anywhere) ----------------
async function drawAdmin() {
  const me = await currentSession();
  const isAdmin = !!(me && me.persona.toLowerCase() === DIRECTORY_ADMIN.toLowerCase());

  app.innerHTML = `
    <p><a href="#/apps">&larr; Directory</a></p>
    <h1>Directory admin</h1>
    <div id="admin-role"></div>
    ${isAdmin
      ? `<p class="muted">Signed in with root admin Viso persona <code>${esc(personaName(me.persona))}</code>.</p>
         <h2>Delegated admins</h2>
         <p class="muted">Viso personas (Base58 or 64-char hex), one per line. Delegated admins can add, edit, and remove directory sites on <a href="#/apps">#/apps</a>.</p>
         <div class="sync">
           <textarea id="admins-list" rows="4" aria-label="Delegated admin personas"></textarea>
           <div class="row"><button id="save-admins" type="button">Publish admins</button> <span id="amsg"></span></div>
         </div>
         <h2>Blocklist</h2>
         <p class="muted">Site keys to hide, one per line. This replaces the whole blocklist.</p>
         <div class="sync">
           <textarea id="bl" rows="6" aria-label="Hidden site keys"></textarea>
           <div class="row"><button id="go" type="button">Publish blocklist</button> <span id="msg"></span></div>
         </div>`
      : `<p class="err">You are not signed in as the root directory administrator.</p>
         <p class="muted">Root admin Viso persona: <code>${esc(personaName(DIRECTORY_ADMIN))}</code>.</p>
         ${me
           ? `<p class="muted">Currently signed in as: <code>${esc(personaName(me.persona))}</code></p>`
           : `<p class="muted"><a href="#/">Sign in with Viso</a> on your home page first.</p>`}
         <details>
           <summary>Or use root admin secret (hex)</summary>
           <div class="sync">
             <input id="sk" type="password" autocomplete="off" placeholder="Root admin secret" aria-label="Root admin secret" />
             <textarea id="admins-list" rows="4" placeholder="Delegated admin personas (one per line)" aria-label="Delegated admin personas"></textarea>
             <div class="row"><button id="save-admins" type="button">Publish admins</button> <span id="amsg"></span></div>
             <textarea id="bl" rows="6" placeholder="Hidden site keys (one per line)" aria-label="Hidden site keys"></textarea>
             <div class="row"><button id="go" type="button">Publish blocklist</button> <span id="msg"></span></div>
           </div>
         </details>`
    }
    <div id="migrate-box"></div>
    <h2>Listed sites</h2><div id="listed" class="muted">Loading…</div>`;
  const adminsEl = $<HTMLTextAreaElement>("#admins-list");
  const saveAdmins = $<HTMLButtonElement>("#save-admins");
  const bl = $<HTMLTextAreaElement>("#bl");
  const go = $<HTMLButtonElement>("#go");
  const getAuth = () => {
    const auth = isAdmin ? me! : $<HTMLInputElement>("#sk")?.value.trim();
    if (!auth) throw new Error("Not authorized or missing secret.");
    return auth;
  };
  if (saveAdmins) saveAdmins.onclick = async () => {
    $("#amsg").textContent = "Sending…";
    try {
      const auth = getAuth();
      const seen = new Set<string>();
      const list: string[] = [];
      for (const rawLine of (adminsEl?.value ?? "").split("\n")) {
        const line = rawLine.trim();
        if (!line) continue;
        const hex = parsePersonaHex(line);
        if (!hex) throw new Error(`Invalid persona: ${line}`);
        if (hex === DIRECTORY_ADMIN.toLowerCase() || seen.has(hex)) continue;
        seen.add(hex);
        list.push(hex);
      }
      await setAdmins(auth, list);
      $("#amsg").textContent = `Done: ${list.length} delegated admin(s).`;
    } catch (e) { $("#amsg").textContent = `Error: ${errText(e)}`; }
  };
  if (go) go.onclick = async () => {
    const list = bl ? bl.value.split("\n").map((l) => l.trim()).filter(Boolean) : [];
    $("#msg").textContent = "Sending…";
    try {
      await blockSites(getAuth(), list);
      $("#msg").textContent = `Done: ${list.length} hidden.`;
    } catch (e) { $("#msg").textContent = `Error: ${errText(e)}`; }
  };
  try {
    const d = await loadDirectory();
    lastDirState = d;
    dirDescs = dirDescriptions(d);
    try { localStorage.setItem("fh-dir-cache", JSON.stringify(dirDescs)); } catch { /* sandbox */ }
    storePut("dir-cache", JSON.stringify(dirDescs)).catch(() => {});
    if (!isAdmin && me && isDirAdmin(me.persona, DIRECTORY_ADMIN, d)) {
      $("#admin-role").innerHTML = `<p class="sync">You are signed in as a <b>delegated directory admin</b>. You can add, edit, and remove sites directly on <a href="#/apps">#/apps</a>. Only the root admin can manage the admin list and blocklist.</p>`;
    }
    if (me && isDirAdmin(me.persona, DIRECTORY_ADMIN, d)) {
      loadLegacyDirectory().then((legacy) => {
        if (location.hash !== "#/admin") return;
        const plan = legacyMigrationPlan(d, legacy, isAdmin);
        const mbox = app.querySelector<HTMLElement>("#migrate-box");
        if (!mbox || (!plan.entries.length && !plan.blocked.length)) return;
        mbox.innerHTML = `
          <h2>Legacy migration</h2>
          <div class="sync">
            <p class="muted">Found ${plan.entries.length} site(s)${plan.blocked.length ? ` and ${plan.blocked.length} blocklist key(s)` : ""} in the previous directory that are not in the new directory yet.</p>
            <div class="row"><button id="run-migrate" type="button">Migrate now</button> <span id="mig-msg"></span></div>
          </div>`;
        app.querySelector<HTMLButtonElement>("#run-migrate")!.onclick = async () => {
          const mmsg = app.querySelector<HTMLElement>("#mig-msg")!;
          mmsg.textContent = "Migrating…";
          try {
            const count = await migrateLegacyDirectory(me, d, legacy);
            mmsg.textContent = `Migrated ${count} site(s).`;
            await drawAdmin();
          } catch (err) {
            mmsg.textContent = `Error: ${errText(err)}`;
          }
        };
      }).catch(() => {});
    }
    if (adminsEl) adminsEl.value = (d.admins?.list ?? []).map(personaName).join("\n");
    if (bl) bl.value = d.blocked.list.join("\n");
    const list = rows(d);
    $("#listed").className = "";
    $("#listed").innerHTML = list.length ? `<ul class="apps">${list.map((r) => {
      const isHidden = d.blocked.list.includes(r.site);
      return `
        <li style="--h:${hue(r.site)}">
          <a href="${esc(urlOf({ key: r.site, hash: "" }))}" target="_blank" rel="noopener noreferrer"><b>${esc(r.name)}</b></a>
          ${r.desc ? `<span class="muted">${esc(r.desc)}</span>` : ""}
          <small class="muted"><code>${esc(r.site)}</code></small>
          <div class="app-acts">
            <button class="ghost danger" type="button" data-hide="${esc(r.site)}" ${isHidden ? "disabled" : ""}>${isHidden ? "Hidden" : "Hide"}</button>
          </div>
        </li>`;
    }).join("")}</ul>` : `<p class="muted">Nothing listed.</p>`;
    // adds the key to the blocklist above; nothing is sent until "Publish blocklist"
    app.querySelectorAll<HTMLButtonElement>("[data-hide]").forEach((b) => (b.onclick = () => {
      const targetBl = $<HTMLTextAreaElement>("#bl");
      if (targetBl && !targetBl.value.split("\n").includes(b.dataset.hide!)) {
        targetBl.value = [targetBl.value.trim(), b.dataset.hide].filter(Boolean).join("\n");
      }
      b.disabled = true;
      b.textContent = "Hidden";
    }));
  } catch (e) { $("#msg").textContent = `Could not load the directory: ${errText(e)}`; }
}

// ---------------- routing ----------------
function route() {
  // inside the Freenet container, keep the address bar in sync so the URL is shareable
  if (window.parent !== window) parent.postMessage({ __freenet_shell__: true, type: "hash", hash: location.hash || "#/" }, "*");
  const h = location.hash, u = h.match(/^#\/u\/([1-9A-HJ-NP-Za-km-z]{32,50})$/);
  if (h !== "#/apps") editingApp = null;
  if (u) return void drawShared(u[1]);
  if (h === "#/apps") return void drawApps();
  if (h === "#/admin") return void drawAdmin();
  drawHome();
}

// tile buttons on the home page
document.addEventListener("click", async (ev) => {
  const b = (ev.target as HTMLElement).closest<HTMLElement>("[data-edit],[data-del],[data-left],[data-right]");
  if (!b) return;
  const d = b.dataset, moved = d.left ?? d.right;
  // neighbours are the ones shown next to it: same group, in list order (not the whole list's order)
  const mates = sites.filter((x) => x.group === sites.find((s) => s.key === moved)?.group), i = mates.findIndex((s) => s.key === moved);
  if (d.edit) { editing = d.edit; drawHome(); $<HTMLElement>("#add")?.scrollIntoView({ behavior: "smooth" }); $<HTMLInputElement>("input[name=name]").focus(); return; }
  if (d.del) sites = sites.filter((s) => s.key !== d.del);
  else if (d.left && i > 0) sites = moveSite(sites, d.left, mates[i - 1].key);
  else if (d.right && i >= 0 && i < mates.length - 1) sites = moveSite(sites, mates[i + 1].key, d.right);
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

// music is off until asked: browsers only start audio after a click anyway
const music = document.getElementById("music")!;
music.onclick = () => {
  const on = music.getAttribute("aria-pressed") !== "true";
  music.setAttribute("aria-pressed", String(on));
  if (on) startMusic(); else stopMusic();
};

app.innerHTML = `<p class="muted loading">Loading your sites…</p>`;
const query = new URLSearchParams(location.search);
if (query.has("viso") || query.has("whoiam")) { // back from Viso with its proof (or a refusal)
  try { await finishSignIn(query); } catch (e) { syncMsg = errText(e); }
  history.replaceState(null, "", location.pathname); // drop the one-time query
}
sites = parseSites(await storeGet("sites"));
publishing = (await storeGet("publish")) === "1";
follows = parseFollows(await storeGet("follows"));
watching = (await storeGet("watch")) === "1";
try {
  const w = JSON.parse((await storeGet("watch-state")) ?? "{}");
  for (const [k, v] of Object.entries<{ h?: unknown; new?: unknown }>(w)) {
    if (typeof v?.h === "string") watch[k] = { h: v.h, ...(typeof v.new === "string" ? { new: v.new } : {}) };
  }
} catch { /* start fresh */ }
const savedView = await storeGet("view-mode");
if (savedView === "tiles" || savedView === "minimal") viewMode = savedView;
const cachedDir = await storeGet("dir-cache");
if (cachedDir) {
  try { dirDescs = JSON.parse(cachedDir); } catch { /* ignore */ }
}
where = { node: "Saved on your Freenet node", browser: "Saved in this browser", session: "Not saved: lost on reload" }[await persistence()];
me = await currentSession().catch(() => null); // before the first draw: the directory's form depends on it
key = me ? await localIdentityKey() : null;
addEventListener("hashchange", route);
route();
await sync();
if (watching) setTimeout(() => void watchSites(), 3000); // after the page is usable

// opening a site makes its current state the one to compare against
document.addEventListener("click", (ev) => {
  const a = (ev.target as HTMLElement).closest<HTMLElement>("a.face, a.lh-link"), box = a?.closest<HTMLElement>("[data-key]"), w = box && watch[box.dataset.key!];
  if (!w?.new) return;
  w.h = w.new; delete w.new; void saveWatch();
  box!.querySelector(".badge")?.remove();
});

// Load the app directory in background to inherit descriptions and keep cache fresh
loadDirectory().then(async (dirState) => {
  dirDescs = dirDescriptions(dirState);
  try { localStorage.setItem("fh-dir-cache", JSON.stringify(dirDescs)); } catch { /* sandbox */ }
  await storePut("dir-cache", JSON.stringify(dirDescs));
  if ((!location.hash || location.hash === "#/") && !editing && !document.activeElement?.closest("input, textarea")) {
    drawHome();
  }
}).catch((e) => console.warn("Background directory sync failed:", e));
