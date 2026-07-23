// Helpers de formatage et d'export, adaptés des utilitaires génériques du
// template-simulateur (formatage FR, échappement, export CSV).

const NF = new Intl.NumberFormat("fr-FR");

// Nombre formaté FR (séparateurs de milliers).
export function fmtNum(v) {
  if (v == null || Number.isNaN(v)) return "n.d.";
  return NF.format(Math.round(Number(v)));
}

// Valeur monétaire US$ en notation compacte lisible (Md / M / k).
export function fmtUSD(v) {
  if (v == null || Number.isNaN(v)) return "n.d.";
  const n = Number(v);
  const abs = Math.abs(n);
  if (abs >= 1e9) return (n / 1e9).toFixed(1).replace(".", ",") + " Md $";
  if (abs >= 1e6) return (n / 1e6).toFixed(1).replace(".", ",") + " M $";
  if (abs >= 1e3) return (n / 1e3).toFixed(1).replace(".", ",") + " k $";
  return NF.format(Math.round(n)) + " $";
}

// Poids (fourni en kg) en notation compacte lisible (t / kt / Mt).
// Un poids nul ou absent signifie « non rapporté » (le commerce réel a un poids
// non nul) : on l'affiche explicitement plutôt que « 0 kg ».
export function fmtTonnes(kg) {
  if (kg == null || Number.isNaN(kg) || Number(kg) <= 0) return "poids non déclaré";
  const t = Number(kg) / 1000;
  const abs = Math.abs(t);
  if (abs >= 1e6) return (t / 1e6).toFixed(1).replace(".", ",") + " Mt";
  if (abs >= 1e3) return (t / 1e3).toFixed(1).replace(".", ",") + " kt";
  if (abs >= 1) return t.toFixed(1).replace(".", ",") + " t";
  return NF.format(Math.round(Number(kg))) + " kg";
}

// Formate une valeur selon la métrique choisie ("valeur" en US$, "poids" en t).
export function fmtMetric(v, metric) {
  return metric === "poids" ? fmtTonnes(v) : fmtUSD(v);
}

// Formateur compact pour les axes de graphes selon la métrique.
export function axisFmt(metric) {
  if (metric === "poids") {
    return (kg) => {
      const t = kg / 1000;
      const a = Math.abs(t);
      if (a >= 1e6) return (t / 1e6).toFixed(0) + " Mt";
      if (a >= 1e3) return (t / 1e3).toFixed(0) + " kt";
      return t.toFixed(0) + " t";
    };
  }
  return (v) => {
    const a = Math.abs(v);
    if (a >= 1e9) return (v / 1e9).toFixed(0) + " Md";
    if (a >= 1e6) return (v / 1e6).toFixed(0) + " M";
    if (a >= 1e3) return (v / 1e3).toFixed(0) + " k";
    return String(v);
  };
}

// Pourcentage à une décimale.
export function pct(part, total) {
  if (!total) return "n.d.";
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
