import "./style.css";
import { nodeBase, persistence, storeGet, storePut } from "./store";
import { hue, parseLink, parseSites, type Site } from "./sites";

const home = document.getElementById("home")!;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const urlOf = (s: Site) => `${nodeBase}/v1/contract/web/${s.key}/${s.hash}`;

let sites: Site[] = [];
let editing: string | null = null; // key of the site in the form, null = adding
let where = "";

const save = () => storePut("sites", JSON.stringify(sites));

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
sites = parseSites(await storeGet("sites"));
where = { node: "Saved on your Freenet node", browser: "Saved in this browser", session: "Not saved: lost on reload" }[await persistence()];
drawHome();
