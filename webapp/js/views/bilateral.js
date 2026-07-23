// Vue « Analyse bilatérale » : flux entre deux pays (A déclarant ↔ B partenaire),
// évolution 2000-2025 et principaux produits échangés.
import { query, srcDetail, sqlStr } from "../db.js";
import { fmtMetric, axisFmt, downloadCsv } from "../format.js";
import { chapitre, pays } from "../labels.js";
import {
  selectHTML, paysOptions, anneeOptions, fluxOptions, metricOptions, ctrl,
  kpisHTML, renderTable, card, ANNEES,
} from "../ui.js";
import { lineChart, barChart } from "../charts.js";

export async function mount(container, { labels }) {
  container.innerHTML = `
    <div class="filterbar">
      ${ctrl("Pays déclarant (A)", selectHTML("bl-a", paysOptions(labels), "FRA"), true)}
      ${ctrl("Pays partenaire (B)", selectHTML("bl-b", paysOptions(labels), "DEU"), true)}
      ${ctrl("Année (produits)", selectHTML("bl-annee", anneeOptions(), 2023))}
      ${ctrl("Flux (produits)", selectHTML("bl-flux", fluxOptions(), "M"))}
      ${ctrl("Mesure", selectHTML("bl-metric", metricOptions(), "valeur"))}
      <button class="btn" id="bl-go">Analyser</button>
    </div>
    <div id="bl-res"></div>`;

  const res = container.querySelector("#bl-res");

  async function analyser() {
    const a = container.querySelector("#bl-a").value;
    const b = container.querySelector("#bl-b").value;
    const annee = Number(container.querySelector("#bl-annee").value);
    const flux = container.querySelector("#bl-flux").value;
    const metric = container.querySelector("#bl-metric").value;
    res.innerHTML = `<div class="loading">Analyse en cours…</div>`;

    const A = sqlStr(a), B = sqlStr(b);
    const nomA = pays(labels, a), nomB = pays(labels, b);
    const fmt = axisFmt(metric);
    const disp = (v) => fmtMetric(v, metric);

    // Série temporelle M et X entre A et B (cmd TOTAL) sur toutes les années.
    const serie = await query(`
      SELECT period, flowCode, SUM(primaryValue) valeur, SUM(netWgt) poids FROM ${srcDetail(ANNEES)}
      WHERE reporterISO3 = ${A} AND partnerISO3 = ${B} AND cmdCode = 'TOTAL'
      GROUP BY period, flowCode ORDER BY period`);

    // Produits échangés pour l'année + flux choisis.
    const produits = await query(`
      SELECT cmdCode, SUM(primaryValue) valeur, SUM(netWgt) poids FROM ${srcDetail([annee])}
      WHERE reporterISO3 = ${A} AND partnerISO3 = ${B}
        AND flowCode = ${sqlStr(flux)} AND cmdCode <> 'TOTAL'
      GROUP BY cmdCode ORDER BY ${metric} DESC NULLS LAST LIMIT 15`);

    // Réorganise la série par année.
    const parAnnee = new Map(ANNEES.map((y) => [y, { M: 0, X: 0 }]));
    for (const r of serie) if (parAnnee.has(r.period)) parAnnee.get(r.period)[r.flowCode] = r[metric] || 0;
    const mArr = ANNEES.map((y) => parAnnee.get(y).M);
    const xArr = ANNEES.map((y) => parAnnee.get(y).X);
    const dernier = parAnnee.get(annee) || { M: 0, X: 0 };

    res.innerHTML = "";

    const kpiWrap = document.createElement("div");
    kpiWrap.innerHTML = kpisHTML(
      [
        { label: `Importations de ${nomA} depuis ${nomB} (${annee})`, value: disp(dernier.M) },
        { label: `Exportations de ${nomA} vers ${nomB} (${annee})`, value: disp(dernier.X) },
        { label: "Solde bilatéral", value: disp(dernier.X - dernier.M), cls: dernier.X - dernier.M >= 0 ? "pos" : "neg" },
      ],
      3
    );
    res.appendChild(kpiWrap);

    const cLine = card(`Évolution des échanges ${nomA} ↔ ${nomB} (2000–2025)`, "bl-serie");
    res.appendChild(cLine);
    lineChart(cLine.querySelector(".card-body"), ANNEES, [
      { label: `Importations (${nomA} ← ${nomB})`, data: mArr },
      { label: `Exportations (${nomA} → ${nomB})`, data: xArr },
    ], fmt);

    const fluxLabel = flux === "M" ? "importés" : "exportés";
    const cProd = card(`Principaux produits ${fluxLabel} (${annee})`, "bl-prod");
    res.appendChild(cProd);
    barChart(
      cProd.querySelector(".card-body"),
      produits.map((r) => chapitre(labels, r.cmdCode)),
      produits.map((r) => r[metric] || 0),
      metric === "poids" ? "Poids" : "Valeur",
      fmt
    );

    const cTable = card(`Détail produits ${fluxLabel} — ${nomA} ↔ ${nomB} (${annee})`, "bl-table");
    res.appendChild(cTable);
    renderTable(cTable.querySelector(".card-body"), [
      { key: "code", label: "Code HS" },
      { key: "produit", label: "Produit" },
      { key: "mesure", label: metric === "poids" ? "Poids" : "Valeur", render: (r) => `<span>${disp(r.mesure)}</span>` },
    ], produits.map((r) => ({ code: r.cmdCode, produit: chapitre(labels, r.cmdCode), mesure: r[metric] })));

    cLine.querySelector("[data-export]").addEventListener("click", () =>
      downloadCsv(`bilateral_${a}_${b}.csv`, ANNEES.map((y) => {
        const rM = serie.find((s) => s.period === y && s.flowCode === "M");
        const rX = serie.find((s) => s.period === y && s.flowCode === "X");
        return { annee: y, import_usd: Math.round(rM?.valeur || 0), import_kg: Math.round(rM?.poids || 0), export_usd: Math.round(rX?.valeur || 0), export_kg: Math.round(rX?.poids || 0) };
      }))
    );
    cProd.querySelector("[data-export]").addEventListener("click", () =>
      downloadCsv(`produits_${a}_${b}_${annee}_${flux}.csv`, produits.map((r) => ({ code_hs: r.cmdCode, produit: chapitre(labels, r.cmdCode), valeur_usd: Math.round(r.valeur || 0), poids_kg: Math.round(r.poids || 0) })))
    );
    cTable.querySelector("[data-export]").addEventListener("click", () =>
      downloadCsv(`detail_${a}_${b}_${annee}_${flux}.csv`, produits.map((r) => ({ code_hs: r.cmdCode, produit: chapitre(labels, r.cmdCode), valeur_usd: Math.round(r.valeur || 0), poids_kg: Math.round(r.poids || 0) })))
    );
  }

  container.querySelector("#bl-go").addEventListener("click", analyser);
  await analyser();
}
