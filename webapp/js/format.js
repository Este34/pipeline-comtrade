// Helpers de formatage et d'export — adaptés des utilitaires génériques du
// template-simulateur (formatage FR, échappement, export CSV).

const NF = new Intl.NumberFormat("fr-FR");

// Nombre formaté FR (séparateurs de milliers).
export function fmtNum(v) {
  if (v == null || Number.isNaN(v)) return "—";
  return NF.format(Math.round(Number(v)));
}

// Valeur monétaire US$ en notation compacte lisible (Md / M / k).
export function fmtUSD(v) {
  if (v == null || Number.isNaN(v)) return "—";
  const n = Number(v);
  const abs = Math.abs(n);
  if (abs >= 1e9) return (n / 1e9).toFixed(1).replace(".", ",") + " Md $";
  if (abs >= 1e6) return (n / 1e6).toFixed(1).replace(".", ",") + " M $";
  if (abs >= 1e3) return (n / 1e3).toFixed(1).replace(".", ",") + " k $";
  return NF.format(Math.round(n)) + " $";
}

// Pourcentage à une décimale.
export function pct(part, total) {
  if (!total) return "—";
  return (100 * part / total).toFixed(1).replace(".", ",") + " %";
}

// Échappement HTML (anti-XSS sur données injectées).
export function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// --- Export CSV générique ---

function csvCell(v) {
  const s = String(v ?? "");
  return /[",;\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// Télécharge un tableau d'objets en CSV (BOM UTF-8, séparateur ;).
export function downloadCsv(filename, rows, colonnes) {
  if (!rows.length) return;
  const cols = colonnes || Object.keys(rows[0]);
  const lignes = [cols.map(csvCell).join(";")];
  for (const r of rows) lignes.push(cols.map((c) => csvCell(r[c])).join(";"));
  const blob = new Blob(["﻿" + lignes.join("\r\n")], {
    type: "text/csv;charset=utf-8;",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
