// Vue « Profil pays » : pour un pays + une année, synthèse import/export,
// balance, top partenaires et top produits (chapitres HS).
import { query, srcDetail, srcAggregat, sqlStr } from "../db.js";
import { fmtMetric, axisFmt, downloadCsv } from "../format.js";
import { chapitre, pays } from "../labels.js";
import {
  selectHTML, comboHTML, wireCombo, paysOptions, anneeOptions, fluxOptions, metricOptions,
  ctrl, kpisHTML, renderTable, card, renderChips, skeletonKpis,
} from "../ui.js";
import { barChart } from "../charts.js";

export async function mount(container, { labels }) {
  container.innerHTML = `
    <div class="filterbar">
      ${ctrl("Pays déclarant", comboHTML("pf-pays", "Rechercher un pays..."), true)}
      ${ctrl("Année", selectHTML("pf-annee", anneeOptions(), 2023))}
      ${ctrl("Flux (détails)", selectHTML("pf-flux", fluxOptions(), "M"))}
      ${ctrl("Mesure", selectHTML("pf-metric", metricOptions(), "valeur"))}
      <button class="btn" id="pf-go">Analyser</button>
    </div>
    <div class="chips" id="pf-chips" aria-label="Filtres actifs"></div>
    <div id="pf-res"></div>`;

  const go = container.querySelector("#pf-go");
  const res = container.querySelector("#pf-res");
  const chipsEl = container.querySelector("#pf-chips");
  const combo = wireCombo("pf-pays", paysOptions(labels), { value: "FRA" });

  function annee() { return document.getElementById("pf-annee"); }
  function flux() { return document.getElementById("pf-flux"); }
  function metric() { return document.getElementById("pf-metric"); }

  function majChips() {
    renderChips(chipsEl, [
      { label: "Pays", value: pays(labels, combo.value), onReset: () => { combo.set("FRA"); analyser(); } },
      { label: "Année", value: annee().value, onReset: () => { annee().value = "2023"; analyser(); } },
      { label: "Flux", value: flux().options[flux().selectedIndex].text, onReset: () => { flux().value = "M"; analyser(); } },
      { label: "Mesure", value: metric().options[metric().selectedIndex].text, onReset: () => { metric().value = "valeur"; analyser(); } },
    ]);
  }

  async function analyser() {
    const iso3 = combo.value;
    const an = Number(annee().value);
    const fx = flux().value;
    const mt = metric().value;
    majChips();
    res.innerHTML = "";
    skeletonKpis(res, 3);

    const AGG = srcAggregat();
    const DET = srcDetail([an]);
    const R = sqlStr(iso3);
    const fmt = axisFmt(mt);
    const disp = (v) => fmtMetric(v, mt);

    // Les trois requêtes sont indépendantes : lancées ensemble, la vue attend la
    // plus lente au lieu de la somme des trois.
    const [totaux, partenaires, produits] = await Promise.all([
      // KPIs (imports + exports totaux) depuis l'agrégat World/TOTAL.
      query(`
      SELECT flowCode, SUM(primaryValue) valeur, SUM(netWgt) poids FROM ${AGG}
      WHERE reporterISO3 = ${R} AND period = ${an}
        AND partnerCode = '0' AND cmdCode = 'TOTAL'
      GROUP BY flowCode`),
      // Top partenaires pour le flux choisi (cmd TOTAL, hors World).
      query(`
      SELECT partnerISO3, SUM(primaryValue) valeur, SUM(netWgt) poids FROM ${DET}
      WHERE reporterISO3 = ${R} AND flowCode = ${sqlStr(fx)}
        AND cmdCode = 'TOTAL' AND partnerCode <> '0'
      GROUP BY partnerISO3 ORDER BY ${mt} DESC NULLS LAST LIMIT 15`),
      // Top produits (chapitres HS) pour le flux choisi (partenaire World).
      query(`
      SELECT cmdCode, SUM(primaryValue) valeur, SUM(netWgt) poids FROM ${DET}
      WHERE reporterISO3 = ${R} AND flowCode = ${sqlStr(fx)}
        AND cmdCode <> 'TOTAL' AND partnerCode = '0'
      GROUP BY cmdCode ORDER BY ${mt} DESC NULLS LAST LIMIT 15`),
    ]);
    const totM = totaux.find((r) => r.flowCode === "M")?.[mt] || 0;
    const totX = totaux.find((r) => r.flowCode === "X")?.[mt] || 0;
    const balance = totX - totM;

    const nomPays = pays(labels, iso3);
    const fluxLabel = fx === "M" ? "importations" : "exportations";

    res.innerHTML = "";

    // KPIs
    const kpiWrap = document.createElement("div");
    kpiWrap.innerHTML = kpisHTML(
      [
        { label: "Importations (total)", value: disp(totM) },
        { label: "Exportations (total)", value: disp(totX) },
        {
          label: mt === "poids" ? "Solde net (poids)" : "Balance commerciale",
          value: disp(balance),
          cls: balance >= 0 ? "pos" : "neg",
        },
      ],
      3
    );
    res.appendChild(kpiWrap);

    // Deux colonnes : partenaires / produits
    const grid = document.createElement("div");
    grid.className = "grid2";
    res.appendChild(grid);

    const cPart = card(`Top partenaires : ${fluxLabel} de ${nomPays} (${an})`, "pf-part");
    grid.appendChild(cPart);
    barChart(
      cPart.querySelector(".card-body"),
      partenaires.map((r) => pays(labels, r.partnerISO3)),
      partenaires.map((r) => r[mt] || 0),
      mt === "poids" ? "Poids" : "Valeur",
      fmt
    );

    const cProd = card(`Top produits (chapitres HS) : ${fluxLabel} (${an})`, "pf-prod");
    grid.appendChild(cProd);
    barChart(
      cProd.querySelector(".card-body"),
      produits.map((r) => chapitre(labels, r.cmdCode)),
      produits.map((r) => r[mt] || 0),
      mt === "poids" ? "Poids" : "Valeur",
      fmt
    );

    // Tableau détaillé lisible des produits (remplace la grille brute Comtrade)
    const cTable = card(`Détail par produit : ${fluxLabel} de ${nomPays} (${an})`, "pf-table");
    res.appendChild(cTable);
    const lignes = produits.map((r) => ({
      code: r.cmdCode,
      produit: chapitre(labels, r.cmdCode),
      mesure: r[mt],
    }));
    renderTable(cTable.querySelector(".card-body"), [
      { key: "code", label: "Code HS" },
      { key: "produit", label: "Produit" },
      { key: "mesure", label: mt === "poids" ? "Poids" : "Valeur", render: (r) => `<span>${disp(r.mesure)}</span>` },
    ], lignes);

    // Exports CSV (les deux mesures pour ne rien perdre)
    cPart.querySelector("[data-export]").addEventListener("click", () =>
      downloadCsv(
        `partenaires_${iso3}_${an}_${fx}.csv`,
        partenaires.map((r) => ({ partenaire: pays(labels, r.partnerISO3), iso3: r.partnerISO3, valeur_usd: Math.round(r.valeur || 0), poids_kg: Math.round(r.poids || 0) }))
      )
    );
    cProd.querySelector("[data-export]").addEventListener("click", () =>
      downloadCsv(
        `produits_${iso3}_${an}_${fx}.csv`,
        produits.map((r) => ({ code_hs: r.cmdCode, produit: chapitre(labels, r.cmdCode), valeur_usd: Math.round(r.valeur || 0), poids_kg: Math.round(r.poids || 0) }))
      )
    );
    cTable.querySelector("[data-export]").addEventListener("click", () =>
      downloadCsv(`detail_produits_${iso3}_${an}_${fx}.csv`, produits.map((r) => ({ code_hs: r.cmdCode, produit: chapitre(labels, r.cmdCode), valeur_usd: Math.round(r.valeur || 0), poids_kg: Math.round(r.poids || 0) })))
    );
  }

  go.addEventListener("click", analyser);
  combo.onChange(analyser);
  ["pf-annee", "pf-flux", "pf-metric"].forEach((id) => document.getElementById(id).addEventListener("change", majChips));

  // Palette de commandes : « Ouvrir le profil de X » atterrit ici.
  window.addEventListener("comtrade:open-country", (e) => {
    combo.set(e.detail.iso3);
    analyser();
  });

  await analyser();
}
