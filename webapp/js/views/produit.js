// Vue « Analyse par produit » : pour un chapitre HS, classement des pays
// (exportateurs/importateurs) et évolution du commerce mondial.
import { query, srcDetail, sqlStr } from "../db.js";
import { fmtMetric, axisFmt, pct, downloadCsv } from "../format.js";
import { chapitre, pays } from "../labels.js";
import {
  selectHTML, anneeOptions, fluxOptions, metricOptions, ctrl,
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
      ${ctrl("Mesure", selectHTML("pr-metric", metricOptions(), "valeur"))}
      <button class="btn" id="pr-go">Analyser</button>
    </div>
    <div id="pr-res"></div>`;

  const res = container.querySelector("#pr-res");

  async function analyser() {
    const cmd = container.querySelector("#pr-cmd").value;
    const annee = Number(container.querySelector("#pr-annee").value);
    const flux = container.querySelector("#pr-flux").value;
    const metric = container.querySelector("#pr-metric").value;
    res.innerHTML = `<div class="loading">Analyse en cours…</div>`;

    const C = sqlStr(cmd), F = sqlStr(flux);
    const nomCmd = chapitre(labels, cmd);
    const fluxLabel = flux === "X" ? "exportateurs" : "importateurs";
    const fmt = axisFmt(metric);
    const disp = (v) => fmtMetric(v, metric);

    const classement = await query(`
      SELECT reporterISO3, SUM(primaryValue) valeur, SUM(netWgt) poids FROM ${srcDetail([annee])}
      WHERE cmdCode = ${C} AND flowCode = ${F} AND partnerCode = '0'
        AND reporterISO3 IS NOT NULL
      GROUP BY reporterISO3 ORDER BY ${metric} DESC NULLS LAST LIMIT 20`);

    const evolution = await query(`
      SELECT period, SUM(primaryValue) valeur, SUM(netWgt) poids FROM ${srcDetail(ANNEES)}
      WHERE cmdCode = ${C} AND flowCode = ${F} AND partnerCode = '0'
      GROUP BY period ORDER BY period`);
    const evoMap = new Map(evolution.map((r) => [r.period, r[metric] || 0]));

    res.innerHTML = "";

    const cBar = card(`Top 20 ${fluxLabel} — ${nomCmd} (${annee})`, "pr-rank");
    res.appendChild(cBar);
    barChart(
      cBar.querySelector(".card-body"),
      classement.map((r) => pays(labels, r.reporterISO3)),
      classement.map((r) => r[metric] || 0),
      metric === "poids" ? "Poids" : "Valeur",
      fmt
    );

    const cEvo = card(`Évolution du commerce mondial — ${nomCmd} (${flux === "X" ? "exportations" : "importations"})`, "pr-evo");
    res.appendChild(cEvo);
    lineChart(cEvo.querySelector(".card-body"), ANNEES, [{ label: nomCmd, data: ANNEES.map((y) => evoMap.get(y) || 0) }], fmt);

    const cTable = card(`Classement détaillé — ${nomCmd} (${annee})`, "pr-table");
    res.appendChild(cTable);
    const total = classement.reduce((s, r) => s + (r[metric] || 0), 0);
    const lignes = classement.map((r, i) => ({
      rang: i + 1,
      pays: pays(labels, r.reporterISO3),
      iso3: r.reporterISO3,
      mesure: r[metric],
      part: pct(r[metric] || 0, total),
    }));
    renderTable(cTable.querySelector(".card-body"), [
      { key: "rang", label: "Rang" },
      { key: "pays", label: "Pays" },
      { key: "mesure", label: metric === "poids" ? "Poids" : "Valeur", render: (r) => `<span>${disp(r.mesure)}</span>` },
      { key: "part", label: "Part (top 20)" },
    ], lignes);

    const expLignes = classement.map((r, i) => ({ rang: i + 1, pays: pays(labels, r.reporterISO3), iso3: r.reporterISO3, valeur_usd: Math.round(r.valeur || 0), poids_kg: Math.round(r.poids || 0) }));
    cBar.querySelector("[data-export]").addEventListener("click", () => downloadCsv(`classement_${cmd}_${annee}_${flux}.csv`, expLignes));
    cEvo.querySelector("[data-export]").addEventListener("click", () =>
      downloadCsv(`evolution_${cmd}_${flux}.csv`, evolution.map((r) => ({ annee: r.period, valeur_usd: Math.round(r.valeur || 0), poids_kg: Math.round(r.poids || 0) })))
    );
    cTable.querySelector("[data-export]").addEventListener("click", () => downloadCsv(`classement_detail_${cmd}_${annee}_${flux}.csv`, expLignes));
  }

  container.querySelector("#pr-go").addEventListener("click", analyser);
  await analyser();
}
