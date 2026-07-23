// Vue « Minéraux critiques » : pour un minéral (dataset HS6 dédié), pays
// producteurs/exportateurs, concentration des approvisionnements, évolution,
// et carte mondiale.
import { query, srcCritical, sqlStr } from "../db.js";
import { fmtUSD, pct, downloadCsv } from "../format.js";
import { pays } from "../labels.js";
import {
  selectHTML, anneeOptions, fluxOptions, ctrl, kpisHTML, renderTable, card, ANNEES,
} from "../ui.js";
import { barChart, lineChart, choropleth } from "../charts.js";

let _geo = null;
async function geo() {
  if (!_geo) _geo = await (await fetch("vendor/world.geo.json")).json();
  return _geo;
}

function mineralOptions(labels) {
  const uniques = [...new Set(Object.values(labels.minerals))].sort((a, b) => a.localeCompare(b, "fr"));
  return uniques.map((m) => ({ value: m, label: m }));
}

export async function mount(container, { labels }) {
  container.innerHTML = `
    <div class="filterbar">
      ${ctrl("Minéral critique", selectHTML("mc-min", mineralOptions(labels), "Lithium"), true)}
      ${ctrl("Année", selectHTML("mc-annee", anneeOptions(), 2023))}
      ${ctrl("Flux", selectHTML("mc-flux", fluxOptions(), "X"))}
      <button class="btn" id="mc-go">Analyser</button>
    </div>
    <div class="note">Données au niveau HS6 (codes douaniers précis). Un minéral regroupe plusieurs
      codes (minerai, oxyde, métal brut). « Concentration » = part cumulée des 5 premiers pays.</div>
    <div id="mc-res"></div>`;

  const res = container.querySelector("#mc-res");

  async function analyser() {
    const mineral = container.querySelector("#mc-min").value;
    const annee = Number(container.querySelector("#mc-annee").value);
    const flux = container.querySelector("#mc-flux").value;
    res.innerHTML = `<div class="loading">Analyse en cours…</div>`;

    const M = sqlStr(mineral), F = sqlStr(flux);
    const fluxLabel = flux === "X" ? "exportateurs" : "importateurs";

    // Classement pays (partenaire World = total par pays).
    const rows = await query(`
      SELECT reporterISO3, SUM(primaryValue) v FROM ${srcCritical([annee])}
      WHERE mineral = ${M} AND flowCode = ${F} AND partnerCode = '0'
        AND reporterISO3 IS NOT NULL
      GROUP BY reporterISO3 ORDER BY v DESC`);

    // Évolution mondiale.
    const evo = await query(`
      SELECT period, SUM(primaryValue) v FROM ${srcCritical(ANNEES)}
      WHERE mineral = ${M} AND flowCode = ${F} AND partnerCode = '0'
      GROUP BY period ORDER BY period`);
    const evoMap = new Map(evo.map((r) => [r.period, r.v]));

    const total = rows.reduce((s, r) => s + r.v, 0);
    const top5 = rows.slice(0, 5).reduce((s, r) => s + r.v, 0);

    res.innerHTML = "";

    const kpiWrap = document.createElement("div");
    kpiWrap.innerHTML = kpisHTML(
      [
        { label: `Commerce mondial ${flux === "X" ? "(export)" : "(import)"} ${annee}`, value: fmtUSD(total) },
        { label: "Nombre de pays actifs", value: String(rows.length) },
        { label: "Concentration (top 5)", value: pct(top5, total), cls: top5 / total > 0.7 ? "neg" : "" },
      ],
      3
    );
    res.appendChild(kpiWrap);

    const top = rows.slice(0, 20);
    const cBar = card(`Top 20 ${fluxLabel} — ${mineral} (${annee})`, "mc-rank");
    res.appendChild(cBar);
    barChart(
      cBar.querySelector(".card-body"),
      top.map((r) => pays(labels, r.reporterISO3)),
      top.map((r) => r.v),
      "Valeur (US$)"
    );

    const cMap = card(`Carte mondiale — ${mineral} (${annee})`, "mc-map");
    res.appendChild(cMap);
    choropleth(cMap.querySelector(".card-body"), await geo(), new Map(rows.map((r) => [r.reporterISO3, r.v])), (iso3) => pays(labels, iso3));

    const cEvo = card(`Évolution mondiale — ${mineral}`, "mc-evo");
    res.appendChild(cEvo);
    lineChart(cEvo.querySelector(".card-body"), ANNEES, [{ label: mineral, data: ANNEES.map((y) => evoMap.get(y) || 0) }]);

    const cTable = card(`Classement détaillé — ${mineral} (${annee})`, "mc-table");
    res.appendChild(cTable);
    const lignes = top.map((r, i) => ({
      rang: i + 1,
      pays: pays(labels, r.reporterISO3),
      iso3: r.reporterISO3,
      valeur: r.v,
      part: pct(r.v, total),
    }));
    renderTable(cTable.querySelector(".card-body"), [
      { key: "rang", label: "Rang" },
      { key: "pays", label: "Pays" },
      { key: "valeur", label: "Valeur", render: (r) => `<span>${fmtUSD(r.valeur)}</span>` },
      { key: "part", label: "Part mondiale" },
    ], lignes);

    cBar.querySelector("[data-export]").addEventListener("click", () =>
      downloadCsv(`mineral_${mineral}_${annee}_${flux}.csv`, rows.map((r, i) => ({ rang: i + 1, pays: pays(labels, r.reporterISO3), iso3: r.reporterISO3, valeur_usd: Math.round(r.v) })))
    );
    cEvo.querySelector("[data-export]").addEventListener("click", () =>
      downloadCsv(`mineral_evolution_${mineral}_${flux}.csv`, ANNEES.map((y) => ({ annee: y, valeur_usd: Math.round(evoMap.get(y) || 0) })))
    );
    cMap.querySelector("[data-export]").addEventListener("click", () =>
      downloadCsv(`mineral_carte_${mineral}_${annee}_${flux}.csv`, rows.map((r) => ({ pays: pays(labels, r.reporterISO3), iso3: r.reporterISO3, valeur_usd: Math.round(r.v) })))
    );
    cTable.querySelector("[data-export]").addEventListener("click", () =>
      downloadCsv(`mineral_detail_${mineral}_${annee}_${flux}.csv`, lignes.map((l) => ({ rang: l.rang, pays: l.pays, iso3: l.iso3, valeur_usd: Math.round(l.valeur), part: l.part })))
    );
  }

  container.querySelector("#mc-go").addEventListener("click", analyser);
  await analyser();
}
