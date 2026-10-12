import "./style.css";
import { nodeBase, persistence, storeGet, storePut } from "./store";
import { hue, parseLink, parseSites, type Site } from "./sites";

const tabs = document.getElementById("tabs")!, home = document.getElementById("home")!, frames = document.getElementById("frames")!;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const urlOf = (s: Site) => `${nodeBase}/v1/contract/web/${s.key}/${s.hash}`;

let sites: Site[] = [];
let open: string[] = []; // keys of the sites open in tabs, in tab order
let active = ""; // "" = home
let editing: string | null = null; // key of the site in the form, null = adding
let where = "";

const save = () => storePut("sites", JSON.stringify(sites));

// Leave FH for the site itself. Inside the Freenet container, the shell does the navigation.
const goTo = (href: string) => (window.parent !== window ? parent.postMessage({ __freenet_shell__: true, type: "navigate", href }, "*") : void (location.href = href));

function show(key: string) {
  if (key && !open.includes(key)) {
    open.push(key);
    const s = sites.find((x) => x.key === key)!;
    const f = document.createElement("iframe");
    f.dataset.key = key;
    f.title = s.name;
    f.src = urlOf(s);
    // never allow-same-origin: sites must not reach FH or each other (in the container this frame is sandboxed anyway)
    f.setAttribute("sandbox", "allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals");
    f.allow = "clipboard-write";
    frames.append(f);
  }
  active = key;
  frames.querySelectorAll("iframe").forEach((f) => (f.hidden = f.dataset.key !== key));
  home.hidden = !!key;
  frames.hidden = !key;
  drawTabs();
}

function close(key: string) {
  open = open.filter((k) => k !== key);
  frames.querySelector(`iframe[data-key="${key}"]`)?.remove();
  if (active === key) show(open.at(-1) ?? "");
  else drawTabs();
}

function drawTabs() {
  const name = (k: string) => sites.find((s) => s.key === k)?.name ?? k.slice(0, 8);
  tabs.innerHTML = `<button class="tab brand${active ? "" : " on"}" data-show="">FH</button>` +
    open.map((k) => `<span class="tab${active === k ? " on" : ""}" style="--h:${hue(k)}">` +
      `<button data-show="${k}">${esc(name(k))}</button><button class="x" data-close="${k}" aria-label="Close ${esc(name(k))}">&times;</button></span>`).join("") +
    (active ? `<button class="tab out" data-full="${active}" title="Open this site on its own">&#8599;</button>` : "");
}

function drawHome() {
  const e = editing ? sites.find((s) => s.key === editing) : undefined;
  home.innerHTML = `
    <header>
      <p class="kicker">Fisherman's Horizon</p>
      <h1>Your Freenet, in one place.</h1>
      <p class="lede">Pin the sites you use, open them side by side in tabs, never leave home.</p>
    </header>
    <section class="grid">
      ${sites.map((s) => `
        <article class="tile" style="--h:${hue(s.key)}">
          <button class="face" data-show="${s.key}" aria-label="Open ${esc(s.name)}">
            <span class="glyph">${esc([...s.name][0]?.toUpperCase() ?? "?")}</span>
            <span class="name">${esc(s.name)}</span>
            <span class="key">${s.key.slice(0, 6)}…${s.key.slice(-4)}${esc(s.hash)}</span>
          </button>
          <div class="acts">
            <button data-full="${s.key}" title="Open on its own">&#8599;</button>
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
      <summary>Move your list</summary>
      <p class="muted">Copy this to another node, or paste a list here and import it (it replaces the current one).</p>
      <textarea id="json" rows="6" spellcheck="false">${esc(JSON.stringify(sites, null, 1))}</textarea>
      <button id="import" type="button">Import</button>
    </details>
    <footer>
      <span class="muted">${where}</span> &middot;
      <a href="https://github.com/scobru/FH" target="_blank" rel="noopener noreferrer">github.com/scobru/FH</a> &middot; MIT
    </footer>`;

  home.querySelector<HTMLFormElement>("#add")!.onsubmit = async (ev) => {
    ev.preventDefault();
    const f = new FormData(ev.target as HTMLFormElement);
    const link = parseLink(String(f.get("link")));
    const err = home.querySelector("#err")!;
    if (!link) return void (err.textContent = "Paste a Freenet site link (…/v1/contract/web/<key>/) or its key.");
    if (link.key !== editing && sites.some((s) => s.key === link.key)) return void (err.textContent = "Already on your list.");
    const site = { name: String(f.get("name")).trim().slice(0, 60) || link.key.slice(0, 8), ...link };
    if (editing) {
      if (link.key !== editing) close(editing);
      sites = sites.map((s) => (s.key === editing ? site : s));
    } else sites.push(site);
    editing = null;
    drawHome(); drawTabs();
    await save();
  };
  home.querySelector<HTMLButtonElement>("#cancel")?.addEventListener("click", () => { editing = null; drawHome(); });
  home.querySelector<HTMLButtonElement>("#import")!.onclick = async () => {
    const next = parseSites(home.querySelector<HTMLTextAreaElement>("#json")!.value);
    if (!next.length) return;
    [...open].forEach(close);
    sites = next;
    drawHome();
    await save();
  };
}

// one delegated click handler for tabs and tiles
document.addEventListener("click", async (ev) => {
  const b = (ev.target as HTMLElement).closest<HTMLElement>("[data-show],[data-close],[data-full],[data-edit],[data-del]");
  if (!b) return;
  const d = b.dataset;
  if (d.show !== undefined) show(d.show);
  else if (d.close) close(d.close);
  else if (d.full) goTo(urlOf(sites.find((s) => s.key === d.full)!));
  else if (d.edit) { editing = d.edit; drawHome(); home.querySelector<HTMLInputElement>("input[name=name]")?.focus(); }
  else if (d.del) {
    close(d.del);
    sites = sites.filter((s) => s.key !== d.del);
    drawHome();
    await save();
  }
});

drawTabs();
home.innerHTML = `<p class="muted loading">Loading your sites…</p>`;
sites = parseSites(await storeGet("sites"));
where = { node: "Saved on your Freenet node", browser: "Saved in this browser", session: "Not saved: lost on reload" }[await persistence()];
drawHome();
