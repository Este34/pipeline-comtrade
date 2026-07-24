// Vue « Analyse par produit » : pour un chapitre HS, classement des pays
// (exportateurs/importateurs) et évolution du commerce mondial.
import { query, srcDetail, sqlStr } from "../db.js";
import { fmtMetric, axisFmt, pct, downloadCsv } from "../format.js";
import { chapitre, pays } from "../labels.js";
import {
  comboHTML, wireCombo, selectHTML, anneeOptions, fluxOptions, metricOptions, ctrl,
  renderTable, card, renderChips, skeletonKpis, champCodeHTML, normaliserCode, ANNEES,
} from "../ui.js";
import { barChart, lineChart } from "../charts.js";

function chapitreOptions(labels) {
  return Object.entries(labels.chapters)
    .filter(([k]) => k !== "TOTAL" && k !== "99")
    .map(([code, nom]) => ({ value: code, label: `${code} · ${nom}` }))
    .sort((a, b) => a.value.localeCompare(b.value));
}

export async function mount(container, { labels }) {
  const chapitres = chapitreOptions(labels);
  container.innerHTML = `
    <div class="filterbar">
      ${ctrl("Produit (chapitre HS)", comboHTML("pr-cmd", "Rechercher un produit..."), true)}
      ${ctrl("Code NC8 / HS", champCodeHTML("pr-code"))}
      ${ctrl("Année", selectHTML("pr-annee", anneeOptions(), 2023))}
      ${ctrl("Flux", selectHTML("pr-flux", fluxOptions(), "X"))}
      ${ctrl("Mesure", selectHTML("pr-metric", metricOptions(), "valeur"))}
      <button class="btn" id="pr-go">Analyser</button>
    </div>
    <div class="chips" id="pr-chips" aria-label="Filtres actifs"></div>
    <div class="note" id="pr-code-aide">Ce jeu de données est extrait au niveau <b>chapitre HS (2 chiffres)</b>.
      Un code NC8 ou HS6 saisi ici sélectionne donc son chapitre : <code>85076000</code> et <code>850760</code>
      mènent tous deux au chapitre <code>85</code>. Pour une analyse au code exact, utilisez l'onglet
      <b>Minéraux critiques</b> ou <b>Flux</b>, extraits en HS6.</div>
    <div id="pr-res"></div>`;

  const res = container.querySelector("#pr-res");
  const chipsEl = container.querySelector("#pr-chips");
  const combo = wireCombo("pr-cmd", chapitres, { value: "27" });
  const champCode = container.querySelector("#pr-code");

  // Une saisie de code positionne le combobox sur le chapitre correspondant :
  // le code reste un raccourci de sélection, jamais un filtre concurrent.
  function appliquerCode() {
    const c = normaliserCode(champCode.value);
    if (!c) return true;
    if (!chapitres.some((o) => o.value === c.hs2)) {
      res.innerHTML = `<div class="empty">Aucun chapitre HS ne correspond au code « ${champCode.value} ».</div>`;
      return false;
    }
    combo.set(c.hs2);
    return true;
  }

  function annee() { return document.getElementById("pr-annee"); }
  function flux() { return document.getElementById("pr-flux"); }
  function metric() { return document.getElementById("pr-metric"); }

  function majChips() {
    renderChips(chipsEl, [
      { label: "Produit", value: chapitre(labels, combo.value), onReset: () => { combo.set("27"); analyser(); } },
      { label: "Année", value: annee().value, onReset: () => { annee().value = "2023"; analyser(); } },
      { label: "Flux", value: flux().options[flux().selectedIndex].text, onReset: () => { flux().value = "X"; analyser(); } },
      { label: "Mesure", value: metric().options[metric().selectedIndex].text, onReset: () => { metric().value = "valeur"; analyser(); } },
    ]);
  }

  async function analyser() {
    if (!appliquerCode()) return;
    const cmd = combo.value;
    const an = Number(annee().value);
    const fx = flux().value;
    const mt = metric().value;
    majChips();
    res.innerHTML = "";
    skeletonKpis(res, 1);

    const C = sqlStr(cmd), F = sqlStr(fx);
    const nomCmd = chapitre(labels, cmd);
    const fluxLabel = fx === "X" ? "exportateurs" : "importateurs";
    const fmt = axisFmt(mt);
    const disp = (v) => fmtMetric(v, mt);

    const classement = await query(`
      SELECT reporterISO3, SUM(primaryValue) valeur, SUM(netWgt) poids FROM ${srcDetail([an])}
      WHERE cmdCode = ${C} AND flowCode = ${F} AND partnerCode = '0'
        AND reporterISO3 IS NOT NULL
      GROUP BY reporterISO3 ORDER BY ${mt} DESC NULLS LAST LIMIT 20`);

    const evolution = await query(`
      SELECT period, SUM(primaryValue) valeur, SUM(netWgt) poids FROM ${srcDetail(ANNEES)}
      WHERE cmdCode = ${C} AND flowCode = ${F} AND partnerCode = '0'
      GROUP BY period ORDER BY period`);
    const evoMap = new Map(evolution.map((r) => [r.period, r[mt] || 0]));

    res.innerHTML = "";

    const cBar = card(`Top 20 ${fluxLabel} : ${nomCmd} (${an})`, "pr-rank");
    res.appendChild(cBar);
    barChart(
      cBar.querySelector(".card-body"),
      classement.map((r) => pays(labels, r.reporterISO3)),
      classement.map((r) => r[mt] || 0),
      mt === "poids" ? "Poids" : "Valeur",
      fmt
    );

    const cEvo = card(`Évolution du commerce mondial : ${nomCmd} (${fx === "X" ? "exportations" : "importations"})`, "pr-evo");
    res.appendChild(cEvo);
    lineChart(cEvo.querySelector(".card-body"), ANNEES, [{ label: nomCmd, data: ANNEES.map((y) => evoMap.get(y) || 0) }], fmt);

    const cTable = card(`Classement détaillé : ${nomCmd} (${an})`, "pr-table");
    res.appendChild(cTable);
    const total = classement.reduce((s, r) => s + (r[mt] || 0), 0);
    const lignes = classement.map((r, i) => ({
      rang: i + 1,
      pays: pays(labels, r.reporterISO3),
      iso3: r.reporterISO3,
      mesure: r[mt],
      part: pct(r[mt] || 0, total),
    }));
    renderTable(cTable.querySelector(".card-body"), [
      { key: "rang", label: "Rang" },
      { key: "pays", label: "Pays" },
      { key: "mesure", label: mt === "poids" ? "Poids" : "Valeur", render: (r) => `<span>${disp(r.mesure)}</span>` },
      { key: "part", label: "Part (top 20)" },
    ], lignes);

    const expLignes = classement.map((r, i) => ({ rang: i + 1, pays: pays(labels, r.reporterISO3), iso3: r.reporterISO3, valeur_usd: Math.round(r.valeur || 0), poids_kg: Math.round(r.poids || 0) }));
    cBar.querySelector("[data-export]").addEventListener("click", () => downloadCsv(`classement_${cmd}_${an}_${fx}.csv`, expLignes));
    cEvo.querySelector("[data-export]").addEventListener("click", () =>
      downloadCsv(`evolution_${cmd}_${fx}.csv`, evolution.map((r) => ({ annee: r.period, valeur_usd: Math.round(r.valeur || 0), poids_kg: Math.round(r.poids || 0) })))
    );
    cTable.querySelector("[data-export]").addEventListener("click", () => downloadCsv(`classement_detail_${cmd}_${an}_${fx}.csv`, expLignes));
  }

  container.querySelector("#pr-go").addEventListener("click", analyser);
  // Choisir un chapitre au combobox vide le code : les deux champs désignent la
  // même chose, garder l'ancienne saisie afficherait un filtre trompeur.
  combo.onChange(() => { champCode.value = ""; analyser(); });
  champCode.addEventListener("keydown", (e) => { if (e.key === "Enter") analyser(); });
  ["pr-annee", "pr-flux", "pr-metric"].forEach((id) => document.getElementById(id).addEventListener("change", majChips));

  await analyser();
}
