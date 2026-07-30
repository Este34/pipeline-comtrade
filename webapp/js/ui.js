// Constructeurs d'UI réutilisables : contrôles de filtre, cartes KPI, tableaux
// de résultats lisibles (triables). Remplace la grille brute de Comtrade.
import { esc } from "./format.js";
import { mineraux, stades, formesPour, formeLabel } from "./labels.js";

// Années couvertes par le jeu de données.
export const ANNEES = Array.from({ length: 26 }, (_, i) => 2000 + i);

// Construit un <select> ; options = [{value, label}].
export function selectHTML(id, options, selected) {
  const opts = options
    .map((o) => `<option value="${esc(o.value)}"${String(o.value) === String(selected) ? " selected" : ""}>${esc(o.label)}</option>`)
    .join("");
  return `<select id="${id}">${opts}</select>`;
}

// Options pays triées par nom FR (depuis labels.countries : ISO3 -> nom).
export function paysOptions(labels) {
  return Object.entries(labels.countries)
    .map(([iso3, nom]) => ({ value: iso3, label: nom }))
    .sort((a, b) => a.label.localeCompare(b.label, "fr"));
}

// Liste à choix multiples utilisable au simple clic.
//
// Un `<select multiple>` natif impose Ctrl/Cmd pour cocher plusieurs entrées :
// personne ne le devine, et un clic seul efface toute la sélection précédente.
// On affiche donc de vraies cases à cocher, doublées d'un `<select multiple>`
// masqué qui reste la source de vérité. Les vues continuent de lire
// `selectedOptions` et d'écouter l'événement `change` sans rien changer, et la
// sélection reste pilotable par programme (clic sur la carte, réinitialisation
// d'une puce) via `sync()`.
// Au-delà de ce nombre d'entrées, un filtre de recherche est ajouté : un
// `<select>` natif offrait la saisie semi-automatique (taper « fr » saute à
// France), qu'une liste de cases à cocher perd. Sans lui, remplacer le select
// dégraderait la recherche d'un pays au lieu de l'améliorer.
const SEUIL_RECHERCHE = 12;

export function multiSelectHTML(id, options, selectionnees = []) {
  const estSel = (v) => selectionnees.map(String).includes(String(v));
  const cases = options
    .map(
      (o) => `<label class="multi-opt"><input type="checkbox" value="${esc(o.value)}"${estSel(o.value) ? " checked" : ""}>
        <span>${esc(o.label)}</span></label>`
    )
    .join("");
  const opts = options
    .map((o) => `<option value="${esc(o.value)}"${estSel(o.value) ? " selected" : ""}>${esc(o.label)}</option>`)
    .join("");
  const recherche =
    options.length > SEUIL_RECHERCHE
      ? `<input type="search" class="multi-recherche" id="${id}-q" autocomplete="off"
           placeholder="Filtrer la liste..." aria-label="Filtrer la liste">`
      : "";
  return `<div class="multi-wrap">${recherche}
    <div class="multi" id="${id}-cases" role="group">${cases}</div>
    <div class="multi-compte" id="${id}-compte" aria-live="polite"></div></div>
    <select id="${id}" multiple hidden tabindex="-1" aria-hidden="true">${opts}</select>`;
}

// Câble une liste générée par multiSelectHTML(). Renvoie { sync, setTout }.
export function wireMultiSelect(id) {
  const select = document.getElementById(id);
  const boite = document.getElementById(`${id}-cases`);
  const compte = document.getElementById(`${id}-compte`);
  const q = document.getElementById(`${id}-q`);

  function majCompte() {
    const n = select.selectedOptions.length;
    compte.textContent = n === 0 ? "Aucune sélection" : `${n} sélectionné${n > 1 ? "s" : ""}`;
  }

  boite.addEventListener("change", (e) => {
    const c = e.target;
    if (!c.matches('input[type="checkbox"]')) return;
    const opt = [...select.options].find((o) => o.value === c.value);
    if (opt) opt.selected = c.checked;
    majCompte();
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });

  if (q) {
    q.addEventListener("input", () => {
      const terme = q.value.trim().toLowerCase();
      for (const label of boite.querySelectorAll(".multi-opt")) {
        // Une entrée cochée reste visible même si elle ne correspond pas au
        // filtre : la masquer donnerait l'illusion de l'avoir désélectionnée.
        const coche = label.querySelector("input").checked;
        label.hidden = !coche && !label.textContent.toLowerCase().includes(terme);
      }
    });
  }

  // Recopie l'état du select vers les cases, après une modification programmée.
  function sync() {
    for (const c of boite.querySelectorAll('input[type="checkbox"]')) {
      const opt = [...select.options].find((o) => o.value === c.value);
      c.checked = !!opt?.selected;
    }
    majCompte();
  }

  majCompte();
  return {
    sync,
    setTout(valeur) {
      for (const o of select.options) o.selected = valeur;
      sync();
    },
  };
}

// Champ de recherche par code produit.
//
// La saisie accepte un code NC8 (nomenclature combinée européenne, 8 chiffres),
// HS6 ou HS2. Comtrade publie en HS, pas en NC : un NC8 n'existe donc pas tel
// quel dans les données, mais ses six premiers chiffres SONT le code HS6, ce qui
// rend la saisie exploitable. La précision atteinte dépend du jeu de données
// interrogé : HS6 exact sur les minéraux critiques, chapitre à 2 chiffres sur le
// jeu principal, qui n'a pas été extrait plus finement.
export function champCodeHTML(id, placeholder = "ex : 85076000, 850760 ou 85") {
  return `<input id="${id}" type="text" inputmode="numeric" autocomplete="off"
    placeholder="${esc(placeholder)}" aria-describedby="${id}-aide">`;
}

// Normalise une saisie de code produit ; renvoie null si rien d'exploitable.
export function normaliserCode(saisie) {
  const chiffres = String(saisie || "").replace(/\D/g, "");
  if (!chiffres) return null;
  return { chiffres, hs2: chiffres.slice(0, 2), hs6: chiffres.slice(0, 6) };
}

// Options minéraux, dédoublonnées depuis le référentiel matières et triées FR.
export function mineralOptions(labels) {
  return mineraux(labels).map((m) => ({ value: m, label: m }));
}

// Options des 4 stades de la chaîne de valeur, dans l'ordre industriel.
export function stadeOptions(labels) {
  return stades(labels).map((s) => ({ value: s.id, label: s.label }));
}

// Options des formes présentes dans la sélection de minéraux en cours.
export function formeOptions(labels, mins) {
  return formesPour(labels, mins).map((f) => ({ value: f, label: formeLabel(labels, f) }));
}

export function anneeOptions() {
  return ANNEES.map((y) => ({ value: y, label: String(y) })).reverse();
}

export function fluxOptions() {
  return [
    { value: "M", label: "Importations" },
    { value: "X", label: "Exportations" },
  ];
}

// Sens de lecture d'un pays dans un flux bilatéral.
//
// Comtrade est déclaratif : le pays analysé est toujours le DÉCLARANT, et ce
// choix ne fait que dire de quel côté de l'échange on le regarde. Les libellés
// nomment l'action plutôt que le code de flux, « M » et « X » n'étant lisibles
// que pour qui pratique déjà la nomenclature.
export function sensOptions() {
  return [
    { value: "M", label: "Importateur (ce pays achète)" },
    { value: "X", label: "Exportateur (ce pays vend)" },
  ];
}

// Avertissement affiché quand un poids est sommé sur plusieurs stades.
//
// Additionner des poids BRUTS le long d'une chaîne de valeur ne mesure rien de
// physique, pour deux raisons distinctes :
//
//  - la teneur varie d'un stade à l'autre. Un kilo de concentré de cuivre
//    contient ~250 g de métal, un kilo de cathode ~1 000 g, un kilo de câble
//    isolé ~300 à 600 g (le reste est de l'isolant). Sommer les trois surestime
//    massivement les exportateurs de minerai face aux exportateurs de métal.
//  - le même métal est recompté à chaque franchissement de frontière : minerai,
//    puis cathode, puis fil, puis câble.
//
// C'est la raison pour laquelle les tableaux de bord de référence (RMIS du JRC,
// World Mining Data, USGS) publient toujours une production PAR STADE et ne
// totalisent jamais la chaîne. La comparaison n'est légitime qu'à stade fixé.
export function avertirPoidsMultiStades(metric, stadesPanier, stadeLabels = []) {
  if (metric !== "poids" || !stadesPanier || stadesPanier.length < 2) return "";
  return `<div class="note note-alerte"><b>Poids additionnés sur ${stadesPanier.length} stades
    ${stadeLabels.length ? `(${stadeLabels.join(", ")})` : ""} — classement à interpréter avec
    précaution.</b> Les poids déclarés sont des poids <b>bruts de produit</b>, pas des tonnages de
    métal contenu : un kilo de concentré ne vaut qu'environ un quart de kilo de métal, un kilo de
    câble isolé entre un tiers et deux tiers. Additionner les stades surestime donc les exportateurs
    de minerai et recompte le même métal à chaque étape de la chaîne. Pour un classement comparable
    aux sources de référence, <b>ne cochez qu'un seul stade</b>, ou passez à la mesure « Valeur ».</div>`;
}

// Avertissement sur la nature même de la source.
//
// Confondre commerce déclaré et production extraite est le contresens le plus
// coûteux sur ces données, et il est d'autant plus facile que les deux se
// mesurent en tonnes et se rapportent aux mêmes pays.
export function noteCommerceNonProduction() {
  return `<b>Ces chiffres mesurent des ÉCHANGES, pas de la production.</b> Un pays qui extrait
    beaucoup mais transforme sur place apparaît peu ; un pays de transit ou de réexportation
    apparaît beaucoup. Les volumes ne sont donc pas comparables à ceux du JRC/RMIS, de World Mining
    Data ou de l'USGS, qui publient de la production minière et métallurgique.`;
}

// En-tête d'une vue : ce qu'elle montre, et ce qu'il faut savoir pour la lire
// sans se tromper. Un graphe de commerce extérieur sans cadrage se prête à des
// contresens coûteux (valeur déclarée ≠ métal contenu, import ≠ consommation).
export function viewHead({ titre, lede, meta }) {
  return `<div class="view-head">
    <h2>${esc(titre)}</h2>
    <p class="view-lede">${lede}</p>
    ${meta ? `<p class="view-meta">${meta}</p>` : ""}
  </div>`;
}

// Bascule métrique Valeur (US$) / Poids (t). Rendue comme un <select> étiqueté.
export function metricOptions() {
  return [
    { value: "valeur", label: "Valeur (US$)" },
    { value: "poids", label: "Poids (t)" },
  ];
}

// Un bloc contrôle étiqueté (label + champ).
export function ctrl(labelText, innerHTML, grow = false) {
  return `<div class="ctrl${grow ? " grow" : ""}"><label>${esc(labelText)}</label>${innerHTML}</div>`;
}

// Balisage d'un combobox (remplace un <select> à liste longue par une
// recherche instantanée). Câblage réel via wireCombo().
export function comboHTML(id, placeholder) {
  return `<div class="combo">
    <input type="text" id="${id}" role="combobox" aria-expanded="false" aria-controls="${id}-list"
      aria-autocomplete="list" autocomplete="off" placeholder="${esc(placeholder || "")}">
    <div class="combo-list" id="${id}-list" role="listbox"></div>
  </div>`;
}

// Câble un combobox généré par comboHTML(). options = [{value, label}].
// Renvoie { value, set(v) } pour lire/écrire la sélection courante.
export function wireCombo(id, options, { value } = {}) {
  const input = document.getElementById(id);
  const list = document.getElementById(`${id}-list`);
  let selected = value ?? "";
  let active = -1;
  let matches = [];
  const changeListeners = [];
  const labelOf = (v) => options.find((o) => String(o.value) === String(v))?.label || "";
  input.value = labelOf(selected);

  function choose(o) {
    selected = o.value;
    input.value = o.label;
    close();
    changeListeners.forEach((fn) => fn(selected));
  }
  function render(query) {
    const q = (query || "").toLowerCase();
    matches = options.filter((o) => o.label.toLowerCase().includes(q)).slice(0, 12);
    active = -1;
    list.innerHTML = matches.length
      ? ""
      : `<div class="combo-empty">Aucun résultat pour « ${esc(query)} »</div>`;
    matches.forEach((o) => {
      const opt = document.createElement("div");
      opt.className = "combo-opt";
      opt.setAttribute("role", "option");
      opt.textContent = o.label;
      opt.addEventListener("mousedown", (e) => { e.preventDefault(); choose(o); });
      list.appendChild(opt);
    });
  }
  function open() { list.classList.add("open"); input.setAttribute("aria-expanded", "true"); render(input.value); }
  function close() { list.classList.remove("open"); input.setAttribute("aria-expanded", "false"); }

  input.addEventListener("focus", open);
  input.addEventListener("input", () => { render(input.value); list.classList.add("open"); });
  input.addEventListener("blur", () => setTimeout(close, 120));
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); active = Math.min(active + 1, matches.length - 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); active = Math.max(active - 1, 0); }
    else if (e.key === "Enter") { e.preventDefault(); if (matches[active]) choose(matches[active]); return; }
    else if (e.key === "Escape") { close(); return; }
    else return;
    [...list.children].forEach((o, i) => o.setAttribute("aria-selected", i === active ? "true" : "false"));
    list.children[active]?.scrollIntoView({ block: "nearest" });
  });

  return {
    get value() { return selected; },
    set(v) { selected = v; input.value = labelOf(v); },
    onChange(fn) { changeListeners.push(fn); },
  };
}

// Puces de filtres actifs, retirables. items = [{label, value, onReset()}].
export function renderChips(container, items) {
  container.innerHTML = "";
  items.forEach((it) => {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = `${it.label} : ${it.value} `;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "×";
    btn.setAttribute("aria-label", `Réinitialiser le filtre ${it.label}`);
    btn.addEventListener("click", it.onReset);
    chip.appendChild(btn);
    container.appendChild(chip);
  });
}

// Affiche des cartes KPI en état de chargement (squelette animé), le temps
// que la requête DuckDB-WASM réponde (plusieurs partitions Parquet à lire).
export function skeletonKpis(container, count = 3) {
  const cards = Array.from(
    { length: count },
    () => `<div class="kpi"><div class="skel skel-line"></div><div class="skel skel-num"></div></div>`
  ).join("");
  container.innerHTML = `<div class="kpis three">${cards}</div>`;
}

// Bouton flottant de retour en haut de page (injecté une seule fois).
export function wireBackToTop() {
  if (document.getElementById("totop")) return;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.id = "totop";
  btn.className = "totop";
  btn.setAttribute("aria-label", "Revenir en haut de page");
  btn.textContent = "↑";
  btn.addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));
  document.body.appendChild(btn);
  window.addEventListener("scroll", () => btn.classList.toggle("show", window.scrollY > 400), { passive: true });
}

// Cartes KPI ; items = [{label, value, cls?}].
export function kpisHTML(items, colonnes = items.length) {
  const cls = colonnes === 3 ? "three" : colonnes === 4 ? "four" : "";
  const cards = items
    .map(
      (k) => `<div class="kpi"><div class="label">${esc(k.label)}</div>
        <div class="value mono ${k.cls || ""}">${k.value}</div></div>`
    )
    .join("");
  return `<div class="kpis ${cls}">${cards}</div>`;
}

// Tableau triable. columns = [{key, label, render?(row), num?}].
// Clique sur un en-tête = tri. Renvoie l'élément table pour un usage ultérieur.
export function renderTable(container, columns, rows) {
  const wrap = document.createElement("div");
  wrap.className = "table-wrap";
  const table = document.createElement("table");
  table.className = "data-table";
  wrap.appendChild(table);
  container.appendChild(wrap);

  let sortKey = null;
  let sortAsc = false;

  function draw() {
    const sorted = [...rows];
    if (sortKey) {
      sorted.sort((a, b) => {
        const va = a[sortKey], vb = b[sortKey];
        if (typeof va === "number" && typeof vb === "number") return sortAsc ? va - vb : vb - va;
        return sortAsc
          ? String(va).localeCompare(String(vb), "fr")
          : String(vb).localeCompare(String(va), "fr");
      });
    }
    const thead = `<thead><tr>${columns
      .map((c) => `<th data-k="${esc(c.key)}">${esc(c.label)}${sortKey === c.key ? (sortAsc ? " ▲" : " ▼") : ""}</th>`)
      .join("")}</tr></thead>`;
    const tbody = `<tbody>${sorted
      .map(
        (r) =>
          `<tr>${columns.map((c) => `<td>${c.render ? c.render(r) : esc(r[c.key])}</td>`).join("")}</tr>`
      )
      .join("")}</tbody>`;
    table.innerHTML = thead + tbody;
    table.querySelectorAll("th").forEach((th) => {
      th.addEventListener("click", () => {
        const k = th.dataset.k;
        if (sortKey === k) sortAsc = !sortAsc;
        else { sortKey = k; sortAsc = false; }
        draw();
      });
    });
  }
  draw();
  return table;
}

// Bloc carte avec titre + bouton export CSV optionnel.
export function card(titre, exportId) {
  const el = document.createElement("div");
  el.className = "chart-card";
  const btn = exportId
    ? `<button type="button" class="chart-btn btn-export" data-export="${exportId}">⭳ CSV</button>`
    : "";
  el.innerHTML = `<div class="card-head"><h3>${esc(titre)}</h3>${btn}</div><div class="card-body"></div>`;
  return el;
}

export function setStatus(msg, isError = false) {
  const el = document.getElementById("status");
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle("err", isError);
}
