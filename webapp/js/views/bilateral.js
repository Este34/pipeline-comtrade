// Vue « Analyse bilatérale » : flux entre deux pays (A déclarant ↔ B partenaire),
// évolution 2000-2025 et principaux produits échangés.
import { query, srcDetail, sqlStr } from "../db.js";
import { fmtUSD, downloadCsv } from "../format.js";
import { chapitre, pays } from "../labels.js";
import {
  selectHTML, paysOptions, anneeOptions, fluxOptions, ctrl,
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
      <button class="btn" id="bl-go">Analyser</button>
    </div>
    <div id="bl-res"></div>`;

  const res = container.querySelector("#bl-res");

  async function analyser() {
    const a = container.querySelector("#bl-a").value;
    const b = container.querySelector("#bl-b").value;
    const annee = Number(container.querySelector("#bl-annee").value);
    const flux = container.querySelector("#bl-flux").value;
    res.innerHTML = `<div class="loading">Analyse en cours…</div>`;

    const A = sqlStr(a), B = sqlStr(b);
    const nomA = pays(labels, a), nomB = pays(labels, b);

    // Série temporelle M et X entre A et B (cmd TOTAL) sur toutes les années.
    const serie = await query(`
      SELECT period, flowCode, SUM(primaryValue) v FROM ${srcDetail(ANNEES)}
      WHERE reporterISO3 = ${A} AND partnerISO3 = ${B} AND cmdCode = 'TOTAL'
      GROUP BY period, flowCode ORDER BY period`);

    // Produits échangés pour l'année + flux choisis.
    const produits = await query(`
      SELECT cmdCode, SUM(primaryValue) v FROM ${srcDetail([annee])}
      WHERE reporterISO3 = ${A} AND partnerISO3 = ${B}
        AND flowCode = ${sqlStr(flux)} AND cmdCode <> 'TOTAL'
      GROUP BY cmdCode ORDER BY v DESC LIMIT 15`);

    // Réorganise la série par année.
    const parAnnee = new Map(ANNEES.map((y) => [y, { M: 0, X: 0 }]));
    for (const r of serie) if (parAnnee.has(r.period)) parAnnee.get(r.period)[r.flowCode] = r.v;
    const mArr = ANNEES.map((y) => parAnnee.get(y).M);
    const xArr = ANNEES.map((y) => parAnnee.get(y).X);
    const dernier = parAnnee.get(annee) || { M: 0, X: 0 };

    res.innerHTML = "";

    const kpiWrap = document.createElement("div");
    kpiWrap.innerHTML = kpisHTML(
      [
        { label: `Importations de ${nomA} depuis ${nomB} (${annee})`, value: fmtUSD(dernier.M) },
        { label: `Exportations de ${nomA} vers ${nomB} (${annee})`, value: fmtUSD(dernier.X) },
        { label: "Solde bilatéral", value: fmtUSD(dernier.X - dernier.M), cls: dernier.X - dernier.M >= 0 ? "pos" : "neg" },
      ],
      3
    );
    res.appendChild(kpiWrap);

    const cLine = card(`Évolution des échanges ${nomA} ↔ ${nomB} (2000–2025)`, "bl-serie");
    res.appendChild(cLine);
    lineChart(cLine.querySelector(".card-body"), ANNEES, [
      { label: `Importations (${nomA} ← ${nomB})`, data: mArr },
      { label: `Exportations (${nomA} → ${nomB})`, data: xArr },
    ]);

    const fluxLabel = flux === "M" ? "importés" : "exportés";
    const cProd = card(`Principaux produits ${fluxLabel} (${annee})`, "bl-prod");
    res.appendChild(cProd);
    barChart(
      cProd.querySelector(".card-body"),
      produits.map((r) => chapitre(labels, r.cmdCode)),
      produits.map((r) => r.v),
      "Valeur (US$)"
    );

    const cTable = card(`Détail produits ${fluxLabel} — ${nomA} ↔ ${nomB} (${annee})`, "bl-table");
    res.appendChild(cTable);
    const lignes = produits.map((r) => ({ code: r.cmdCode, produit: chapitre(labels, r.cmdCode), valeur: r.v }));
    renderTable(cTable.querySelector(".card-body"), [
      { key: "code", label: "Code HS" },
      { key: "produit", label: "Produit" },
      { key: "valeur", label: "Valeur", render: (r) => `<span>${fmtUSD(r.valeur)}</span>` },
    ], lignes);

    cLine.querySelector("[data-export]").addEventListener("click", () =>
      downloadCsv(`bilateral_${a}_${b}.csv`, ANNEES.map((y, i) => ({ annee: y, import_usd: Math.round(mArr[i]), export_usd: Math.round(xArr[i]) })))
    );
    cProd.querySelector("[data-export]").addEventListener("click", () =>
      downloadCsv(`produits_${a}_${b}_${annee}_${flux}.csv`, produits.map((r) => ({ code_hs: r.cmdCode, produit: chapitre(labels, r.cmdCode), valeur_usd: Math.round(r.v) })))
    );
    cTable.querySelector("[data-export]").addEventListener("click", () =>
      downloadCsv(`detail_${a}_${b}_${annee}_${flux}.csv`, lignes.map((l) => ({ ...l, valeur: Math.round(l.valeur) })))
    );
  }

  container.querySelector("#bl-go").addEventListener("click", analyser);
  await analyser();
}
