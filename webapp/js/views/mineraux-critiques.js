// Vue « Minéraux critiques » : pour un minéral (dataset HS6 dédié, chaîne
// extraction → raffinage → transformation → produit fini), pays exportateurs ou
// importateurs, concentration des approvisionnements, évolution animée sur la
// carte, et recherche par code.
//
// Le périmètre produit vient du référentiel materiaux_fr.json et non des
// colonnes `mineral` / `categorie` des Parquet, figées depuis l'export : la
// sélection est convertie en liste de codes HS6 puis appliquée sur `cmdCode`.
import { query, srcCritical, srcCriticalAgg, sqlStr, clauseCodes } from "../db.js";
import { fmtMetric, axisFmt, pct, downloadCsv } from "../format.js";
import { pays, stades, stadeLabel, codesPour, codeLabel, matiere, formeLabel } from "../labels.js";
import {
  selectHTML, anneeOptions, fluxOptions, metricOptions, ctrl, kpisHTML, renderTable, card,
  renderChips, skeletonKpis, mineralOptions, stadeOptions, champCodeHTML, normaliserCode,
  multiSelectHTML, wireMultiSelect, ANNEES,
} from "../ui.js";
import { barChart, lineChart } from "../charts.js";
import { interactiveMap } from "../map.js";

let _geo = null;
async function geo() {
  if (!_geo) _geo = await (await fetch("vendor/world.geo.json")).json();
  return _geo;
}

export async function mount(container, { labels }) {
  const TOUS_STADES = stades(labels).map((s) => s.id);

  container.innerHTML = `
    <div class="filterbar">
      ${ctrl("Minéral critique", selectHTML("mc-min", mineralOptions(labels), "Lithium"), true)}
      <div class="ctrl grow"><label>Stades de la chaîne de valeur</label>
        ${multiSelectHTML("mc-cat", stadeOptions(labels), TOUS_STADES)}</div>
      ${ctrl("Code NC8 / HS6 (optionnel)", champCodeHTML("mc-code", "ex : 85076000 ou 850760"))}
      ${ctrl("Année", selectHTML("mc-annee", anneeOptions(), 2023))}
      ${ctrl("Flux", selectHTML("mc-flux", fluxOptions(), "X"))}
      ${ctrl("Mesure", selectHTML("mc-metric", metricOptions(), "valeur"))}
      <button class="btn" id="mc-go">Analyser</button>
    </div>
    <div class="chips" id="mc-chips" aria-label="Filtres actifs"></div>
    <div class="note">Chaîne de valeur : extraction → raffinage → transformation → produit fini.
      Un code HS6 saisi prime sur le minéral (recherche directe). « Concentration » = part cumulée des 5 premiers pays.
      Rappel : un produit fini <b>contient</b> le minéral sans en indiquer la teneur.</div>
    <div id="mc-res"></div>`;

  const res = container.querySelector("#mc-res");
  const chipsEl = container.querySelector("#mc-chips");
  const cats = wireMultiSelect("mc-cat");

  function majChips() {
    const annee = document.getElementById("mc-annee");
    const flux = document.getElementById("mc-flux");
    const metric = document.getElementById("mc-metric");
    const code = document.getElementById("mc-code");
    const choisies = [...document.getElementById("mc-cat").selectedOptions].map((o) => o.value);
    const items = [
      { label: "Minéral", value: container.querySelector("#mc-min").value, onReset: () => { container.querySelector("#mc-min").value = "Lithium"; analyser(); } },
      { label: "Stades", value: choisies.length === TOUS_STADES.length ? "tous" : `${choisies.length}/${TOUS_STADES.length}`,
        onReset: () => { cats.setTout(true); analyser(); } },
      { label: "Année", value: annee.value, onReset: () => { annee.value = "2023"; analyser(); } },
      { label: "Flux", value: flux.options[flux.selectedIndex].text, onReset: () => { flux.value = "X"; analyser(); } },
      { label: "Mesure", value: metric.options[metric.selectedIndex].text, onReset: () => { metric.value = "valeur"; analyser(); } },
    ];
    // La puce montre le code réellement appliqué, pas la saisie : afficher un
    // NC8 à 8 chiffres alors que le filtre porte sur 6 induirait en erreur.
    const cn = normaliserCode(code.value);
    if (cn) items.splice(1, 0, { label: "Code HS6", value: cn.hs6, onReset: () => { code.value = ""; analyser(); } });
    renderChips(chipsEl, items);
  }

  // Codes HS6 retenus, calculés depuis le référentiel plutôt que lus dans les
  // Parquet. Recherche par préfixe : un NC8 est tronqué à ses 6 premiers
  // chiffres (qui sont son code HS6), et un code partiel reste utile
  // (« 8507 » couvre tous les accumulateurs électriques).
  function codesRetenus() {
    const code = normaliserCode(container.querySelector("#mc-code").value);
    if (code) return codesPour(labels, { prefixe: code.hs6 });
    return codesPour(labels, {
      mineraux: [container.querySelector("#mc-min").value],
      stades: [...container.querySelector("#mc-cat").selectedOptions].map((o) => o.value),
    });
  }

  const clauseFiltre = () => clauseCodes(codesRetenus());

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
    //
    // Lu sur le PRÉ-AGRÉGAT et non sur le détail bilatéral : cette requête ne
    // demande que le partenaire World sur 26 années, ce qui obligeait sinon à
    // ouvrir 26 partitions pour n'en retenir qu'une fraction infime des lignes.
    // Le pré-agrégat porte déjà le filtre partnerCode = '0' et un reporterISO3
    // non nul, d'où leur disparition dans la première variante.
    const requete = (src, filtreSup) => `
      SELECT period, reporterISO3, SUM(primaryValue) valeur, SUM(netWgt) poids FROM ${src}
      WHERE ${filtre} AND flowCode = ${F}${filtreSup}
      GROUP BY period, reporterISO3`;

    // Repli sur le détail si le pré-agrégat est absent — cas d'une archive de
    // données antérieure à son introduction. Les deux chemins donnent le même
    // résultat, le repli est seulement plus lent : la vue reste donc juste, et
    // le dit, plutôt que de tomber en erreur.
    let rows;
    let degrade = false;
    try {
      rows = await query(requete(srcCriticalAgg(), ""));
    } catch {
      degrade = true;
      rows = await query(requete(srcCritical(ANNEES),
        " AND partnerCode = '0' AND reporterISO3 IS NOT NULL"));
    }

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

    // Un repli silencieux laisserait croire que l'optimisation est active alors
    // qu'elle ne l'est pas : on le dit, et on dit quoi faire.
    if (degrade) {
      res.insertAdjacentHTML("beforeend", `<div class="note">
        <b>Mode dégradé</b> : le pré-agrégat <code>critical_agg/</code> est absent de ce jeu de
        données, la vue lit donc le détail bilatéral sur 26 années. Les résultats sont les mêmes,
        l'affichage est seulement plus lent. Pour le rétablir :
        <code>python clean/clean_export.py --critical</code>, puis republier l'archive de données.</div>`);
    }

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

    // Composition du périmètre : dire explicitement quelles positions HS6 sont
    // sommées. Sans cela, un total reste invérifiable — deux minéraux n'ont ni
    // le même nombre de codes, ni la même profondeur de chaîne.
    const composition = codesRetenus().map((code) => {
      const m = matiere(labels, code) || {};
      return {
        code, produit: codeLabel(labels, code), mineral: m.mineral || "—",
        stade: m.stade ? stadeLabel(labels, m.stade) : "—",
        forme: m.forme ? formeLabel(labels, m.forme) : "—",
      };
    });
    const cCompo = card(`Composition du périmètre : ${composition.length} position(s) HS6`, "mc-compo");
    res.appendChild(cCompo);
    renderTable(cCompo.querySelector(".card-body"), [
      { key: "code", label: "Code HS6" },
      { key: "produit", label: "Produit" },
      { key: "mineral", label: "Minéral" },
      { key: "stade", label: "Stade" },
      { key: "forme", label: "Forme" },
    ], composition);
    cCompo.querySelector("[data-export]").addEventListener("click", () =>
      downloadCsv(`perimetre_${titreCible}.csv`, composition));

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
