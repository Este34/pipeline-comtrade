// Vue « Cartes & séries » : choroplèthe mondiale du commerce par pays +
// comparateur d'évolution multi-pays.
import { query, srcAggregat, srcDetail, sqlStr } from "../db.js";
import { downloadCsv } from "../format.js";
import { pays } from "../labels.js";
import {
  selectHTML, paysOptions, anneeOptions, fluxOptions, ctrl, card, ANNEES,
} from "../ui.js";
import { choropleth, lineChart } from "../charts.js";

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
      ${ctrl("Année (carte)", selectHTML("ct-annee", anneeOptions(), 2023))}
      <button class="btn" id="ct-go">Afficher la carte</button>
    </div>
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

  async function carte() {
    const flux = container.querySelector("#ct-flux").value;
    const annee = Number(container.querySelector("#ct-annee").value);
    mapHost.innerHTML = `<div class="loading">Construction de la carte…</div>`;

    const rows = await query(`
      SELECT reporterISO3, SUM(primaryValue) v FROM ${srcAggregat()}
      WHERE period = ${annee} AND flowCode = ${sqlStr(flux)}
        AND partnerCode = '0' AND cmdCode = 'TOTAL' AND reporterISO3 IS NOT NULL
      GROUP BY reporterISO3`);
    const valeurs = new Map(rows.map((r) => [r.reporterISO3, r.v]));

    mapHost.innerHTML = "";
    const fluxLabel = flux === "X" ? "Exportations" : "Importations";
    const c = card(`${fluxLabel} totales par pays (${annee})`, "ct-map-csv");
    mapHost.appendChild(c);
    choropleth(c.querySelector(".card-body"), await geo(), valeurs, (iso3) => pays(labels, iso3));
    c.querySelector("[data-export]").addEventListener("click", () =>
      downloadCsv(`carte_${flux}_${annee}.csv`, rows.map((r) => ({ pays: pays(labels, r.reporterISO3), iso3: r.reporterISO3, valeur_usd: Math.round(r.v) })))
    );
  }

  async function comparer() {
    const flux = container.querySelector("#ct-flux").value;
    const sel = [...container.querySelector("#ct-multi").selectedOptions].map((o) => o.value);
    if (!sel.length) return;
    serieHost.innerHTML = `<div class="loading">Calcul des séries…</div>`;

    const liste = sel.map(sqlStr).join(",");
    const rows = await query(`
      SELECT period, reporterISO3, SUM(primaryValue) v FROM ${srcDetail(ANNEES)}
      WHERE reporterISO3 IN (${liste}) AND cmdCode = 'TOTAL'
        AND flowCode = ${sqlStr(flux)} AND partnerCode = '0'
      GROUP BY period, reporterISO3 ORDER BY period`);

    const parPays = new Map(sel.map((iso3) => [iso3, new Map()]));
    for (const r of rows) parPays.get(r.reporterISO3)?.set(r.period, r.v);

    serieHost.innerHTML = "";
    const fluxLabel = flux === "X" ? "exportations" : "importations";
    const c = card(`Évolution comparée des ${fluxLabel} totales (2000–2025)`, "ct-serie-csv");
    serieHost.appendChild(c);
    const series = sel.map((iso3) => ({
      label: pays(labels, iso3),
      data: ANNEES.map((y) => parPays.get(iso3).get(y) || 0),
    }));
    lineChart(c.querySelector(".card-body"), ANNEES, series);
    c.querySelector("[data-export]").addEventListener("click", () =>
      downloadCsv(
        `comparaison_${flux}.csv`,
        ANNEES.map((y, i) => {
          const row = { annee: y };
          sel.forEach((iso3) => (row[iso3] = Math.round(series.find((s) => s.label === pays(labels, iso3)).data[i])));
          return row;
        })
      )
    );
  }

  container.querySelector("#ct-go").addEventListener("click", carte);
  container.querySelector("#ct-cmp").addEventListener("click", comparer);
  await carte();
  await comparer();
}
