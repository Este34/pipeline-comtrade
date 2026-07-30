// Palette de commandes (Ctrl/Cmd K) : sauter à une vue ou ouvrir le profil
// d'un pays sans naviguer par clics successifs dans les filtres.
import { esc } from "./format.js";

const VUES = [
  { key: "flux", label: "Flux" },
  { key: "europe", label: "Europe" },
  { key: "matrice", label: "Matrice pays × minéraux" },
  { key: "mineraux", label: "Minéraux critiques" },
  { key: "profil", label: "Profil pays" },
  { key: "bilateral", label: "Analyse bilatérale" },
  { key: "produit", label: "Analyse par produit" },
  { key: "carto", label: "Cartes et séries" },
];

// onGoToView(key) et onOpenCountry(iso3) sont fournies par main.js.
export function mountPalette({ labels, onGoToView, onOpenCountry }) {
  const overlay = document.createElement("div");
  overlay.className = "palette-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "Palette de commandes");
  overlay.innerHTML = `
    <div class="palette">
      <div class="palette-input-row">
        <span class="ic" aria-hidden="true">&#9906;</span>
        <input type="text" id="paletteInput" placeholder="Aller à une vue, ouvrir un pays..." autocomplete="off">
        <span class="palette-esc">Échap</span>
      </div>
      <div class="palette-list" id="paletteList"></div>
    </div>`;
  document.body.appendChild(overlay);

  const input = overlay.querySelector("#paletteInput");
  const list = overlay.querySelector("#paletteList");
  const paysOptions = Object.entries(labels.countries).map(([iso3, nom]) => ({ iso3, nom }));

  let items = [];
  let active = 0;
  let lastFocus = null;

  function buildItems(query) {
    const q = (query || "").toLowerCase();
    const vues = VUES.filter((v) => v.label.toLowerCase().includes(q)).map((v) => ({
      group: "Vues",
      label: `Aller à : ${v.label}`,
      action: () => onGoToView(v.key),
    }));
    const countries = paysOptions
      .filter((c) => c.nom.toLowerCase().includes(q))
      .slice(0, 6)
      .map((c) => ({ group: "Pays", label: `Ouvrir le profil de ${c.nom}`, action: () => onOpenCountry(c.iso3) }));
    return [...vues, ...countries];
  }

  function render() {
    items = buildItems(input.value);
    active = 0;
    list.innerHTML = "";
    if (!items.length) {
      list.innerHTML = `<div class="palette-empty">Aucun résultat pour « ${esc(input.value)} »</div>`;
      return;
    }
    let curGroup = null;
    items.forEach((it, i) => {
      if (it.group !== curGroup) {
        curGroup = it.group;
        const g = document.createElement("div");
        g.className = "palette-group";
        g.textContent = curGroup;
        list.appendChild(g);
      }
      const row = document.createElement("div");
      row.className = "palette-item";
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", i === 0 ? "true" : "false");
      row.textContent = it.label;
      row.addEventListener("mousedown", (e) => {
        e.preventDefault();
        close();
        it.action();
      });
      list.appendChild(row);
    });
  }

  function open() {
    lastFocus = document.activeElement;
    overlay.classList.add("open");
    input.value = "";
    render();
    setTimeout(() => input.focus(), 10);
  }
  function close() {
    overlay.classList.remove("open");
    if (lastFocus) lastFocus.focus();
  }

  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
  input.addEventListener("input", render);
  document.addEventListener("keydown", (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "k") {
      e.preventDefault();
      overlay.classList.contains("open") ? close() : open();
      return;
    }
    if (!overlay.classList.contains("open")) return;
    const opts = [...list.querySelectorAll(".palette-item")];
    if (e.key === "Escape") { close(); return; }
    else if (e.key === "ArrowDown") { e.preventDefault(); active = Math.min(active + 1, opts.length - 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); active = Math.max(active - 1, 0); }
    else if (e.key === "Enter") {
      e.preventDefault();
      if (items[active]) { close(); items[active].action(); }
      return;
    } else return;
    opts.forEach((o, i) => o.setAttribute("aria-selected", i === active ? "true" : "false"));
    opts[active]?.scrollIntoView({ block: "nearest" });
  });

  return { open };
}
