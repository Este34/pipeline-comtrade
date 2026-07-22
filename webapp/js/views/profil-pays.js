// Vue « Profil pays » : pour un pays + une année, synthèse import/export,
// balance, top partenaires et top produits (chapitres HS).
import { query, srcDetail, srcAggregat, sqlStr } from "../db.js";
import { fmtUSD, esc, downloadCsv } from "../format.js";
import { chapitre, pays } from "../labels.js";
import {
  selectHTML, paysOptions, anneeOptions, fluxOptions, ctrl,
  kpisHTML, renderTable, card,
} from "../ui.js";
import { barChart } from "../charts.js";

export async function mount(container, { labels }) {
  container.innerHTML = `
    <div class="filterbar">
      ${ctrl("Pays déclarant", selectHTML("pf-pays", paysOptions(labels), "FRA"), true)}
      ${ctrl("Année", selectHTML("pf-annee", anneeOptions(), 2023))}
      ${ctrl("Flux (détails)", selectHTML("pf-flux", fluxOptions(), "M"))}
      <button class="btn" id="pf-go">Analyser</button>
    </div>
    <div id="pf-res"></div>`;

  const go = container.querySelector("#pf-go");
  const res = container.querySelector("#pf-res");

  async function analyser() {
    const iso3 = container.querySelector("#pf-pays").value;
    const annee = Number(container.querySelector("#pf-annee").value);
    const flux = container.querySelector("#pf-flux").value;
    res.innerHTML = `<div class="loading">Analyse en cours…</div>`;

    const AGG = srcAggregat();
    const DET = srcDetail([annee]);
    const R = sqlStr(iso3);

    // KPIs (imports + exports totaux) depuis l'agrégat World/TOTAL.
    const totaux = await query(`
      SELECT flowCode, SUM(primaryValue) v FROM ${AGG}
      WHERE reporterISO3 = ${R} AND period = ${annee}
        AND partnerCode = '0' AND cmdCode = 'TOTAL'
      GROUP BY flowCode`);
    const totM = totaux.find((r) => r.flowCode === "M")?.v || 0;
    const totX = totaux.find((r) => r.flowCode === "X")?.v || 0;
    const balance = totX - totM;

    // Top partenaires pour le flux choisi (cmd TOTAL, hors World).
    const partenaires = await query(`
      SELECT partnerISO3, SUM(primaryValue) v FROM ${DET}
      WHERE reporterISO3 = ${R} AND flowCode = ${sqlStr(flux)}
        AND cmdCode = 'TOTAL' AND partnerCode <> '0'
      GROUP BY partnerISO3 ORDER BY v DESC LIMIT 15`);

    // Top produits (chapitres HS) pour le flux choisi (partenaire World).
    const produits = await query(`
      SELECT cmdCode, SUM(primaryValue) v FROM ${DET}
      WHERE reporterISO3 = ${R} AND flowCode = ${sqlStr(flux)}
        AND cmdCode <> 'TOTAL' AND partnerCode = '0'
      GROUP BY cmdCode ORDER BY v DESC LIMIT 15`);

    const nomPays = pays(labels, iso3);
    const fluxLabel = flux === "M" ? "importations" : "exportations";

    res.innerHTML = "";

    // KPIs
    const kpiWrap = document.createElement("div");
    kpiWrap.innerHTML = kpisHTML(
      [
        { label: "Importations (total)", value: fmtUSD(totM) },
        { label: "Exportations (total)", value: fmtUSD(totX) },
        {
          label: "Balance commerciale",
          value: fmtUSD(balance),
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

    const cPart = card(`Top partenaires — ${fluxLabel} de ${nomPays} (${annee})`, "pf-part");
    grid.appendChild(cPart);
    barChart(
      cPart.querySelector(".card-body"),
      partenaires.map((r) => pays(labels, r.partnerISO3)),
      partenaires.map((r) => r.v),
      "Valeur (US$)"
    );

    const cProd = card(`Top produits (chapitres HS) — ${fluxLabel} (${annee})`, "pf-prod");
    grid.appendChild(cProd);
    barChart(
      cProd.querySelector(".card-body"),
      produits.map((r) => chapitre(labels, r.cmdCode)),
      produits.map((r) => r.v),
      "Valeur (US$)"
    );

    // Tableau détaillé lisible des produits (remplace la grille brute Comtrade)
    const cTable = card(`Détail par produit — ${fluxLabel} de ${nomPays} (${annee})`, "pf-table");
    res.appendChild(cTable);
    const lignes = produits.map((r) => ({
      code: r.cmdCode,
      produit: chapitre(labels, r.cmdCode),
      valeur: r.v,
    }));
    renderTable(cTable.querySelector(".card-body"), [
      { key: "code", label: "Code HS" },
      { key: "produit", label: "Produit" },
      { key: "valeur", label: "Valeur", render: (r) => `<span>${fmtUSD(r.valeur)}</span>` },
    ], lignes);

    // Exports CSV
    cPart.querySelector("[data-export]").addEventListener("click", () =>
      downloadCsv(
        `partenaires_${iso3}_${annee}_${flux}.csv`,
        partenaires.map((r) => ({ partenaire: pays(labels, r.partnerISO3), iso3: r.partnerISO3, valeur_usd: Math.round(r.v) }))
      )
    );
    cProd.querySelector("[data-export]").addEventListener("click", () =>
      downloadCsv(
        `produits_${iso3}_${annee}_${flux}.csv`,
        produits.map((r) => ({ code_hs: r.cmdCode, produit: chapitre(labels, r.cmdCode), valeur_usd: Math.round(r.v) }))
      )
    );
    cTable.querySelector("[data-export]").addEventListener("click", () =>
      downloadCsv(`detail_produits_${iso3}_${annee}_${flux}.csv`, lignes.map((l) => ({ ...l, valeur: Math.round(l.valeur) })))
    );
  }

  go.addEventListener("click", analyser);
  await analyser();
}
