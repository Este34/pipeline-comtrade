// Vue « Flux » : diagramme de Sankey des échanges de minéraux critiques, sous
// deux angles complémentaires.
//
//  - « Chaîne de valeur » : exportateurs → matière première / alliage / produit
//    fini → importateurs. Répond à « qui vend du brut, qui vend du transformé ».
//  - « Pays au centre » : fournisseurs → pays choisi → clients. Répond à « de
//    qui ce pays dépend, et vers qui il réexporte ».
//
// Les flux sont bilatéraux (partenaire réel, jamais l'agrégat World), et lus sur
// les déclarations du pays concerné. Contrôle fait sur les données : la somme
// des partenaires identifiés retombe exactement sur le total World, donc écarter
// les partenaires sans code ISO3 ne perd aucune valeur.
import { query, srcCritical, sqlStr } from "../db.js";
import { fmtMetric, axisFmt, pct, downloadCsv } from "../format.js";
import { pays } from "../labels.js";
import {
  selectHTML, anneeOptions, metricOptions, ctrl, comboHTML, wireCombo, paysOptions,
  mineralOptions, kpisHTML, renderTable, card, renderChips, skeletonKpis,
  champCodeHTML, normaliserCode,
} from "../ui.js";
import { sankey } from "../sankey.js";

// Progression volontairement lisible comme une chaîne : ocre pour ce qui sort du
// sol, bleu médian pour le demi-produit, bleu France pour le plus transformé.
const COULEUR_CAT = {
  "Matière première": "#c08b00",
  "Alliage / demi-produit": "#4d4dcf",
  "Produit fini": "#000091",
};
const ORDRE_CAT = ["Matière première", "Alliage / demi-produit", "Produit fini"];
const AUTRES = "__autres__";

// Garde les n premières clés d'une Map par valeur décroissante et regroupe le
// reste sous « Autres », pour que le graphe reste lisible sans masquer de volume.
function garderTop(totaux, n) {
  const tries = [...totaux.entries()].sort((a, b) => b[1] - a[1]);
  const gardes = new Set(tries.slice(0, n).map(([k]) => k));
  return (cle) => (gardes.has(cle) ? cle : AUTRES);
}

export async function mount(container, { labels }) {
  container.innerHTML = `
    <div class="filterbar">
      ${ctrl("Angle d'analyse", selectHTML("fx-mode", [
        { value: "chaine", label: "Chaîne de valeur" },
        { value: "pays", label: "Pays au centre" },
      ], "chaine"), true)}
      ${ctrl("Minéral critique", selectHTML("fx-min", mineralOptions(labels), "Lithium"))}
      ${ctrl("Code NC8 / HS6 (optionnel)", champCodeHTML("fx-code", "ex : 85076000 ou 850760"))}
      <div class="ctrl" id="fx-pays-ctrl" hidden><label for="fx-pays">Pays au centre</label>
        ${comboHTML("fx-pays", "Rechercher un pays...")}</div>
      ${ctrl("Année", selectHTML("fx-annee", anneeOptions(), 2023))}
      ${ctrl("Mesure", selectHTML("fx-metric", metricOptions(), "valeur"))}
      ${ctrl("Partenaires affichés", selectHTML("fx-top", [
        { value: 8, label: "8" }, { value: 12, label: "12" }, { value: 20, label: "20" },
      ], 12))}
      <button class="btn" id="fx-go">Analyser</button>
    </div>
    <div class="chips" id="fx-chips" aria-label="Filtres actifs"></div>
    <div class="note" id="fx-note"></div>
    <div id="fx-res"></div>`;

  const res = container.querySelector("#fx-res");
  const chipsEl = container.querySelector("#fx-chips");
  const noteEl = container.querySelector("#fx-note");
  const paysCtrl = container.querySelector("#fx-pays-ctrl");
  const combo = wireCombo("fx-pays", paysOptions(labels), { value: "FRA" });

  const lire = (id) => container.querySelector(`#fx-${id}`);
  const modeCourant = () => lire("mode").value;

  function majAffichage() {
    paysCtrl.hidden = modeCourant() !== "pays";
    noteEl.innerHTML = modeCourant() === "chaine"
      ? `Flux lus sur les <b>déclarations d'exportation</b> : à gauche les pays qui vendent, au centre le degré de
         transformation, à droite les pays qui achètent. Un pays présent des deux côtés importe et réexporte.`
      : `Flux lus sur les <b>déclarations du pays choisi</b> : à gauche ses fournisseurs, à droite ses clients.
         La couleur des rubans indique le degré de transformation, ce qui rend visible un pays qui importe du brut
         et réexporte du transformé.`;
  }

  function majChips() {
    const items = [
      { label: "Angle", value: lire("mode").selectedOptions[0].text, onReset: () => { lire("mode").value = "chaine"; majAffichage(); analyser(); } },
      { label: "Minéral", value: lire("min").value, onReset: () => { lire("min").value = "Lithium"; analyser(); } },
      { label: "Année", value: lire("annee").value, onReset: () => { lire("annee").value = "2023"; analyser(); } },
      { label: "Mesure", value: lire("metric").selectedOptions[0].text, onReset: () => { lire("metric").value = "valeur"; analyser(); } },
      { label: "Partenaires", value: lire("top").value, onReset: () => { lire("top").value = "12"; analyser(); } },
    ];
    const c = normaliserCode(lire("code").value);
    if (c) items.splice(1, 1, { label: "Code", value: c.hs6, onReset: () => { lire("code").value = ""; analyser(); } });
    if (modeCourant() === "pays") {
      items.splice(2, 0, { label: "Pays", value: pays(labels, combo.value), onReset: () => { combo.set("FRA"); analyser(); } });
    }
    renderChips(chipsEl, items);
  }

  // Construit le graphe « exportateurs → catégorie → importateurs ».
  function grapheChaine(lignes, metric, topN, nomPays) {
    const val = (r) => r[metric] || 0;
    const totEx = new Map(), totIm = new Map();
    for (const r of lignes) {
      totEx.set(r.exp, (totEx.get(r.exp) || 0) + val(r));
      totIm.set(r.imp, (totIm.get(r.imp) || 0) + val(r));
    }
    const repEx = garderTop(totEx, topN);
    const repIm = garderTop(totIm, topN);

    const gauche = new Map(), droite = new Map(), volEx = new Map(), volIm = new Map();
    for (const r of lignes) {
      const v = val(r);
      if (v <= 0) continue;
      const e = repEx(r.exp), i = repIm(r.imp);
      gauche.set(`${e}|${r.categorie}`, (gauche.get(`${e}|${r.categorie}`) || 0) + v);
      droite.set(`${r.categorie}|${i}`, (droite.get(`${r.categorie}|${i}`) || 0) + v);
      volEx.set(e, (volEx.get(e) || 0) + v);
      volIm.set(i, (volIm.get(i) || 0) + v);
    }

    const nomNoeud = (cle) => (cle === AUTRES ? "Autres pays" : nomPays(cle));
    const triDesc = (m) => [...m.entries()].sort((a, b) => (a[0] === AUTRES ? 1 : b[0] === AUTRES ? -1 : b[1] - a[1]));

    const nodes = [
      ...triDesc(volEx).map(([k]) => ({ id: `e:${k}`, label: nomNoeud(k), col: 0, couleur: "var(--blue-france)" })),
      ...ORDRE_CAT.map((c) => ({ id: `c:${c}`, label: c, col: 1, couleur: COULEUR_CAT[c] })),
      ...triDesc(volIm).map(([k]) => ({ id: `i:${k}`, label: nomNoeud(k), col: 2, couleur: "var(--blue-france)" })),
    ];
    const links = [
      ...[...gauche].map(([k, v]) => { const [e, c] = k.split("|"); return { source: `e:${e}`, target: `c:${c}`, value: v, couleur: COULEUR_CAT[c] }; }),
      ...[...droite].map(([k, v]) => { const [c, i] = k.split("|"); return { source: `c:${c}`, target: `i:${i}`, value: v, couleur: COULEUR_CAT[c] }; }),
    ];
    return { nodes, links, volEx, volIm };
  }

  // Construit le graphe « fournisseurs → pays → clients ».
  function graphePays(lignes, metric, topN, nomPays, iso3) {
    const val = (r) => r[metric] || 0;
    const totF = new Map(), totC = new Map();
    for (const r of lignes) {
      const cible = r.flowCode === "M" ? totF : totC;
      cible.set(r.autre, (cible.get(r.autre) || 0) + val(r));
    }
    const repF = garderTop(totF, topN);
    const repC = garderTop(totC, topN);

    const entrants = new Map(), sortants = new Map(), volF = new Map(), volC = new Map();
    for (const r of lignes) {
      const v = val(r);
      if (v <= 0) continue;
      if (r.flowCode === "M") {
        const f = repF(r.autre);
        entrants.set(`${f}|${r.categorie}`, (entrants.get(`${f}|${r.categorie}`) || 0) + v);
        volF.set(f, (volF.get(f) || 0) + v);
      } else {
        const c = repC(r.autre);
        sortants.set(`${r.categorie}|${c}`, (sortants.get(`${r.categorie}|${c}`) || 0) + v);
        volC.set(c, (volC.get(c) || 0) + v);
      }
    }

    const nomNoeud = (cle) => (cle === AUTRES ? "Autres pays" : nomPays(cle));
    const triDesc = (m) => [...m.entries()].sort((a, b) => (a[0] === AUTRES ? 1 : b[0] === AUTRES ? -1 : b[1] - a[1]));

    const nodes = [
      ...triDesc(volF).map(([k]) => ({ id: `f:${k}`, label: nomNoeud(k), col: 0, couleur: COULEUR_CAT["Matière première"] })),
      { id: "pivot", label: nomPays(iso3), col: 1, couleur: "var(--blue-france)" },
      ...triDesc(volC).map(([k]) => ({ id: `c:${k}`, label: nomNoeud(k), col: 2, couleur: "var(--blue-france)" })),
    ];
    const links = [
      ...[...entrants].map(([k, v]) => { const [f, cat] = k.split("|"); return { source: `f:${f}`, target: "pivot", value: v, couleur: COULEUR_CAT[cat] }; }),
      ...[...sortants].map(([k, v]) => { const [cat, c] = k.split("|"); return { source: "pivot", target: `c:${c}`, value: v, couleur: COULEUR_CAT[cat] }; }),
    ];
    return { nodes, links, volF, volC };
  }

  async function analyser() {
    const mode = modeCourant();
    const mineral = lire("min").value;
    const annee = Number(lire("annee").value);
    const metric = lire("metric").value;
    const topN = Number(lire("top").value);
    const iso3 = combo.value;
    majAffichage();
    majChips();
    res.innerHTML = "";
    skeletonKpis(res, 3);

    const disp = (v) => fmtMetric(v, metric);
    const fmt = axisFmt(metric);
    const nomPays = (i) => pays(labels, i);
    // Un code saisi prime sur le minéral : les deux désignent un périmètre de
    // produits, les cumuler n'aurait pas de sens. Le préfixe permet d'entrer un
    // code partiel (« 8507 » couvre tous les accumulateurs).
    const code = normaliserCode(lire("code").value);
    const cible = code ? `code ${code.hs6}` : mineral;
    const filtreCommun = `${code ? `cmdCode LIKE ${sqlStr(code.hs6 + "%")}` : `mineral = ${sqlStr(mineral)}`}
      AND partnerCode <> '0' AND reporterISO3 IS NOT NULL AND partnerISO3 IS NOT NULL`;
    const SRC = srcCritical([annee]);

    let graphe, kpis, lignesTable, colonnes, nomFichier, titreGraphe;

    if (mode === "chaine") {
      const lignes = await query(`
        SELECT reporterISO3 AS exp, partnerISO3 AS imp, categorie,
               SUM(primaryValue) valeur, SUM(netWgt) poids
        FROM ${SRC} WHERE ${filtreCommun} AND flowCode = 'X'
        GROUP BY 1, 2, 3`);
      graphe = grapheChaine(lignes, metric, topN, nomPays);

      const total = [...graphe.volEx.values()].reduce((s, v) => s + v, 0);
      const top5 = [...graphe.volEx.entries()].filter(([k]) => k !== AUTRES).sort((a, b) => b[1] - a[1]).slice(0, 5).reduce((s, [, v]) => s + v, 0);
      const parCat = new Map();
      for (const r of lignes) parCat.set(r.categorie, (parCat.get(r.categorie) || 0) + (r[metric] || 0));
      const brut = parCat.get("Matière première") || 0;
      kpis = [
        { label: `Échanges mondiaux ${annee}`, value: disp(total) },
        { label: "Part en matière première", value: pct(brut, total) },
        { label: "Concentration (top 5 exportateurs)", value: pct(top5, total), cls: total && top5 / total > 0.7 ? "neg" : "" },
      ];
      titreGraphe = `Chaîne de valeur : ${cible} (${annee})`;
      lignesTable = lignes
        .map((r) => ({ exportateur: nomPays(r.exp), importateur: nomPays(r.imp), categorie: r.categorie, mesure: r[metric] || 0 }))
        .filter((r) => r.mesure > 0).sort((a, b) => b.mesure - a.mesure).slice(0, 50);
      colonnes = [
        { key: "exportateur", label: "Exportateur" },
        { key: "importateur", label: "Importateur" },
        { key: "categorie", label: "Maillon" },
        { key: "mesure", label: metric === "poids" ? "Poids" : "Valeur", render: (r) => `<span>${disp(r.mesure)}</span>` },
      ];
      nomFichier = `flux_chaine_${cible.replace(/\W+/g, "_")}_${annee}`;
    } else {
      const lignes = await query(`
        SELECT partnerISO3 AS autre, categorie, flowCode,
               SUM(primaryValue) valeur, SUM(netWgt) poids
        FROM ${SRC} WHERE ${filtreCommun} AND reporterISO3 = ${sqlStr(iso3)}
        GROUP BY 1, 2, 3`);
      graphe = graphePays(lignes, metric, topN, nomPays, iso3);

      const totalImp = [...graphe.volF.values()].reduce((s, v) => s + v, 0);
      const totalExp = [...graphe.volC.values()].reduce((s, v) => s + v, 0);
      const top3Imp = [...graphe.volF.entries()].filter(([k]) => k !== AUTRES).sort((a, b) => b[1] - a[1]).slice(0, 3).reduce((s, [, v]) => s + v, 0);
      kpis = [
        { label: `Importations ${annee}`, value: disp(totalImp) },
        { label: `Exportations ${annee}`, value: disp(totalExp) },
        { label: "Dépendance (top 3 fournisseurs)", value: pct(top3Imp, totalImp), cls: totalImp && top3Imp / totalImp > 0.7 ? "neg" : "" },
      ];
      titreGraphe = `${nomPays(iso3)} : fournisseurs et clients, ${cible} (${annee})`;
      lignesTable = lignes
        .map((r) => ({ sens: r.flowCode === "M" ? "Import" : "Export", partenaire: nomPays(r.autre), categorie: r.categorie, mesure: r[metric] || 0 }))
        .filter((r) => r.mesure > 0).sort((a, b) => b.mesure - a.mesure).slice(0, 50);
      colonnes = [
        { key: "sens", label: "Sens" },
        { key: "partenaire", label: "Partenaire" },
        { key: "categorie", label: "Maillon" },
        { key: "mesure", label: metric === "poids" ? "Poids" : "Valeur", render: (r) => `<span>${disp(r.mesure)}</span>` },
      ];
      nomFichier = `flux_pays_${iso3}_${cible.replace(/\W+/g, "_")}_${annee}`;
    }

    res.innerHTML = "";
    const kpiWrap = document.createElement("div");
    kpiWrap.innerHTML = kpisHTML(kpis, 3);
    res.appendChild(kpiWrap);

    const cSankey = card(titreGraphe, "fx-sankey");
    res.appendChild(cSankey);
    const corps = cSankey.querySelector(".card-body");
    corps.insertAdjacentHTML("beforeend", `<div class="legende">${ORDRE_CAT
      .map((c) => `<span class="legende-item"><i style="background:${COULEUR_CAT[c]}"></i>${c}</span>`).join("")}</div>`);
    const hote = document.createElement("div");
    corps.appendChild(hote);
    sankey(hote, graphe, {
      fmt: disp,
      entetes: mode === "chaine"
        ? { gauche: "Exportateurs", centre: "Degré de transformation", droite: "Importateurs" }
        : { gauche: "Fournisseurs", centre: nomPays(iso3), droite: "Clients" },
    });

    const cTable = card("Principaux flux détaillés (50 premiers)", "fx-table");
    res.appendChild(cTable);
    renderTable(cTable.querySelector(".card-body"), colonnes, lignesTable);

    const pourExport = lignesTable.map((r) => ({ ...r, mesure: Math.round(r.mesure) }));
    cSankey.querySelector("[data-export]").addEventListener("click", () => downloadCsv(`${nomFichier}.csv`, pourExport));
    cTable.querySelector("[data-export]").addEventListener("click", () => downloadCsv(`${nomFichier}_table.csv`, pourExport));
  }

  container.querySelector("#fx-go").addEventListener("click", analyser);
  lire("mode").addEventListener("change", () => { majAffichage(); majChips(); });
  // Choisir un minéral vide le code : il prime sur le minéral, garder les deux
  // afficherait un filtre qui n'est pas celui appliqué.
  lire("min").addEventListener("change", () => { lire("code").value = ""; majChips(); });
  lire("code").addEventListener("keydown", (e) => { if (e.key === "Enter") analyser(); });
  ["annee", "metric", "top"].forEach((id) => lire(id).addEventListener("change", majChips));
  combo.onChange(majChips);
  await analyser();
}
