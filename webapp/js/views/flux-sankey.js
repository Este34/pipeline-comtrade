// Vue « Flux » : les échanges de matières critiques sous cinq angles.
//
//  - « Chaîne de valeur »      : pays exportateurs → stade → pays importateurs.
//  - « Dépendance d'un pays »  : importations → pays choisi → exportations.
//  - « Origine d'un matériau » : d'où vient la matière, classement des pays
//                                d'origine lus sur les déclarations d'importation.
//  - « Comparer des minéraux » : alluvial origines → minéral → stade → destinations.
//  - « Origine détaillée »     : alluvial origines → position HS6 → stade → destinations.
//
// Le périmètre produit est un PANIER éditable (minéraux, stades, formes, codes),
// converti en liste de codes HS6 par le référentiel materiaux_fr.json puis
// injecté dans le SQL en `cmdCode IN (...)`. Les colonnes `mineral` et
// `categorie` des Parquet ne sont plus lues : elles y sont figées depuis
// l'export, alors que la taxonomie doit rester modifiable (voir js/labels.js).
//
// Les flux sont bilatéraux (partenaire réel, jamais l'agrégat World). Contrôle
// fait sur les données : la somme des partenaires identifiés retombe exactement
// sur le total World, donc écarter les partenaires sans code ISO3 ne perd
// aucune valeur.
import { query, srcCritical, sqlStr, clauseCodes, caseCodes } from "../db.js";
import { fmtMetric, axisFmt, pct, downloadCsv } from "../format.js";
import { pays, stades, stadeLabel, codeLabel, matiere, formeLabel, mineraux, codesPour } from "../labels.js";
import {
  selectHTML, anneeOptions, metricOptions, ctrl, comboHTML, wireCombo, paysOptions,
  mineralOptions, stadeOptions, formeOptions, kpisHTML, renderTable, card, renderChips,
  skeletonKpis, champCodeHTML, normaliserCode, multiSelectHTML, wireMultiSelect,
} from "../ui.js";
import { sankey } from "../sankey.js";
import { barChart } from "../charts.js";

// Progression volontairement lisible comme une chaîne : ocre pour ce qui sort
// du sol, terre pour la chimie et la métallurgie primaire, bleu médian pour le
// demi-produit ouvré, bleu France pour le plus transformé.
const COULEUR_STADE = {
  extraction: "#c08b00",
  raffinage: "#a25a3c",
  transformation: "#4d4dcf",
  fini: "#000091",
};
// Palette catégorielle pour les minéraux (mode comparaison) : un ruban par
// minéral doit rester distinguable quand huit d'entre eux se croisent.
const PALETTE_MIN = [
  "#000091", "#c08b00", "#a25a3c", "#00a95f", "#e1000f", "#6a6af4",
  "#0078f3", "#8bb31d", "#a558a0", "#009099", "#ff8d7e", "#465f9d",
];
const AUTRES = "__autres__";
const NEUTRE = "var(--blue-france)";
const MONDE = "";
// Séparateur des clés composées. Un espace ne conviendrait pas : plusieurs
// minéraux du référentiel en contiennent (« Terres rares », « Niobium, tantale,
// vanadium »), et la clé se retrouverait coupée au mauvais endroit.
const SEP = "\u0001";

const MODES = [
  { value: "chaine", label: "Chaîne de valeur" },
  { value: "pays", label: "Dépendance d'un pays" },
  { value: "origine", label: "Origine d'un matériau" },
  { value: "comparer", label: "Comparer des minéraux" },
  { value: "detail", label: "Origine détaillée (HS6)" },
];

// Garde les n premières clés d'une Map par valeur décroissante et regroupe le
// reste sous « Autres », pour que le graphe reste lisible sans masquer de volume.
function garderTop(totaux, n) {
  const tries = [...totaux.entries()].sort((a, b) => b[1] - a[1]);
  const gardes = new Set(tries.slice(0, n).map(([k]) => k));
  return (cle) => (gardes.has(cle) ? cle : AUTRES);
}

const triDesc = (m) =>
  [...m.entries()].sort((a, b) => (a[0] === AUTRES ? 1 : b[0] === AUTRES ? -1 : b[1] - a[1]));

// Additionne v dans m[cle].
const cumul = (m, cle, v) => m.set(cle, (m.get(cle) || 0) + v);

export async function mount(container, { labels }) {
  const TOUS_STADES = stades(labels).map((s) => s.id);
  const TOUS_MINERAUX = mineraux(labels);
  const couleurMineral = Object.fromEntries(
    TOUS_MINERAUX.map((m, i) => [m, PALETTE_MIN[i % PALETTE_MIN.length]])
  );

  container.innerHTML = `
    <div class="filterbar">
      ${ctrl("Angle d'analyse", selectHTML("fx-mode", MODES, "chaine"), true)}
      ${ctrl("Année", selectHTML("fx-annee", anneeOptions(), 2023))}
      ${ctrl("Mesure", selectHTML("fx-metric", metricOptions(), "valeur"))}
      ${ctrl("Pays affichés", selectHTML("fx-top", [
        { value: 8, label: "8" }, { value: 12, label: "12" }, { value: 20, label: "20" },
      ], 12))}
      <div class="ctrl" id="fx-pays-ctrl" hidden><label for="fx-pays">Pays analysé</label>
        ${comboHTML("fx-pays", "Rechercher un pays...")}</div>
      <button class="btn" id="fx-go">Analyser</button>
    </div>

    <details class="panier" id="fx-panier" open>
      <summary>Panier de matières <span id="fx-panier-resume"></span></summary>
      <div class="filterbar">
        <div class="ctrl grow"><label>Minéraux</label>
          ${multiSelectHTML("fx-min", mineralOptions(labels), ["Cuivre"])}</div>
        <div class="ctrl grow"><label>Stades de la chaîne de valeur</label>
          ${multiSelectHTML("fx-stade", stadeOptions(labels), TOUS_STADES)}</div>
        <div class="ctrl grow" id="fx-forme-ctrl"><label>Formes du produit</label>
          <div id="fx-forme-hote">${multiSelectHTML("fx-forme", formeOptions(labels, ["Cuivre"]), [])}</div></div>
        ${ctrl("Code NC8 / HS6 (optionnel)", champCodeHTML("fx-code", "ex : 260300 ou 8507"))}
      </div>
      <div class="note" id="fx-panier-note"></div>
    </details>

    <div class="chips" id="fx-chips" aria-label="Filtres actifs"></div>
    <div class="note" id="fx-note"></div>
    <div id="fx-res"></div>`;

  const res = container.querySelector("#fx-res");
  const chipsEl = container.querySelector("#fx-chips");
  const noteEl = container.querySelector("#fx-note");
  const paysCtrl = container.querySelector("#fx-pays-ctrl");
  const resumeEl = container.querySelector("#fx-panier-resume");
  const panierNote = container.querySelector("#fx-panier-note");
  // « Monde entier » est une vraie entrée de la liste : sans elle, les modes qui
  // acceptent un périmètre mondial n'auraient aucun moyen de le demander, le
  // combobox portant toujours une valeur.
  const combo = wireCombo("fx-pays",
    [{ value: MONDE, label: "Monde entier" }, ...paysOptions(labels)], { value: "FRA" });

  const lire = (id) => container.querySelector(`#fx-${id}`);
  const valeurs = (id) => [...lire(id).selectedOptions].map((o) => o.value);
  const modeCourant = () => lire("mode").value;

  let msMin = wireMultiSelect("fx-min");
  let msStade = wireMultiSelect("fx-stade");
  let msForme = wireMultiSelect("fx-forme");

  // La liste des formes dépend des minéraux retenus : proposer les treize
  // formes du référentiel quand la sélection n'en contient que quatre
  // afficherait des filtres qui ne filtrent rien.
  function reconstruireFormes(gardees = []) {
    const hote = container.querySelector("#fx-forme-hote");
    hote.innerHTML = multiSelectHTML("fx-forme", formeOptions(labels, valeurs("min")), gardees);
    msForme = wireMultiSelect("fx-forme");
    lire("forme").addEventListener("change", () => { majPanier(); ecrireHash(); });
  }

  // --- Panier -> liste de codes HS6 -------------------------------------
  // Un code saisi prime sur le reste du panier : les deux désignent un
  // périmètre de produits, les cumuler donnerait un filtre que personne ne
  // pourrait relire.
  function panier() {
    const code = normaliserCode(lire("code").value);
    if (code) return { codes: codesPour(labels, { prefixe: code.hs6 }), code: code.hs6 };
    return {
      codes: codesPour(labels, {
        mineraux: valeurs("min"),
        stades: valeurs("stade"),
        formes: valeurs("forme"),
      }),
      code: null,
    };
  }

  function libellePanier() {
    const p = panier();
    if (p.code) return `code ${p.code}`;
    const mins = valeurs("min");
    if (!mins.length) return "tous minéraux";
    if (mins.length <= 3) return mins.join(", ");
    return `${mins.length} minéraux`;
  }

  function majPanier() {
    const p = panier();
    resumeEl.textContent = `— ${libellePanier()} · ${p.codes.length} code${p.codes.length > 1 ? "s" : ""} HS6`;
    panierNote.innerHTML = p.codes.length
      ? `Périmètre appliqué : <b>${p.codes.length}</b> position${p.codes.length > 1 ? "s" : ""} HS6.
         Ajouter un minéral déjà extrait est immédiat ; un minéral absent du jeu de données demande
         une nouvelle extraction (<code>fetch_complement.py</code>).`
      : `<b>Panier vide</b> : aucune position HS6 ne correspond à cette combinaison, l'analyse ne
         renverra rien. Élargissez les stades ou les formes.`;
  }

  // --- État partagé par l'URL -------------------------------------------
  // L'application est un site statique : le hash est le seul endroit où une
  // analyse peut être conservée et transmise telle quelle.
  function ecrireHash() {
    const p = new URLSearchParams();
    p.set("vue", "flux");
    p.set("mode", modeCourant());
    p.set("an", lire("annee").value);
    p.set("mes", lire("metric").value);
    p.set("top", lire("top").value);
    if (modeCourant() !== "chaine" && modeCourant() !== "comparer") p.set("pays", combo.value);
    const code = normaliserCode(lire("code").value);
    if (code) p.set("code", code.hs6);
    else {
      if (valeurs("min").length) p.set("min", valeurs("min").join(","));
      const sts = valeurs("stade");
      if (sts.length && sts.length < TOUS_STADES.length) p.set("stade", sts.join(","));
      if (valeurs("forme").length) p.set("forme", valeurs("forme").join(","));
    }
    history.replaceState(null, "", "#" + p.toString());
  }

  function lireHash() {
    const p = new URLSearchParams(location.hash.replace(/^#/, ""));
    if (p.get("vue") !== "flux") return;
    const poser = (id, cle) => { const v = p.get(cle); if (v !== null) lire(id).value = v; };
    poser("mode", "mode"); poser("annee", "an"); poser("metric", "mes"); poser("top", "top");
    poser("code", "code");
    if (p.get("pays")) combo.set(p.get("pays"));
    const cocher = (select, liste) => {
      for (const o of select.options) o.selected = liste.includes(o.value);
    };
    if (p.get("min")) { cocher(lire("min"), p.get("min").split(",")); msMin.sync(); }
    if (p.get("stade")) { cocher(lire("stade"), p.get("stade").split(",")); msStade.sync(); }
    reconstruireFormes(p.get("forme") ? p.get("forme").split(",") : []);
  }

  function majAffichage() {
    const mode = modeCourant();
    paysCtrl.hidden = mode === "chaine" || mode === "comparer";
    container.querySelector("#fx-pays-ctrl label").textContent =
      mode === "pays" ? "Pays analysé" : "Pays importateur";
    const notes = {
      chaine: `Flux lus sur les <b>déclarations d'exportation</b> : à gauche les pays qui vendent, au centre
        le stade de transformation, à droite les pays qui achètent. Un pays présent des deux côtés
        importe puis réexporte.`,
      pays: `Flux lus sur les <b>déclarations du pays choisi</b> : à gauche ses importations et leur origine,
        à droite ses exportations et leur destination. La couleur des rubans donne le stade, ce qui rend
        visible un pays qui importe du minerai et réexporte du transformé.`,
      origine: `Classement des <b>pays d'origine</b>, lu sur les déclarations d'importation. Le miroir
        (déclarations d'exportation des pays d'origine) est affiché à côté : un écart durable entre les deux
        signale une réexportation, un transbordement ou une sous-déclaration.`,
      comparer: `Diagramme alluvial : origines → minéral → stade → destinations. Chaque minéral porte sa
        couleur, ce qui permet de comparer des filières entières sur une même échelle.`,
      detail: `Niveau le plus fin disponible : chaque position HS6 est distinguée, avec son intitulé et sa
        forme (minerai, oxyde, métal brut, demi-produit…). <b>Rappel</b> : les douanes classent par produit,
        pas par teneur — un tonnage de produit fini n'est pas un tonnage de métal.`,
    };
    noteEl.innerHTML = notes[mode];
  }

  function majChips() {
    const mode = modeCourant();
    const items = [
      { label: "Angle", value: lire("mode").selectedOptions[0].text,
        onReset: () => { lire("mode").value = "chaine"; majAffichage(); analyser(); } },
      { label: "Matières", value: libellePanier(),
        onReset: () => {
          lire("code").value = "";
          for (const o of lire("min").options) o.selected = o.value === "Cuivre";
          msMin.sync(); msStade.setTout(true); reconstruireFormes([]); analyser();
        } },
      { label: "Année", value: lire("annee").value,
        onReset: () => { lire("annee").value = "2023"; analyser(); } },
      { label: "Mesure", value: lire("metric").selectedOptions[0].text,
        onReset: () => { lire("metric").value = "valeur"; analyser(); } },
      { label: "Pays affichés", value: lire("top").value,
        onReset: () => { lire("top").value = "12"; analyser(); } },
    ];
    const sts = valeurs("stade");
    if (sts.length < TOUS_STADES.length) {
      items.splice(2, 0, { label: "Stades", value: `${sts.length}/${TOUS_STADES.length}`,
        onReset: () => { msStade.setTout(true); analyser(); } });
    }
    if (mode !== "chaine" && mode !== "comparer") {
      items.splice(2, 0, { label: "Pays", value: pays(labels, combo.value),
        onReset: () => { combo.set("FRA"); analyser(); } });
    }
    renderChips(chipsEl, items);
  }

  // --- Construction des graphes ------------------------------------------

  // Graphe générique à N colonnes : `etapes` décrit, pour chaque colonne, la clé
  // à lire sur les lignes agrégées. Les liens ne relient que deux colonnes
  // consécutives, ce qui est exactement ce que sait dessiner sankey().
  function grapheAlluvial(lignes, metric, etapes) {
    const val = (r) => r[metric] || 0;
    const volumes = etapes.map(() => new Map());
    for (const r of lignes) {
      const v = val(r);
      if (v <= 0) continue;
      etapes.forEach((e, i) => cumul(volumes[i], e.cle(r), v));
    }
    // Les colonnes de pays sont tronquées au top N, les colonnes de taxonomie
    // (stade, minéral) jamais : leur cardinalité est bornée par construction.
    const repli = etapes.map((e, i) => (e.topN ? garderTop(volumes[i], e.topN) : (k) => k));
    const vols = etapes.map(() => new Map());
    const liens = etapes.slice(0, -1).map(() => new Map());
    for (const r of lignes) {
      const v = val(r);
      if (v <= 0) continue;
      const cles = etapes.map((e, i) => repli[i](e.cle(r)));
      cles.forEach((c, i) => cumul(vols[i], c, v));
      for (let i = 0; i < cles.length - 1; i++) cumul(liens[i], cles[i] + SEP + cles[i + 1], v);
    }

    const nodes = [];
    const links = [];
    etapes.forEach((e, i) => {
      const entrees = e.ordre
        ? e.ordre.filter((k) => vols[i].has(k)).map((k) => [k, vols[i].get(k)])
        : triDesc(vols[i]);
      for (const [cle] of entrees) {
        nodes.push({
          id: `${i}:${cle}`, col: i,
          label: cle === AUTRES ? "Autres pays" : e.label(cle),
          titre: cle === AUTRES ? "Autres pays" : (e.titre ? e.titre(cle) : e.label(cle)),
          couleur: cle === AUTRES ? "#8393a7" : e.couleur(cle),
        });
      }
    });
    liens.forEach((m, i) => {
      for (const [k, v] of m) {
        const [a, b] = k.split(SEP);
        // Le ruban prend la couleur de la colonne porteuse de sens : celle qui
        // qualifie la matière, pas celle qui nomme un pays.
        const teinte = etapes[i].teinte ? etapes[i].teinte(a) : etapes[i + 1].teinte ? etapes[i + 1].teinte(b) : NEUTRE;
        links.push({ source: `${i}:${a}`, target: `${i + 1}:${b}`, value: v, couleur: teinte });
      }
    });
    return { nodes, links, volumes: vols };
  }

  // --- Analyse ------------------------------------------------------------

  async function analyser() {
    const mode = modeCourant();
    const annee = Number(lire("annee").value);
    const metric = lire("metric").value;
    const topN = Number(lire("top").value);
    const iso3 = combo.value;
    majAffichage();
    majPanier();
    majChips();
    ecrireHash();
    res.innerHTML = "";
    skeletonKpis(res, 3);

    const disp = (v) => fmtMetric(v, metric);
    const fmt = axisFmt(metric);
    const nomPays = (i) => pays(labels, i);
    const { codes } = panier();
    const cible = libellePanier();
    const SRC = srcCritical([annee]);
    const base = `${clauseCodes(codes)}
      AND partnerCode <> '0' AND reporterISO3 IS NOT NULL AND partnerISO3 IS NOT NULL`;

    // Regroupements dérivés du référentiel, injectés en CASE dans le SQL.
    const stadeSql = caseCodes(Object.fromEntries(
      TOUS_STADES.map((s) => [s, codesPour(labels, { stades: [s], codes })])));
    // Stades réellement couverts par le panier : la légende doit décrire le
    // graphe affiché, pas la taxonomie complète.
    const stadesPanier = TOUS_STADES.filter((s) => codesPour(labels, { stades: [s], codes }).length);
    const mineralSql = caseCodes(Object.fromEntries(
      TOUS_MINERAUX.map((m) => [m, codesPour(labels, { mineraux: [m], codes })])));

    const etapeStade = {
      cle: (r) => r.stade, label: (s) => stadeLabel(labels, s),
      couleur: (s) => COULEUR_STADE[s] || NEUTRE, teinte: (s) => COULEUR_STADE[s] || NEUTRE,
      ordre: TOUS_STADES,
    };
    const etapePays = (cle) => ({
      cle: (r) => r[cle], label: nomPays, couleur: () => NEUTRE, topN,
    });

    if (mode === "origine") return void (await modeOrigine());
    if (mode === "comparer") return void (await modeComparer());
    if (mode === "detail") return void (await modeDetail());
    if (mode === "pays") return void (await modePays());
    return void (await modeChaine());

    // ---------------------------------------------------------------- chaîne
    async function modeChaine() {
      const lignes = await query(`
        SELECT reporterISO3 AS exp, partnerISO3 AS imp, ${stadeSql} AS stade,
               SUM(primaryValue) valeur, SUM(netWgt) poids
        FROM ${SRC} WHERE ${base} AND flowCode = 'X'
        GROUP BY 1, 2, 3`);
      const graphe = grapheAlluvial(lignes, metric, [etapePays("exp"), etapeStade, etapePays("imp")]);

      const total = [...graphe.volumes[0].values()].reduce((s, v) => s + v, 0);
      const top5 = [...graphe.volumes[0].entries()].filter(([k]) => k !== AUTRES)
        .sort((a, b) => b[1] - a[1]).slice(0, 5).reduce((s, [, v]) => s + v, 0);
      const brut = graphe.volumes[1].get("extraction") || 0;
      afficher({
        kpis: [
          { label: `Échanges mondiaux ${annee}`, value: disp(total) },
          { label: "Part au stade extraction", value: pct(brut, total) },
          { label: "Concentration (5 premiers exportateurs)", value: pct(top5, total),
            cls: total && top5 / total > 0.7 ? "neg" : "" },
        ],
        titre: `Chaîne de valeur : ${cible} (${annee})`,
        graphe,
        entetes: ["Pays exportateurs", "Stade de transformation", "Pays importateurs"],
        lignes: lignes.map((r) => ({
          exportateur: nomPays(r.exp), importateur: nomPays(r.imp),
          stade: stadeLabel(labels, r.stade), mesure: r[metric] || 0,
        })),
        colonnes: [
          { key: "exportateur", label: "Exportateur" },
          { key: "importateur", label: "Importateur" },
          { key: "stade", label: "Stade" },
          { key: "mesure", label: metric === "poids" ? "Poids" : "Valeur", render: (r) => `<span>${disp(r.mesure)}</span>` },
        ],
        fichier: `flux_chaine_${slug(cible)}_${annee}`,
      });
    }

    // ------------------------------------------------------------ dépendance
    async function modePays() {
      // Cet angle décrit la position d'UN pays : sans pays, il n'a pas d'objet.
      if (iso3 === MONDE) {
        res.innerHTML = `<div class="empty">Choisissez un pays à analyser : cet angle décrit ses
          importations et ses exportations. Pour une lecture mondiale, utilisez « Chaîne de valeur »
          ou « Origine d'un matériau ».</div>`;
        return;
      }
      const lignes = await query(`
        SELECT partnerISO3 AS autre, ${stadeSql} AS stade, flowCode,
               SUM(primaryValue) valeur, SUM(netWgt) poids
        FROM ${SRC} WHERE ${base} AND reporterISO3 = ${sqlStr(iso3)}
        GROUP BY 1, 2, 3`);
      const imports = lignes.filter((r) => r.flowCode === "M");
      const exports = lignes.filter((r) => r.flowCode === "X");

      // Deux demi-graphes autour d'un pivot commun : le pays analysé.
      const gImp = grapheAlluvial(imports, metric, [etapePays("autre"), etapeStade]);
      const gExp = grapheAlluvial(exports, metric, [etapeStade, etapePays("autre")]);
      const graphe = fusionnerAutourDuPivot(gImp, gExp, nomPays(iso3));

      const totalImp = imports.reduce((s, r) => s + (r[metric] || 0), 0);
      const totalExp = exports.reduce((s, r) => s + (r[metric] || 0), 0);
      const parOrigine = new Map();
      for (const r of imports) cumul(parOrigine, r.autre, r[metric] || 0);
      const top3 = [...parOrigine.values()].sort((a, b) => b - a).slice(0, 3).reduce((s, v) => s + v, 0);
      afficher({
        kpis: [
          { label: `Importations ${annee}`, value: disp(totalImp) },
          { label: `Exportations ${annee}`, value: disp(totalExp) },
          { label: "Concentration des importations (3 premières origines)", value: pct(top3, totalImp),
            cls: totalImp && top3 / totalImp > 0.7 ? "neg" : "" },
        ],
        titre: `${nomPays(iso3)} : importations et exportations, ${cible} (${annee})`,
        graphe,
        entetes: ["Importations (origines)", nomPays(iso3), "Exportations (destinations)"],
        lignes: lignes.map((r) => ({
          sens: r.flowCode === "M" ? "Importation" : "Exportation",
          partenaire: nomPays(r.autre), stade: stadeLabel(labels, r.stade), mesure: r[metric] || 0,
        })),
        colonnes: [
          { key: "sens", label: "Sens" },
          { key: "partenaire", label: "Partenaire" },
          { key: "stade", label: "Stade" },
          { key: "mesure", label: metric === "poids" ? "Poids" : "Valeur", render: (r) => `<span>${disp(r.mesure)}</span>` },
        ],
        fichier: `flux_pays_${iso3}_${slug(cible)}_${annee}`,
      });
    }

    // --------------------------------------------------------------- origine
    async function modeOrigine() {
      const portee = iso3 === MONDE ? null : iso3;
      // Déclarations d'IMPORTATION : le partenaire est le pays d'origine.
      const imp = await query(`
        SELECT partnerISO3 AS origine, ${stadeSql} AS stade,
               SUM(primaryValue) valeur, SUM(netWgt) poids
        FROM ${SRC} WHERE ${base} AND flowCode = 'M'
        ${portee ? `AND reporterISO3 = ${sqlStr(portee)}` : ""}
        GROUP BY 1, 2`);
      // Miroir : ce que ces mêmes pays déclarent EXPORTER.
      const miroir = await query(`
        SELECT reporterISO3 AS origine, SUM(primaryValue) valeur, SUM(netWgt) poids
        FROM ${SRC} WHERE ${base} AND flowCode = 'X'
        ${portee ? `AND partnerISO3 = ${sqlStr(portee)}` : ""}
        GROUP BY 1`);
      // Détail par position HS6, pour dire quel produit précis vient d'où.
      const parCode = await query(`
        SELECT partnerISO3 AS origine, cmdCode,
               SUM(primaryValue) valeur, SUM(netWgt) poids
        FROM ${SRC} WHERE ${base} AND flowCode = 'M'
        ${portee ? `AND reporterISO3 = ${sqlStr(portee)}` : ""}
        GROUP BY 1, 2`);

      const parOrigine = new Map();
      const parStade = new Map();
      for (const r of imp) { cumul(parOrigine, r.origine, r[metric] || 0); cumul(parStade, r.stade, r[metric] || 0); }
      const classement = triDesc(parOrigine).filter(([, v]) => v > 0);
      const total = classement.reduce((s, [, v]) => s + v, 0);
      const top3 = classement.slice(0, 3).reduce((s, [, v]) => s + v, 0);
      const parMiroir = new Map();
      for (const r of miroir) cumul(parMiroir, r.origine, r[metric] || 0);

      res.innerHTML = "";
      const kpiWrap = document.createElement("div");
      kpiWrap.innerHTML = kpisHTML([
        { label: portee ? `Importations de ${nomPays(portee)} en ${annee}` : `Importations mondiales ${annee}`, value: disp(total) },
        { label: "Pays d'origine actifs", value: String(classement.length) },
        { label: "Concentration (3 premières origines)", value: pct(top3, total),
          cls: total && top3 / total > 0.7 ? "neg" : "" },
      ], 3);
      res.appendChild(kpiWrap);

      const top = classement.slice(0, 20);
      const cBar = card(`Principaux pays d'origine : ${cible} (${annee})`, "fx-origine-bar");
      res.appendChild(cBar);
      barChart(cBar.querySelector(".card-body"), top.map(([k]) => nomPays(k)),
        top.map(([, v]) => v), metric === "poids" ? "Poids" : "Valeur", fmt);

      const cTable = card("Origines, part et miroir des déclarations", "fx-origine-table");
      res.appendChild(cTable);
      const lignesTable = top.map(([k, v], i) => ({
        rang: i + 1, origine: nomPays(k), iso3: k, mesure: v, part: pct(v, total),
        miroir: parMiroir.has(k) ? disp(parMiroir.get(k)) : "non déclaré",
        ecart: parMiroir.get(k) ? pct(Math.abs(parMiroir.get(k) - v), v) : "—",
      }));
      renderTable(cTable.querySelector(".card-body"), [
        { key: "rang", label: "Rang" },
        { key: "origine", label: "Pays d'origine" },
        { key: "mesure", label: metric === "poids" ? "Poids importé" : "Valeur importée", render: (r) => `<span>${disp(r.mesure)}</span>` },
        { key: "part", label: "Part" },
        { key: "miroir", label: "Déclaré à l'export par l'origine" },
        { key: "ecart", label: "Écart au miroir" },
      ], lignesTable);

      // Quel produit précis, et à quel stade : c'est ce qui distingue un pays
      // qui vend son minerai d'un pays qui vend du métal raffiné.
      const parCodeTot = new Map();
      for (const r of parCode) cumul(parCodeTot, r.origine + SEP + r.cmdCode, r[metric] || 0);
      const detail = triDesc(parCodeTot).slice(0, 30).map(([k, v]) => {
        const [org, code] = k.split(SEP);
        const m = matiere(labels, code) || {};
        return {
          origine: nomPays(org), code, produit: codeLabel(labels, code),
          mineral: m.mineral || "—", stade: m.stade ? stadeLabel(labels, m.stade) : "—",
          forme: m.forme ? formeLabel(labels, m.forme) : "—", mesure: v,
        };
      });
      const cDetail = card("Détail par position HS6 (30 premiers flux)", "fx-origine-detail");
      res.appendChild(cDetail);
      renderTable(cDetail.querySelector(".card-body"), [
        { key: "origine", label: "Origine" },
        { key: "code", label: "Code HS6" },
        { key: "produit", label: "Produit" },
        { key: "stade", label: "Stade" },
        { key: "forme", label: "Forme" },
        { key: "mesure", label: metric === "poids" ? "Poids" : "Valeur", render: (r) => `<span>${disp(r.mesure)}</span>` },
      ], detail);

      const fichier = `flux_origine_${portee || "monde"}_${slug(cible)}_${annee}`;
      brancherExport(cBar, `${fichier}.csv`, lignesTable.map(arrondir));
      brancherExport(cTable, `${fichier}_table.csv`, lignesTable.map(arrondir));
      brancherExport(cDetail, `${fichier}_hs6.csv`, detail.map(arrondir));
    }

    // ------------------------------------------------------------- comparer
    async function modeComparer() {
      const lignes = await query(`
        SELECT reporterISO3 AS exp, partnerISO3 AS imp,
               ${mineralSql} AS mineral, ${stadeSql} AS stade,
               SUM(primaryValue) valeur, SUM(netWgt) poids
        FROM ${SRC} WHERE ${base} AND flowCode = 'X'
        GROUP BY 1, 2, 3, 4`);
      const etapeMineral = {
        cle: (r) => r.mineral, label: (m) => m,
        couleur: (m) => couleurMineral[m] || NEUTRE, teinte: (m) => couleurMineral[m] || NEUTRE,
      };
      const graphe = grapheAlluvial(lignes, metric,
        [etapePays("exp"), etapeMineral, etapeStade, etapePays("imp")]);

      const total = [...graphe.volumes[1].values()].reduce((s, v) => s + v, 0);
      const parMineral = triDesc(graphe.volumes[1]);
      afficher({
        kpis: [
          { label: `Échanges ${annee}`, value: disp(total) },
          { label: "Minéraux comparés", value: String(parMineral.length) },
          { label: "Premier minéral",
            value: parMineral.length ? `${parMineral[0][0]} (${pct(parMineral[0][1], total)})` : "—" },
        ],
        titre: `Comparaison de minéraux : ${cible} (${annee})`,
        graphe,
        entetes: ["Pays exportateurs", "Minéral", "Stade", "Pays importateurs"],
        legende: parMineral.map(([m]) => ({ label: m, couleur: couleurMineral[m] || NEUTRE })),
        lignes: lignes.map((r) => ({
          exportateur: nomPays(r.exp), importateur: nomPays(r.imp), mineral: r.mineral,
          stade: stadeLabel(labels, r.stade), mesure: r[metric] || 0,
        })),
        colonnes: [
          { key: "exportateur", label: "Exportateur" },
          { key: "importateur", label: "Importateur" },
          { key: "mineral", label: "Minéral" },
          { key: "stade", label: "Stade" },
          { key: "mesure", label: metric === "poids" ? "Poids" : "Valeur", render: (r) => `<span>${disp(r.mesure)}</span>` },
        ],
        fichier: `flux_comparaison_${slug(cible)}_${annee}`,
      });
    }

    // --------------------------------------------------------------- détail
    async function modeDetail() {
      const portee = iso3 === MONDE ? null : iso3;
      const lignes = await query(`
        SELECT partnerISO3 AS origine, reporterISO3 AS destination, cmdCode,
               ${stadeSql} AS stade, SUM(primaryValue) valeur, SUM(netWgt) poids
        FROM ${SRC} WHERE ${base} AND flowCode = 'M'
        ${portee ? `AND reporterISO3 = ${sqlStr(portee)}` : ""}
        GROUP BY 1, 2, 3, 4`);
      const etapeCode = {
        cle: (r) => r.cmdCode,
        label: (c) => codeLabel(labels, c),
        titre: (c) => {
          const m = matiere(labels, c) || {};
          return `${c} — ${codeLabel(labels, c)} (${m.mineral || "?"}, ${m.forme ? formeLabel(labels, m.forme) : "?"})`;
        },
        couleur: (c) => COULEUR_STADE[(matiere(labels, c) || {}).stade] || NEUTRE,
        teinte: (c) => COULEUR_STADE[(matiere(labels, c) || {}).stade] || NEUTRE,
        topN: 14,
      };
      const graphe = grapheAlluvial(lignes, metric,
        [etapePays("origine"), etapeCode, etapeStade, etapePays("destination")]);

      const total = [...graphe.volumes[0].values()].reduce((s, v) => s + v, 0);
      const nbCodes = new Set(lignes.filter((r) => (r[metric] || 0) > 0).map((r) => r.cmdCode)).size;
      afficher({
        kpis: [
          { label: portee ? `Importations de ${nomPays(portee)} en ${annee}` : `Importations mondiales ${annee}`, value: disp(total) },
          { label: "Positions HS6 actives", value: String(nbCodes) },
          { label: "Part au stade extraction", value: pct(graphe.volumes[2].get("extraction") || 0, total) },
        ],
        titre: `Origine détaillée : ${cible} (${annee})`,
        graphe,
        entetes: ["Pays d'origine", "Position HS6", "Stade", "Pays destinataires"],
        lignes: lignes.map((r) => {
          const m = matiere(labels, r.cmdCode) || {};
          return {
            origine: nomPays(r.origine), destination: nomPays(r.destination), code: r.cmdCode,
            produit: codeLabel(labels, r.cmdCode), mineral: m.mineral || "—",
            stade: stadeLabel(labels, r.stade), forme: m.forme ? formeLabel(labels, m.forme) : "—",
            mesure: r[metric] || 0,
          };
        }),
        colonnes: [
          { key: "origine", label: "Origine" },
          { key: "destination", label: "Destination" },
          { key: "code", label: "Code HS6" },
          { key: "produit", label: "Produit" },
          { key: "forme", label: "Forme" },
          { key: "mesure", label: metric === "poids" ? "Poids" : "Valeur", render: (r) => `<span>${disp(r.mesure)}</span>` },
        ],
        fichier: `flux_detail_${portee || "monde"}_${slug(cible)}_${annee}`,
      });
    }

    // --- Rendu commun aux modes à diagramme --------------------------------
    function afficher({ kpis, titre, graphe, entetes, lignes, colonnes, fichier, legende }) {
      res.innerHTML = "";
      const kpiWrap = document.createElement("div");
      kpiWrap.innerHTML = kpisHTML(kpis, 3);
      res.appendChild(kpiWrap);

      const cSankey = card(titre, "fx-sankey");
      res.appendChild(cSankey);
      const corps = cSankey.querySelector(".card-body");
      const items = legende || stadesPanier
        .map((s) => ({ label: stadeLabel(labels, s), couleur: COULEUR_STADE[s] }));
      corps.insertAdjacentHTML("beforeend", `<div class="legende">${items
        .map((i) => `<span class="legende-item"><i style="background:${i.couleur}"></i>${i.label}</span>`)
        .join("")}</div>`);
      const hote = document.createElement("div");
      corps.appendChild(hote);
      sankey(hote, graphe, { fmt: disp, entetes });

      const tri = lignes.filter((r) => r.mesure > 0).sort((a, b) => b.mesure - a.mesure).slice(0, 50);
      const cTable = card("Principaux flux détaillés (50 premiers)", "fx-table");
      res.appendChild(cTable);
      renderTable(cTable.querySelector(".card-body"), colonnes, tri);

      brancherExport(cSankey, `${fichier}.csv`, tri.map(arrondir));
      brancherExport(cTable, `${fichier}_table.csv`, tri.map(arrondir));
    }
  }

  // Recolle les deux demi-graphes du mode « dépendance » : la colonne des
  // stades du côté import et celle du côté export doivent devenir un pivot
  // unique, sinon le pays analysé n'apparaît pas au centre.
  function fusionnerAutourDuPivot(gImp, gExp, nomPivot) {
    const nodes = [
      ...gImp.nodes.filter((n) => n.col === 0).map((n) => ({ ...n, id: `f:${n.id}` })),
      { id: "pivot", col: 1, label: nomPivot, couleur: NEUTRE },
      ...gExp.nodes.filter((n) => n.col === 1).map((n) => ({ ...n, col: 2, id: `c:${n.id}` })),
    ];
    const links = [
      ...gImp.links.map((l) => ({ ...l, source: `f:${l.source}`, target: "pivot" })),
      ...gExp.links.map((l) => ({ ...l, source: "pivot", target: `c:${l.target}` })),
    ];
    return { nodes, links, volumes: gImp.volumes };
  }

  const slug = (s) => String(s).replace(/\W+/g, "_");
  const arrondir = (r) => ({ ...r, mesure: Math.round(r.mesure) });
  function brancherExport(carte, nom, donnees) {
    carte.querySelector("[data-export]").addEventListener("click", () => downloadCsv(nom, donnees));
  }

  // --- Câblage ------------------------------------------------------------
  container.querySelector("#fx-go").addEventListener("click", analyser);
  lire("mode").addEventListener("change", () => { majAffichage(); majChips(); ecrireHash(); });
  lire("min").addEventListener("change", () => { reconstruireFormes(); majPanier(); majChips(); ecrireHash(); });
  lire("stade").addEventListener("change", () => { majPanier(); majChips(); ecrireHash(); });
  lire("forme").addEventListener("change", () => { majPanier(); ecrireHash(); });
  // Saisir un code neutralise le reste du panier : l'afficher encore actif
  // laisserait croire à un filtre qui n'est pas celui appliqué.
  lire("code").addEventListener("input", () => { majPanier(); majChips(); });
  lire("code").addEventListener("keydown", (e) => { if (e.key === "Enter") analyser(); });
  ["annee", "metric", "top"].forEach((id) =>
    lire(id).addEventListener("change", () => { majChips(); ecrireHash(); }));
  combo.onChange(() => { majChips(); ecrireHash(); });

  lireHash();
  await analyser();
}
