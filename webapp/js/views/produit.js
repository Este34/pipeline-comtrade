// Vue « Analyse par produit » : pour un chapitre HS, classement des pays
// (exportateurs/importateurs) et évolution du commerce mondial.
import { query, srcDetail, sqlStr } from "../db.js";
import { fmtUSD, downloadCsv } from "../format.js";
import { chapitre, pays } from "../labels.js";
import {
  selectHTML, anneeOptions, fluxOptions, ctrl,
  renderTable, card, ANNEES,
} from "../ui.js";
import { barChart, lineChart } from "../charts.js";

function chapitreOptions(labels) {
  return Object.entries(labels.chapters)
    .filter(([k]) => k !== "TOTAL" && k !== "99")
    .map(([code, nom]) => ({ value: code, label: `${code} — ${nom}` }))
    .sort((a, b) => a.value.localeCompare(b.value));
}

export async function mount(container, { labels }) {
  container.innerHTML = `
    <div class="filterbar">
      ${ctrl("Produit (chapitre HS)", selectHTML("pr-cmd", chapitreOptions(labels), "27"), true)}
      ${ctrl("Année", selectHTML("pr-annee", anneeOptions(), 2023))}
      ${ctrl("Flux", selectHTML("pr-flux", fluxOptions(), "X"))}
      <button class="btn" id="pr-go">Analyser</button>
    </div>
    <div id="pr-res"></div>`;

  const res = container.querySelector("#pr-res");

  async function analyser() {
    const cmd = container.querySelector("#pr-cmd").value;
    const annee = Number(container.querySelector("#pr-annee").value);
    const flux = container.querySelector("#pr-flux").value;
    res.innerHTML = `<div class="loading">Analyse en cours…</div>`;

    const C = sqlStr(cmd), F = sqlStr(flux);
    const nomCmd = chapitre(labels, cmd);
    const fluxLabel = flux === "X" ? "exportateurs" : "importateurs";

    // Classement des pays pour ce chapitre (partenaire World = total par pays).
    const classement = await query(`
      SELECT reporterISO3, SUM(primaryValue) v FROM ${srcDetail([annee])}
      WHERE cmdCode = ${C} AND flowCode = ${F} AND partnerCode = '0'
        AND reporterISO3 IS NOT NULL
      GROUP BY reporterISO3 ORDER BY v DESC LIMIT 20`);

    // Évolution du commerce mondial de ce chapitre (somme des pays).
    const evolution = await query(`
      SELECT period, SUM(primaryValue) v FROM ${srcDetail(ANNEES)}
      WHERE cmdCode = ${C} AND flowCode = ${F} AND partnerCode = '0'
      GROUP BY period ORDER BY period`);

    const evoMap = new Map(evolution.map((r) => [r.period, r.v]));

    res.innerHTML = "";

    const cBar = card(`Top 20 ${fluxLabel} — ${nomCmd} (${annee})`, "pr-rank");
    res.appendChild(cBar);
    barChart(
      cBar.querySelector(".card-body"),
      classement.map((r) => pays(labels, r.reporterISO3)),
      classement.map((r) => r.v),
      "Valeur (US$)"
    );

    const cEvo = card(`Évolution du commerce mondial — ${nomCmd} (${flux === "X" ? "exportations" : "importations"})`, "pr-evo");
    res.appendChild(cEvo);
    lineChart(cEvo.querySelector(".card-body"), ANNEES, [
      { label: nomCmd, data: ANNEES.map((y) => evoMap.get(y) || 0) },
    ]);

    const cTable = card(`Classement détaillé — ${nomCmd} (${annee})`, "pr-table");
    res.appendChild(cTable);
    const total = classement.reduce((s, r) => s + r.v, 0);
    const lignes = classement.map((r, i) => ({
      rang: i + 1,
      pays: pays(labels, r.reporterISO3),
      iso3: r.reporterISO3,
      valeur: r.v,
      part: total ? (100 * r.v / total).toFixed(1).replace(".", ",") + " %" : "—",
    }));
    renderTable(cTable.querySelector(".card-body"), [
      { key: "rang", label: "Rang" },
      { key: "pays", label: "Pays" },
      { key: "valeur", label: "Valeur", render: (r) => `<span>${fmtUSD(r.valeur)}</span>` },
      { key: "part", label: "Part (top 20)" },
    ], lignes);

    cBar.querySelector("[data-export]").addEventListener("click", () =>
      downloadCsv(`classement_${cmd}_${annee}_${flux}.csv`, classement.map((r, i) => ({ rang: i + 1, pays: pays(labels, r.reporterISO3), iso3: r.reporterISO3, valeur_usd: Math.round(r.v) })))
    );
    cEvo.querySelector("[data-export]").addEventListener("click", () =>
      downloadCsv(`evolution_${cmd}_${flux}.csv`, ANNEES.map((y) => ({ annee: y, valeur_usd: Math.round(evoMap.get(y) || 0) })))
    );
    cTable.querySelector("[data-export]").addEventListener("click", () =>
      downloadCsv(`classement_detail_${cmd}_${annee}_${flux}.csv`, lignes.map((l) => ({ rang: l.rang, pays: l.pays, iso3: l.iso3, valeur_usd: Math.round(l.valeur) })))
    );
  }

  container.querySelector("#pr-go").addEventListener("click", analyser);
  await analyser();
}
