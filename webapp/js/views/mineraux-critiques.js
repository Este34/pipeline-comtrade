// Vue « Minéraux critiques » : pour un minéral (dataset HS6 dédié, chaîne
// matière→alliage→produit fini), pays producteurs/exportateurs, concentration
// des approvisionnements, évolution animée sur la carte, et recherche par code.
import { query, srcCritical, sqlStr } from "../db.js";
import { fmtMetric, axisFmt, pct, downloadCsv } from "../format.js";
import { pays } from "../labels.js";
import {
  selectHTML, anneeOptions, fluxOptions, metricOptions, ctrl, kpisHTML, renderTable, card,
  renderChips, skeletonKpis, ANNEES,
} from "../ui.js";
import { barChart, lineChart } from "../charts.js";
import { interactiveMap } from "../map.js";

const CATEGORIES = ["Matière première", "Alliage / demi-produit", "Produit fini"];

let _geo = null;
async function geo() {
  if (!_geo) _geo = await (await fetch("vendor/world.geo.json")).json();
  return _geo;
}

function mineralOptions(labels) {
  const uniques = [...new Set(Object.values(labels.minerals).map((v) => v.mineral))].sort((a, b) => a.localeCompare(b, "fr"));
  return uniques.map((m) => ({ value: m, label: m }));
}

export async function mount(container, { labels }) {
  container.innerHTML = `
    <div class="filterbar">
      ${ctrl("Minéral critique", selectHTML("mc-min", mineralOptions(labels), "Lithium"), true)}
      <div class="ctrl grow"><label>Catégories (chaîne de valeur)</label>
        <select id="mc-cat" multiple size="3">
          ${CATEGORIES.map((c) => `<option value="${c}" selected>${c}</option>`).join("")}
        </select></div>
      ${ctrl("Recherche code HS6 (optionnel)", '<input id="mc-code" type="text" placeholder="ex: 850760" />')}
      ${ctrl("Année", selectHTML("mc-annee", anneeOptions(), 2023))}
      ${ctrl("Flux", selectHTML("mc-flux", fluxOptions(), "X"))}
      ${ctrl("Mesure", selectHTML("mc-metric", metricOptions(), "valeur"))}
      <button class="btn" id="mc-go">Analyser</button>
    </div>
    <div class="chips" id="mc-chips" aria-label="Filtres actifs"></div>
    <div class="note">Chaîne de valeur : matière première → alliage/demi-produit → produit fini.
      Un code HS6 saisi prime sur le minéral (recherche directe). « Concentration » = part cumulée des 5 premiers pays.
      Rappel : un produit fini <b>contient</b> le minéral sans en indiquer la teneur.</div>
    <div id="mc-res"></div>`;

  const res = container.querySelector("#mc-res");
  const chipsEl = container.querySelector("#mc-chips");

  function majChips() {
    const annee = document.getElementById("mc-annee");
    const flux = document.getElementById("mc-flux");
    const metric = document.getElementById("mc-metric");
    const code = document.getElementById("mc-code");
    const cats = [...document.getElementById("mc-cat").selectedOptions].map((o) => o.value);
    const items = [
      { label: "Minéral", value: container.querySelector("#mc-min").value, onReset: () => { container.querySelector("#mc-min").value = "Lithium"; analyser(); } },
      { label: "Catégories", value: cats.length === CATEGORIES.length ? "toutes" : `${cats.length}/${CATEGORIES.length}`,
        onReset: () => { [...document.getElementById("mc-cat").options].forEach((o) => (o.selected = true)); analyser(); } },
      { label: "Année", value: annee.value, onReset: () => { annee.value = "2023"; analyser(); } },
      { label: "Flux", value: flux.options[flux.selectedIndex].text, onReset: () => { flux.value = "X"; analyser(); } },
      { label: "Mesure", value: metric.options[metric.selectedIndex].text, onReset: () => { metric.value = "valeur"; analyser(); } },
    ];
    if (code.value.trim()) items.splice(1, 0, { label: "Code HS6", value: code.value.trim(), onReset: () => { code.value = ""; analyser(); } });
    renderChips(chipsEl, items);
  }

  function clauseFiltre() {
    const code = container.querySelector("#mc-code").value.trim();
    const cats = [...container.querySelector("#mc-cat").selectedOptions].map((o) => o.value);
    const parts = [];
    if (code) parts.push(`cmdCode LIKE ${sqlStr("%" + code + "%")}`);
    else parts.push(`mineral = ${sqlStr(container.querySelector("#mc-min").value)}`);
    if (cats.length && cats.length < CATEGORIES.length)
      parts.push(`categorie IN (${cats.map(sqlStr).join(",")})`);
    return parts.join(" AND ");
  }

  async function analyser() {
    const annee = Number(container.querySelector("#mc-annee").value);
    const flux = container.querySelector("#mc-flux").value;
    const metric = container.querySelector("#mc-metric").value;
    const code = container.querySelector("#mc-code").value.trim();
    const titreCible = code ? `code ${code}` : container.querySelector("#mc-min").value;
    majChips();
    res.innerHTML = "";
    skeletonKpis(res, 3);

    const F = sqlStr(flux);
    const filtre = clauseFiltre();
    const fmt = axisFmt(metric);
    const disp = (v) => fmtMetric(v, metric);
    const fluxLabel = flux === "X" ? "exportateurs" : "importateurs";

    // Toutes les années × pays (alimente carte + classement + évolution).
    const rows = await query(`
      SELECT period, reporterISO3, SUM(primaryValue) valeur, SUM(netWgt) poids FROM ${srcCritical(ANNEES)}
      WHERE ${filtre} AND flowCode = ${F} AND partnerCode = '0' AND reporterISO3 IS NOT NULL
      GROUP BY period, reporterISO3`);

    const parAnnee = new Map(ANNEES.map((y) => [y, new Map()]));
    for (const r of rows) parAnnee.get(r.period)?.set(r.reporterISO3, r[metric] || 0);

    // Classement de l'année sélectionnée.
    const classement = [...parAnnee.get(annee).entries()]
      .map(([iso3, v]) => ({ iso3, v }))
      .filter((r) => r.v > 0)
      .sort((a, b) => b.v - a.v);
    const total = classement.reduce((s, r) => s + r.v, 0);
    const top5 = classement.slice(0, 5).reduce((s, r) => s + r.v, 0);

    // Évolution mondiale.
    const evoMap = new Map(ANNEES.map((y) => [y, [...parAnnee.get(y).values()].reduce((s, v) => s + v, 0)]));

    res.innerHTML = "";

    const kpiWrap = document.createElement("div");
    kpiWrap.innerHTML = kpisHTML(
      [
        { label: `Commerce mondial ${flux === "X" ? "(export)" : "(import)"} ${annee}`, value: disp(total) },
        { label: "Nombre de pays actifs", value: String(classement.length) },
        { label: "Concentration (top 5)", value: pct(top5, total), cls: total && top5 / total > 0.7 ? "neg" : "" },
      ],
      3
    );
    res.appendChild(kpiWrap);

    const top = classement.slice(0, 20);
    const cBar = card(`Top 20 ${fluxLabel} : ${titreCible} (${annee})`, "mc-rank");
    res.appendChild(cBar);
    barChart(cBar.querySelector(".card-body"), top.map((r) => pays(labels, r.iso3)), top.map((r) => r.v), metric === "poids" ? "Poids" : "Valeur", fmt);

    const cMap = card(`Carte animée : ${titreCible} (2000 à 2025)`, "mc-map");
    res.appendChild(cMap);
    interactiveMap(cMap.querySelector(".card-body"), await geo(), parAnnee, {
      annees: ANNEES, metric, labelFn: (iso3) => pays(labels, iso3), fmt,
    });

    const cEvo = card(`Évolution mondiale : ${titreCible}`, "mc-evo");
    res.appendChild(cEvo);
    lineChart(cEvo.querySelector(".card-body"), ANNEES, [{ label: titreCible, data: ANNEES.map((y) => evoMap.get(y)) }], fmt);

    const cTable = card(`Classement détaillé : ${titreCible} (${annee})`, "mc-table");
    res.appendChild(cTable);
    const lignes = top.map((r, i) => ({ rang: i + 1, pays: pays(labels, r.iso3), iso3: r.iso3, mesure: r.v, part: pct(r.v, total) }));
    renderTable(cTable.querySelector(".card-body"), [
      { key: "rang", label: "Rang" },
      { key: "pays", label: "Pays" },
      { key: "mesure", label: metric === "poids" ? "Poids" : "Valeur", render: (r) => `<span>${disp(r.mesure)}</span>` },
      { key: "part", label: "Part mondiale" },
    ], lignes);

    const expClass = classement.map((r, i) => ({ rang: i + 1, pays: pays(labels, r.iso3), iso3: r.iso3, mesure: Math.round(r.v) }));
    cBar.querySelector("[data-export]").addEventListener("click", () => downloadCsv(`mineral_${titreCible}_${annee}_${flux}.csv`, expClass));
    cMap.querySelector("[data-export]").addEventListener("click", () =>
      downloadCsv(`mineral_carte_${titreCible}_${flux}.csv`, rows.map((r) => ({ annee: r.period, pays: pays(labels, r.reporterISO3), iso3: r.reporterISO3, valeur_usd: Math.round(r.valeur || 0), poids_kg: Math.round(r.poids || 0) })))
    );
    cEvo.querySelector("[data-export]").addEventListener("click", () => downloadCsv(`mineral_evolution_${titreCible}_${flux}.csv`, ANNEES.map((y) => ({ annee: y, mesure: Math.round(evoMap.get(y)) }))));
    cTable.querySelector("[data-export]").addEventListener("click", () => downloadCsv(`mineral_detail_${titreCible}_${annee}_${flux}.csv`, expClass));
  }

  container.querySelector("#mc-go").addEventListener("click", analyser);
  ["mc-min", "mc-cat", "mc-code", "mc-annee", "mc-flux", "mc-metric"].forEach((id) =>
    document.getElementById(id).addEventListener("change", majChips)
  );
  await analyser();
}
