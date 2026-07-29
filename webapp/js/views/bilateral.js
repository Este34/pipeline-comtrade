// Vue « Analyse bilatérale » : flux entre deux pays (A déclarant ↔ B partenaire),
// évolution 2000-2025 et principaux produits échangés.
import { query, srcAggregat, srcDetail, sqlStr } from "../db.js";
import { fmtMetric, axisFmt, downloadCsv } from "../format.js";
import { chapitre, pays } from "../labels.js";
import {
  selectHTML, comboHTML, wireCombo, paysOptions, anneeOptions, fluxOptions, metricOptions, ctrl,
  kpisHTML, renderTable, card, renderChips, skeletonKpis, ANNEES,
} from "../ui.js";
import { lineChart, barChart } from "../charts.js";

export async function mount(container, { labels }) {
  container.innerHTML = `
    <div class="filterbar">
      ${ctrl("Pays déclarant (A)", comboHTML("bl-a", "Rechercher un pays..."), true)}
      ${ctrl("Pays partenaire (B)", comboHTML("bl-b", "Rechercher un pays..."), true)}
      ${ctrl("Année (produits)", selectHTML("bl-annee", anneeOptions(), 2023))}
      ${ctrl("Flux (produits)", selectHTML("bl-flux", fluxOptions(), "M"))}
      ${ctrl("Mesure", selectHTML("bl-metric", metricOptions(), "valeur"))}
      <button class="btn" id="bl-go">Analyser</button>
    </div>
    <div class="chips" id="bl-chips" aria-label="Filtres actifs"></div>
    <div id="bl-res"></div>`;

  const res = container.querySelector("#bl-res");
  const chipsEl = container.querySelector("#bl-chips");
  const comboA = wireCombo("bl-a", paysOptions(labels), { value: "FRA" });
  const comboB = wireCombo("bl-b", paysOptions(labels), { value: "DEU" });

  function annee() { return document.getElementById("bl-annee"); }
  function flux() { return document.getElementById("bl-flux"); }
  function metric() { return document.getElementById("bl-metric"); }

  function majChips() {
    renderChips(chipsEl, [
      { label: "Pays A", value: pays(labels, comboA.value), onReset: () => { comboA.set("FRA"); analyser(); } },
      { label: "Pays B", value: pays(labels, comboB.value), onReset: () => { comboB.set("DEU"); analyser(); } },
      { label: "Année", value: annee().value, onReset: () => { annee().value = "2023"; analyser(); } },
      { label: "Flux", value: flux().options[flux().selectedIndex].text, onReset: () => { flux().value = "M"; analyser(); } },
      { label: "Mesure", value: metric().options[metric().selectedIndex].text, onReset: () => { metric().value = "valeur"; analyser(); } },
    ]);
  }

  async function analyser() {
    const a = comboA.value;
    const b = comboB.value;
    const an = Number(annee().value);
    const fx = flux().value;
    const mt = metric().value;
    majChips();
    res.innerHTML = "";
    skeletonKpis(res, 3);

    const A = sqlStr(a), B = sqlStr(b);
    const nomA = pays(labels, a), nomB = pays(labels, b);
    const fmt = axisFmt(mt);
    const disp = (v) => fmtMetric(v, mt);

    // Deux requêtes indépendantes, lancées ensemble :
    //  - la série temporelle M/X entre A et B (cmd TOTAL, toutes années), lue sur
    //    l'agrégat où figurent les lignes cmdCode='TOTAL' : un fichier unique, là
    //    où le détail imposait d'ouvrir les 26 partitions annuelles ;
    //  - les produits échangés pour l'année et le flux choisis, qui exigent le
    //    couple bilatéral complet et restent donc sur le détail d'une seule année.
    const [serie, produits] = await Promise.all([
      query(`
      SELECT period, flowCode, SUM(primaryValue) valeur, SUM(netWgt) poids FROM ${srcAggregat()}
      WHERE reporterISO3 = ${A} AND partnerISO3 = ${B} AND cmdCode = 'TOTAL'
      GROUP BY period, flowCode ORDER BY period`),
      query(`
      SELECT cmdCode, SUM(primaryValue) valeur, SUM(netWgt) poids FROM ${srcDetail([an])}
      WHERE reporterISO3 = ${A} AND partnerISO3 = ${B}
        AND flowCode = ${sqlStr(fx)} AND cmdCode <> 'TOTAL'
      GROUP BY cmdCode ORDER BY ${mt} DESC NULLS LAST LIMIT 15`),
    ]);

    // Réorganise la série par année.
    const parAnnee = new Map(ANNEES.map((y) => [y, { M: 0, X: 0 }]));
    for (const r of serie) if (parAnnee.has(r.period)) parAnnee.get(r.period)[r.flowCode] = r[mt] || 0;
    const mArr = ANNEES.map((y) => parAnnee.get(y).M);
    const xArr = ANNEES.map((y) => parAnnee.get(y).X);
    const dernier = parAnnee.get(an) || { M: 0, X: 0 };

    res.innerHTML = "";

    const kpiWrap = document.createElement("div");
    kpiWrap.innerHTML = kpisHTML(
      [
        { label: `Importations de ${nomA} depuis ${nomB} (${an})`, value: disp(dernier.M) },
        { label: `Exportations de ${nomA} vers ${nomB} (${an})`, value: disp(dernier.X) },
        { label: "Solde bilatéral", value: disp(dernier.X - dernier.M), cls: dernier.X - dernier.M >= 0 ? "pos" : "neg" },
      ],
      3
    );
    res.appendChild(kpiWrap);

    const cLine = card(`Évolution des échanges entre ${nomA} et ${nomB} (2000 à 2025)`, "bl-serie");
    res.appendChild(cLine);
    lineChart(cLine.querySelector(".card-body"), ANNEES, [
      { label: `Importations (${nomA} depuis ${nomB})`, data: mArr },
      { label: `Exportations (${nomA} vers ${nomB})`, data: xArr },
    ], fmt);

    const fluxLabel = fx === "M" ? "importés" : "exportés";
    const cProd = card(`Principaux produits ${fluxLabel} (${an})`, "bl-prod");
    res.appendChild(cProd);
    barChart(
      cProd.querySelector(".card-body"),
      produits.map((r) => chapitre(labels, r.cmdCode)),
      produits.map((r) => r[mt] || 0),
      mt === "poids" ? "Poids" : "Valeur",
      fmt
    );

    const cTable = card(`Détail produits ${fluxLabel} entre ${nomA} et ${nomB} (${an})`, "bl-table");
    res.appendChild(cTable);
    renderTable(cTable.querySelector(".card-body"), [
      { key: "code", label: "Code HS" },
      { key: "produit", label: "Produit" },
      { key: "mesure", label: mt === "poids" ? "Poids" : "Valeur", render: (r) => `<span>${disp(r.mesure)}</span>` },
    ], produits.map((r) => ({ code: r.cmdCode, produit: chapitre(labels, r.cmdCode), mesure: r[mt] })));

    cLine.querySelector("[data-export]").addEventListener("click", () =>
      downloadCsv(`bilateral_${a}_${b}.csv`, ANNEES.map((y) => {
        const rM = serie.find((s) => s.period === y && s.flowCode === "M");
        const rX = serie.find((s) => s.period === y && s.flowCode === "X");
        return { annee: y, import_usd: Math.round(rM?.valeur || 0), import_kg: Math.round(rM?.poids || 0), export_usd: Math.round(rX?.valeur || 0), export_kg: Math.round(rX?.poids || 0) };
      }))
    );
    cProd.querySelector("[data-export]").addEventListener("click", () =>
      downloadCsv(`produits_${a}_${b}_${an}_${fx}.csv`, produits.map((r) => ({ code_hs: r.cmdCode, produit: chapitre(labels, r.cmdCode), valeur_usd: Math.round(r.valeur || 0), poids_kg: Math.round(r.poids || 0) })))
    );
    cTable.querySelector("[data-export]").addEventListener("click", () =>
      downloadCsv(`detail_${a}_${b}_${an}_${fx}.csv`, produits.map((r) => ({ code_hs: r.cmdCode, produit: chapitre(labels, r.cmdCode), valeur_usd: Math.round(r.valeur || 0), poids_kg: Math.round(r.poids || 0) })))
    );
  }

  container.querySelector("#bl-go").addEventListener("click", analyser);
  comboA.onChange(analyser);
  comboB.onChange(analyser);
  ["bl-annee", "bl-flux", "bl-metric"].forEach((id) => document.getElementById(id).addEventListener("change", majChips));

  await analyser();
}
