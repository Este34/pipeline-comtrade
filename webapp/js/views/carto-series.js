// Vue « Cartes & séries » : carte interactive (curseur + Play) du commerce par
// pays + comparateur d'évolution multi-pays.
import { query, srcAggregat, srcDetail, sqlStr } from "../db.js";
import { axisFmt, fmtMetric, downloadCsv } from "../format.js";
import { pays } from "../labels.js";
import {
  selectHTML, paysOptions, fluxOptions, metricOptions, ctrl, card, renderChips, ANNEES,
} from "../ui.js";
import { lineChart } from "../charts.js";
import { interactiveMap } from "../map.js";

let _geo = null;
async function geo() {
  if (!_geo) _geo = await (await fetch("vendor/world.geo.json")).json();
  return _geo;
}

export async function mount(container, { labels }) {
  const opts = paysOptions(labels);
  container.innerHTML = `
    <div class="filterbar">
      ${ctrl("Flux", selectHTML("ct-flux", fluxOptions(), "X"))}
      ${ctrl("Mesure", selectHTML("ct-metric", metricOptions(), "valeur"))}
      <button class="btn" id="ct-go">Afficher la carte</button>
    </div>
    <div class="chips" id="ct-chips" aria-label="Filtres actifs"></div>
    <div class="note">Faites glisser le curseur ou cliquez ▶ Play pour animer l'évolution 2000→2025.
      Cliquez un pays sur la carte pour l'ajouter à la comparaison ci-dessous.</div>
    <div id="ct-map"></div>
    <div class="filterbar" style="margin-top:14px">
      <div class="ctrl grow">
        <label>Pays à comparer (Ctrl/Cmd pour plusieurs)</label>
        <select id="ct-multi" multiple size="6">
          ${opts.map((o) => `<option value="${o.value}"${["FRA", "DEU", "CHN", "USA"].includes(o.value) ? " selected" : ""}>${o.label}</option>`).join("")}
        </select>
      </div>
      <button class="btn" id="ct-cmp">Comparer l'évolution</button>
    </div>
    <div id="ct-serie"></div>`;

  const mapHost = container.querySelector("#ct-map");
  const serieHost = container.querySelector("#ct-serie");
  const multi = container.querySelector("#ct-multi");
  const chipsEl = container.querySelector("#ct-chips");

  function majChips() {
    const fluxSel = document.getElementById("ct-flux");
    const metricSel = document.getElementById("ct-metric");
    renderChips(chipsEl, [
      { label: "Flux", value: fluxSel.options[fluxSel.selectedIndex].text, onReset: () => { fluxSel.value = "X"; carte(); comparer(); } },
      { label: "Mesure", value: metricSel.options[metricSel.selectedIndex].text, onReset: () => { metricSel.value = "valeur"; carte(); comparer(); } },
    ]);
  }

  async function carte() {
    const flux = container.querySelector("#ct-flux").value;
    const metric = container.querySelector("#ct-metric").value;
    majChips();
    mapHost.innerHTML = `<div class="skel" style="height:460px"></div>`;

    const rows = await query(`
      SELECT period, reporterISO3, SUM(primaryValue) valeur, SUM(netWgt) poids FROM ${srcAggregat()}
      WHERE flowCode = ${sqlStr(flux)} AND partnerCode = '0' AND cmdCode = 'TOTAL'
        AND reporterISO3 IS NOT NULL
      GROUP BY period, reporterISO3`);

    const parAnnee = new Map(ANNEES.map((y) => [y, new Map()]));
    for (const r of rows) parAnnee.get(r.period)?.set(r.reporterISO3, r[metric] || 0);

    mapHost.innerHTML = "";
    const fluxLabel = flux === "X" ? "Exportations" : "Importations";
    const c = card(`${fluxLabel} totales par pays, animation 2000 à 2025`, "ct-map-csv");
    mapHost.appendChild(c);
    interactiveMap(c.querySelector(".card-body"), await geo(), parAnnee, {
      annees: ANNEES,
      metric,
      labelFn: (iso3) => pays(labels, iso3),
      fmt: axisFmt(metric),
      onClick: (iso3) => {
        if (!iso3) return;
        const opt = [...multi.options].find((o) => o.value === iso3);
        if (opt) { opt.selected = true; comparer(); }
      },
    });
    c.querySelector("[data-export]").addEventListener("click", () =>
      downloadCsv(`carte_${flux}.csv`, rows.map((r) => ({ annee: r.period, pays: pays(labels, r.reporterISO3), iso3: r.reporterISO3, valeur_usd: Math.round(r.valeur || 0), poids_kg: Math.round(r.poids || 0) })))
    );
  }

  async function comparer() {
    const flux = container.querySelector("#ct-flux").value;
    const metric = container.querySelector("#ct-metric").value;
    majChips();
    const sel = [...multi.selectedOptions].map((o) => o.value);
    if (!sel.length) return;
    serieHost.innerHTML = `<div class="loading">Calcul des séries…</div>`;

    const liste = sel.map(sqlStr).join(",");
    const rows = await query(`
      SELECT period, reporterISO3, SUM(primaryValue) valeur, SUM(netWgt) poids FROM ${srcDetail(ANNEES)}
      WHERE reporterISO3 IN (${liste}) AND cmdCode = 'TOTAL'
        AND flowCode = ${sqlStr(flux)} AND partnerCode = '0'
      GROUP BY period, reporterISO3 ORDER BY period`);

    const parPays = new Map(sel.map((iso3) => [iso3, new Map()]));
    for (const r of rows) parPays.get(r.reporterISO3)?.set(r.period, r[metric] || 0);

    serieHost.innerHTML = "";
    const fluxLabel = flux === "X" ? "exportations" : "importations";
    const c = card(`Évolution comparée des ${fluxLabel} totales (2000–2025)`, "ct-serie-csv");
    serieHost.appendChild(c);
    const series = sel.map((iso3) => ({ label: pays(labels, iso3), data: ANNEES.map((y) => parPays.get(iso3).get(y) || 0) }));
    lineChart(c.querySelector(".card-body"), ANNEES, series, axisFmt(metric));
    c.querySelector("[data-export]").addEventListener("click", () =>
      downloadCsv(`comparaison_${flux}.csv`, ANNEES.map((y, i) => {
        const row = { annee: y };
        sel.forEach((iso3) => (row[iso3] = Math.round(series.find((s) => s.label === pays(labels, iso3)).data[i])));
        return row;
      }))
    );
  }

  container.querySelector("#ct-go").addEventListener("click", carte);
  container.querySelector("#ct-cmp").addEventListener("click", comparer);
  ["ct-flux", "ct-metric"].forEach((id) => document.getElementById(id).addEventListener("change", majChips));
  await carte();
  await comparer();
}
