// Vue « Cartes & séries » : carte interactive (curseur + Play) du commerce par
// pays + comparateur d'évolution multi-pays.
import { query, srcAggregat, sqlStr } from "../db.js";
import { axisFmt, fmtMetric, downloadCsv } from "../format.js";
import { pays } from "../labels.js";
import {
  selectHTML, paysOptions, fluxOptions, metricOptions, ctrl, card, renderChips,
  multiSelectHTML, wireMultiSelect, ANNEES,
} from "../ui.js";
import { lineChart } from "../charts.js";
import { interactiveMap, purgerCartes } from "../map.js";

/*
 * Le module du globe n'est JAMAIS importé statiquement, pas même pour sa
 * fonction de purge : l'importer ferait entrer ses 17 Ko dans le chargement
 * initial des huit onglets, dont sept n'affichent aucun globe. La référence est
 * gardée après le premier import dynamique, et la purge n'a de toute façon rien
 * à nettoyer tant qu'aucun globe n'a été construit.
 */
let modGlobe = null;
const purgerGlobeCarte = (o) => modGlobe?.purgerChoroplethes(o);

/*
 * Représentation de la carte : plan ou globe.
 *
 * Le PLAN reste le défaut, à rebours du reste de l'application. Une choroplèthe
 * sert à comparer des pays entre eux, et un globe en cache la moitié en
 * permanence ; Leaflet fait ici mieux — zoom, tuiles, infobulles, clic. Le
 * globe est proposé en seconde lecture, pas en remplacement. Le rapport
 * s'inverse sur les arcs de flux, où c'est le globe qui gagne : voir globe.js.
 */
const CLE_REPR = "comtrade:carte";
const lireRepr = () => {
  try {
    return localStorage.getItem(CLE_REPR) === "globe" ? "globe" : "plan";
  } catch {
    return "plan";
  }
};
const ecrireRepr = (v) => {
  try {
    localStorage.setItem(CLE_REPR, v);
  } catch {
    /* stockage indisponible : le choix vaut pour la session */
  }
};

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
        <label>Pays à comparer (cliquez pour cocher, ou cliquez un pays sur la carte)</label>
        ${multiSelectHTML("ct-multi", opts, ["FRA", "DEU", "CHN", "USA"])}
      </div>
      <button class="btn" id="ct-cmp">Comparer l'évolution</button>
    </div>
    <div id="ct-serie"></div>`;

  const mapHost = container.querySelector("#ct-map");
  const serieHost = container.querySelector("#ct-serie");
  const multi = container.querySelector("#ct-multi");
  const listePays = wireMultiSelect("ct-multi");
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
    const corps = c.querySelector(".card-body");

    const surClicPays = (iso3) => {
      if (!iso3) return;
      const opt = [...multi.options].find((o) => o.value === iso3);
      // La sélection étant modifiée par programme ici, les cases à cocher
      // doivent être resynchronisées pour rester le reflet fidèle du select.
      if (opt) { opt.selected = true; listePays.sync(); comparer(); }
    };

    const bascule = document.createElement("div");
    bascule.className = "bascule-repr";
    corps.appendChild(bascule);
    const hoteCarte = document.createElement("div");
    corps.appendChild(hoteCarte);

    const geojson = await geo();

    async function dessinerCarte() {
      // Les deux représentations tiennent chacune un contexte lourd — une
      // instance Leaflet, un contexte WebGL — et le conteneur est vidé entre
      // les deux : sans purge explicite, l'abandonnée survit avec ses écouteurs.
      purgerCartes({ toutes: true });
      purgerGlobeCarte({ toutes: true });
      hoteCarte.innerHTML = "";
      bascule.innerHTML = ["plan", "globe"].map((m) => `
        <button type="button" class="bascule-btn" data-repr="${m}"
                aria-pressed="${m === lireRepr()}">${m === "plan" ? "🗺 Carte plane" : "🌍 Globe"}</button>`).join("");

      if (lireRepr() === "globe") {
        try {
          modGlobe = await import("../globe-choroplethe.js");
          const g = await modGlobe.globeChoroplethe(hoteCarte, geojson, parAnnee, {
            annees: ANNEES,
            labelFn: (iso3) => pays(labels, iso3),
            fmt: axisFmt(metric),
            onClick: surClicPays,
          });
          if (g) return;
          throw new Error("WebGL indisponible");
        } catch (e) {
          // Repli silencieux sur la carte plane, qui dit la même chose.
          console.warn("Globe indisponible, repli sur la carte plane :", e.message);
          ecrireRepr("plan");
          bascule.innerHTML = "";
        }
      }
      interactiveMap(hoteCarte, geojson, parAnnee, {
        annees: ANNEES,
        metric,
        labelFn: (iso3) => pays(labels, iso3),
        fmt: axisFmt(metric),
        onClick: surClicPays,
      });
    }

    bascule.addEventListener("click", (e) => {
      const b = e.target.closest("[data-repr]");
      if (!b || b.dataset.repr === lireRepr()) return;
      ecrireRepr(b.dataset.repr);
      dessinerCarte();
    });
    await dessinerCarte();
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
      SELECT period, reporterISO3, SUM(primaryValue) valeur, SUM(netWgt) poids FROM ${srcAggregat()}
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
