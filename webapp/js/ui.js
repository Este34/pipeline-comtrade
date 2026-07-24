// Constructeurs d'UI réutilisables : contrôles de filtre, cartes KPI, tableaux
// de résultats lisibles (triables). Remplace la grille brute de Comtrade.
import { esc } from "./format.js";

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

// Options minéraux, dédoublonnées depuis la table des codes HS6 et triées FR.
export function mineralOptions(labels) {
  return [...new Set(Object.values(labels.minerals).map((v) => v.mineral))]
    .sort((a, b) => a.localeCompare(b, "fr"))
    .map((m) => ({ value: m, label: m }));
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
