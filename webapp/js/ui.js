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

export function anneeOptions() {
  return ANNEES.map((y) => ({ value: y, label: String(y) })).reverse();
}

export function fluxOptions() {
  return [
    { value: "M", label: "Importations" },
    { value: "X", label: "Exportations" },
  ];
}

// Un bloc contrôle étiqueté (label + champ).
export function ctrl(labelText, innerHTML, grow = false) {
  return `<div class="ctrl${grow ? " grow" : ""}"><label>${esc(labelText)}</label>${innerHTML}</div>`;
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
