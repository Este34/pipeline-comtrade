// Vue « Flux » : les échanges de matières critiques sous cinq angles, dépliés
// d'un seul tenant.
//
//  1. « Chaîne de valeur »      : pays exportateurs → stade → pays importateurs.
//  2. « Dépendance d'un pays »  : importations → pays choisi → exportations.
//  3. « Origine d'un matériau » : d'où vient (ou où va) la matière, classement
//                                des partenaires et miroir des déclarations.
//  4. « Comparer des minéraux » : alluvial origines → minéral → stade → destinations.
//  5. « Origine détaillée »     : alluvial origines → position HS6 → forme →
//                                stade → destinations.
//
// Les cinq angles étaient autrefois derrière un <select> : on n'en voyait qu'un
// à la fois, alors que leur intérêt est justement de se répondre — un pays très
// concentré à l'angle 3 se lit à l'angle 5 comme une dépendance sur une seule
// position HS6. Ils sont donc empilés, et chargés à l'approche du regard : les
// cinq requêtes lancées d'un coup sur des Parquet distants coûteraient plus
// cher que le temps qu'elles font gagner.
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
  sensOptions, viewHead, avertirPoidsMultiStades, noteCommerceNonProduction,
} from "../ui.js";
import { sankey } from "../sankey.js";
import { barChart } from "../charts.js";
import { paletteViz, paletteStades, jeton, onThemeChange } from "../theme.js";
import { analyserPoids, noteQualitePoids, SQL_VALEUR_PESEE } from "../qualite.js";

const AUTRES = "__autres__";
const AUTRES_MIN = "__autres_min__";
const MONDE = "";
// Séparateur des clés composées. Un espace ne conviendrait pas : plusieurs
// minéraux du référentiel en contiennent (« Terres rares », « Niobium, tantale,
// vanadium »), et la clé se retrouverait coupée au mauvais endroit.
const SEP = "\u0001";

// Au-delà de huit rubans colorés simultanés, deux teintes finissent par se
// confondre — y compris pour un œil normal, et davantage sous daltonisme. La
// palette validée compte huit fentes et ne tourne pas : le neuvième minéral
// rejoint « Autres » plutôt que de recevoir une couleur inventée.
const MAX_MINERAUX_COLORES = 8;

const SECTIONS = [
  {
    id: "chaine", num: 1, titre: "Chaîne de valeur",
    question: "Qui vend, à quel stade de transformation, et qui achète ?",
  },
  {
    id: "pays", num: 2, titre: "Dépendance d'un pays",
    question: "Ce que le pays analysé importe, et ce qu'il réexporte.",
  },
  {
    id: "origine", num: 3, titre: "Origine d'un matériau",
    question: "Classement des partenaires, et écart avec leurs propres déclarations.",
  },
  {
    id: "comparer", num: 4, titre: "Comparer des minéraux",
    question: "Plusieurs filières sur une même échelle, du producteur au client.",
  },
  {
    id: "detail", num: 5, titre: "Origine détaillée (HS6 → forme → stade)",
    question: "Le niveau le plus fin : quelle position douanière exactement, sous quelle forme.",
  },
];

// Garde les n premières clés d'une Map par valeur décroissante et regroupe le
// reste sous « Autres », pour que le graphe reste lisible sans masquer de volume.
function garderTop(totaux, n, cleAutres = AUTRES) {
  const tries = [...totaux.entries()].sort((a, b) => b[1] - a[1]);
  const gardes = new Set(tries.slice(0, n).map(([k]) => k));
  return (cle) => (gardes.has(cle) ? cle : cleAutres);
}

const estAutres = (k) => k === AUTRES || k === AUTRES_MIN;

const triDesc = (m) =>
  [...m.entries()].sort((a, b) => (estAutres(a[0]) ? 1 : estAutres(b[0]) ? -1 : b[1] - a[1]));

// Additionne v dans m[cle].
const cumul = (m, cle, v) => m.set(cle, (m.get(cle) || 0) + v);

const slug = (s) => String(s).replace(/\W+/g, "_");
const arrondir = (r) => ({ ...r, mesure: Math.round(r.mesure) });

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
  // Les colonnes de pays et de minéraux sont tronquées, les colonnes de
  // taxonomie (stade, forme) jamais : leur cardinalité est bornée par
  // construction et chacune porte du sens.
  const repli = etapes.map((e, i) => (e.topN ? garderTop(volumes[i], e.topN, e.cleAutres) : (k) => k));
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
    // Une colonne « ordonnée » (stade, forme) suit l'ordre du référentiel.
    // Toute clé présente dans les données mais absente du référentiel est
    // ajoutée à la fin plutôt qu'ignorée : omettre un nœud tout en gardant les
    // liens qui le visent ferait échouer le tracé du diagramme.
    const entrees = e.ordre
      ? [...e.ordre.filter((k) => vols[i].has(k)),
         ...[...vols[i].keys()].filter((k) => !e.ordre.includes(k))].map((k) => [k, vols[i].get(k)])
      : triDesc(vols[i]);
    for (const [cle] of entrees) {
      const auto = estAutres(cle);
      nodes.push({
        id: `${i}:${cle}`, col: i,
        label: auto ? e.labelAutres || "Autres pays" : e.label(cle),
        titre: auto ? e.labelAutres || "Autres pays" : (e.titre ? e.titre(cle) : e.label(cle)),
        couleur: auto ? jeton("--ink-muted", "#8393a7") : e.couleur(cle),
      });
    }
  });
  liens.forEach((m, i) => {
    for (const [k, v] of m) {
      const [a, b] = k.split(SEP);
      // Le ruban prend la couleur de la colonne porteuse de sens : celle qui
      // qualifie la matière, pas celle qui nomme un pays.
      const teinte = etapes[i].teinte
        ? etapes[i].teinte(a)
        : etapes[i + 1].teinte ? etapes[i + 1].teinte(b) : jeton("--viz-1", "#2a78d6");
      links.push({ source: `${i}:${a}`, target: `${i + 1}:${b}`, value: v, couleur: teinte });
    }
  });
  return { nodes, links, volumes: vols };
}

// Recolle les deux demi-graphes du mode « dépendance » : la colonne des stades
// du côté import et celle du côté export doivent devenir un pivot unique,
// sinon le pays analysé n'apparaît pas au centre.
function fusionnerAutourDuPivot(gImp, gExp, nomPivot, couleurPivot) {
  const nodes = [
    ...gImp.nodes.filter((n) => n.col === 0).map((n) => ({ ...n, id: `f:${n.id}` })),
    { id: "pivot", col: 1, label: nomPivot, couleur: couleurPivot },
    ...gExp.nodes.filter((n) => n.col === 1).map((n) => ({ ...n, col: 2, id: `c:${n.id}` })),
  ];
  const links = [
    ...gImp.links.map((l) => ({ ...l, source: `f:${l.source}`, target: "pivot" })),
    ...gExp.links.map((l) => ({ ...l, source: "pivot", target: `c:${l.target}` })),
  ];
  return { nodes, links, volumes: gImp.volumes };
}

export async function mount(container, { labels }) {
  const TOUS_STADES = stades(labels).map((s) => s.id);
  const TOUTES_FORMES = Object.keys(labels.materiaux.formes);
  // Une forme relève toujours du même stade dans le référentiel (un minerai est
  // à l'extraction, une poudre à la transformation) : la correspondance sert à
  // teinter la colonne « forme » avec la couleur du stade qu'elle annonce.
  const stadeDeForme = {};
  for (const m of Object.values(labels.materiaux.codes)) {
    if (!stadeDeForme[m.forme]) stadeDeForme[m.forme] = m.stade;
  }

  container.innerHTML = `
    ${viewHead({
      titre: "Flux de matières critiques",
      lede: `Cinq lectures d'un même flux bilatéral, de la vue d'ensemble à la position douanière.
        Définissez un périmètre de matières et une année, puis faites défiler : chaque section
        répond à une question différente sur exactement les mêmes données.`,
      meta: `Source : déclarations bilatérales UN Comtrade, partenaire réel (jamais l'agrégat
        « Monde »). ${noteCommerceNonProduction()}
        <br><b>Rappel de lecture</b> : les douanes classent par produit, pas par teneur — un tonnage
        de produit fini n'est pas un tonnage de métal contenu.`,
    })}

    <div class="filterbar">
      ${ctrl("Année", selectHTML("fx-annee", anneeOptions(), 2023))}
      ${ctrl("Mesure", selectHTML("fx-metric", metricOptions(), "valeur"))}
      ${ctrl("Pays affichés", selectHTML("fx-top", [
        { value: 8, label: "8" }, { value: 12, label: "12" }, { value: 20, label: "20" },
      ], 12))}
      <div class="ctrl" id="fx-pays-ctrl"><label for="fx-pays">Pays analysé</label>
        ${comboHTML("fx-pays", "Rechercher un pays...")}</div>
      ${ctrl("Sens de lecture", selectHTML("fx-sens", sensOptions(), "M"))}
      <button class="btn" id="fx-go">Actualiser</button>
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

    <nav class="sommaire" id="fx-sommaire" aria-label="Sections de l'analyse">
      <span class="sommaire-lab">Angles</span>
      ${SECTIONS.map((s) => `<a href="#fx-sec-${s.id}" data-vers="${s.id}">${s.num}. ${s.titre}</a>`).join("")}
    </nav>

    ${SECTIONS.map((s) => `
      <section class="section" id="fx-sec-${s.id}" data-sec="${s.id}" aria-labelledby="fx-t-${s.id}">
        <div class="section-head">
          <span class="section-num" aria-hidden="true">${s.num}</span>
          <h3 id="fx-t-${s.id}">${s.titre}</h3>
          <p class="section-q">${s.question}</p>
        </div>
        <div class="note" id="fx-note-${s.id}"></div>
        <div id="fx-hote-${s.id}"></div>
      </section>`).join("")}`;

  const chipsEl = container.querySelector("#fx-chips");
  const resumeEl = container.querySelector("#fx-panier-resume");
  const panierNote = container.querySelector("#fx-panier-note");
  const paysLabel = container.querySelector("#fx-pays-ctrl label");
  // « Monde entier » est une vraie entrée de la liste : sans elle, les angles
  // qui acceptent un périmètre mondial n'auraient aucun moyen de le demander,
  // le combobox portant toujours une valeur.
  const combo = wireCombo("fx-pays",
    [{ value: MONDE, label: "Monde entier" }, ...paysOptions(labels)], { value: "FRA" });

  const lire = (id) => container.querySelector(`#fx-${id}`);
  const valeurs = (id) => [...lire(id).selectedOptions].map((o) => o.value);
  const hoteDe = (id) => container.querySelector(`#fx-hote-${id}`);

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
    lire("forme").addEventListener("change", () => { majPanier(); ecrireHash(); relancer(); });
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
  function ecrireHash(ancre) {
    const p = new URLSearchParams();
    p.set("vue", "flux");
    p.set("an", lire("annee").value);
    p.set("mes", lire("metric").value);
    p.set("top", lire("top").value);
    p.set("sens", lire("sens").value);
    p.set("pays", combo.value);
    if (ancre) p.set("sec", ancre);
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
    if (p.get("vue") !== "flux") return null;
    const poser = (id, cle) => { const v = p.get(cle); if (v !== null) lire(id).value = v; };
    poser("annee", "an"); poser("metric", "mes"); poser("top", "top");
    poser("sens", "sens"); poser("code", "code");
    if (p.get("pays")) combo.set(p.get("pays"));
    const cocher = (select, liste) => {
      for (const o of select.options) o.selected = liste.includes(o.value);
    };
    if (p.get("min")) { cocher(lire("min"), p.get("min").split(",")); msMin.sync(); }
    if (p.get("stade")) { cocher(lire("stade"), p.get("stade").split(",")); msStade.sync(); }
    reconstruireFormes(p.get("forme") ? p.get("forme").split(",") : []);
    // Rétrocompatibilité : les liens partagés avant le dépliage des angles
    // portaient `mode=`. L'angle n'est plus un filtre mais une section — on
    // amène donc le lecteur à la bonne section au lieu d'ignorer le paramètre.
    const sec = p.get("sec") || p.get("mode");
    return SECTIONS.some((s) => s.id === sec) ? sec : null;
  }

  function majAffichage() {
    const estImport = lire("sens").value === "M";
    paysLabel.textContent = "Pays analysé";
    const roleP = estImport ? "importateur" : "exportateur";
    const notes = {
      chaine: `Flux lus sur les <b>déclarations d'exportation</b> : à gauche les pays qui vendent, au centre
        le stade de transformation, à droite les pays qui achètent. Un pays présent des deux côtés
        importe puis réexporte. Cet angle est mondial : il ignore le pays analysé.`,
      pays: `Flux lus sur les <b>déclarations du pays choisi</b> : à gauche ses importations et leur origine,
        à droite ses exportations et leur destination. La couleur des rubans donne le stade, ce qui rend
        visible un pays qui importe du minerai et réexporte du transformé. Cet angle montre les deux
        sens à la fois : le sélecteur « sens de lecture » ne s'y applique pas.`,
      origine: estImport
        ? `Classement des <b>pays d'origine</b>, lu sur les déclarations d'importation du pays analysé. Le
          miroir (ce que ces mêmes pays déclarent exporter vers lui) est affiché à côté : un écart durable
          entre les deux signale une réexportation, un transbordement ou une sous-déclaration.`
        : `Classement des <b>pays de destination</b>, lu sur les déclarations d'exportation du pays analysé.
          Le miroir (ce que ces mêmes pays déclarent importer depuis lui) est affiché à côté : un écart
          durable entre les deux signale une réexportation, un transbordement ou une sous-déclaration.`,
      comparer: `Diagramme alluvial : origines → minéral → stade → destinations. Chaque minéral porte sa
        couleur, ce qui permet de comparer des filières entières sur une même échelle. Au-delà de
        ${MAX_MINERAUX_COLORES} minéraux, les suivants sont regroupés sous « Autres minéraux » —
        deux teintes de plus ne seraient plus distinguables. Angle mondial.`,
      detail: `Niveau le plus fin disponible, pour le pays analysé pris comme <b>${roleP}</b> : chaque
        position HS6 est distinguée, puis rattachée à sa forme (minerai, oxyde, métal brut, demi-produit…)
        et à son stade. La colonne « forme » est ce qui relie une position douanière à un stade
        industriel — voir la note de méthode sous le graphe.`,
    };
    for (const s of SECTIONS) container.querySelector(`#fx-note-${s.id}`).innerHTML = notes[s.id];
  }

  function majChips() {
    const items = [
      { label: "Matières", value: libellePanier(),
        onReset: () => {
          lire("code").value = "";
          for (const o of lire("min").options) o.selected = o.value === "Cuivre";
          msMin.sync(); msStade.setTout(true); reconstruireFormes([]); relancer();
        } },
      { label: "Pays", value: combo.value === MONDE ? "Monde entier" : pays(labels, combo.value),
        onReset: () => { combo.set("FRA"); relancer(); } },
      { label: "Sens", value: lire("sens").selectedOptions[0].text,
        onReset: () => { lire("sens").value = "M"; relancer(); } },
      { label: "Année", value: lire("annee").value,
        onReset: () => { lire("annee").value = "2023"; relancer(); } },
      { label: "Mesure", value: lire("metric").selectedOptions[0].text,
        onReset: () => { lire("metric").value = "valeur"; relancer(); } },
      { label: "Pays affichés", value: lire("top").value,
        onReset: () => { lire("top").value = "12"; relancer(); } },
    ];
    const sts = valeurs("stade");
    if (sts.length < TOUS_STADES.length) {
      items.splice(1, 0, { label: "Stades", value: `${sts.length}/${TOUS_STADES.length}`,
        onReset: () => { msStade.setTout(true); relancer(); } });
    }
    renderChips(chipsEl, items);
  }

  // --- Contexte d'analyse partagé par les cinq sections -------------------
  // Recalculé à chaque rendu de section : c'est le seul endroit où les filtres
  // sont lus, ce qui garantit que les cinq angles décrivent bien le même
  // périmètre même s'ils sont rendus à des instants différents.
  function contexte() {
    const annee = Number(lire("annee").value);
    const metric = lire("metric").value;
    const topN = Number(lire("top").value);
    const iso3 = combo.value;
    const sens = lire("sens").value;
    const estImport = sens === "M";
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
    const minerauxPanier = mineraux(labels).filter((m) => codesPour(labels, { mineraux: [m], codes }).length);
    const mineralSql = caseCodes(Object.fromEntries(
      minerauxPanier.map((m) => [m, codesPour(labels, { mineraux: [m], codes })])));

    // Couleurs de stade : rampe ordinale à teinte unique, du clair au sombre.
    // Les stades sont ordonnés (extraction → produit fini) : la clarté porte
    // cet ordre, là où quatre teintes distinctes le laisseraient deviner.
    const viz = paletteViz();
    const stadeP = paletteStades();
    const couleurStade = Object.fromEntries(
      TOUS_STADES.map((s, i) => [s, stadeP[i] || stadeP[stadeP.length - 1]]));
    // Couleur d'un minéral : assignée sur sa position dans le panier trié, et
    // non sur son rang de volume. Un minéral garde ainsi sa couleur quand on
    // change d'année ou de mesure — recolorer les survivants à chaque filtre
    // rendrait toute comparaison d'une vue à l'autre impossible.
    const couleurMineral = Object.fromEntries(
      minerauxPanier.map((m, i) => [m, viz[i % viz.length]]));
    const NEUTRE = jeton("--viz-1", "#2a78d6");

    const disp = (v) => fmtMetric(v, metric);
    const fmt = axisFmt(metric);
    const nomPays = (i) => pays(labels, i);

    const etapeStade = {
      cle: (r) => r.stade, label: (s) => stadeLabel(labels, s),
      couleur: (s) => couleurStade[s] || NEUTRE, teinte: (s) => couleurStade[s] || NEUTRE,
      ordre: TOUS_STADES,
    };
    const etapeForme = {
      cle: (r) => (matiere(labels, r.cmdCode) || {}).forme || "?",
      label: (f) => formeLabel(labels, f),
      titre: (f) => `${formeLabel(labels, f)} — état du produit tel qu'il est déclaré en douane`,
      couleur: (f) => couleurStade[stadeDeForme[f]] || NEUTRE,
      teinte: (f) => couleurStade[stadeDeForme[f]] || NEUTRE,
      ordre: TOUTES_FORMES,
    };
    const etapeCode = {
      cle: (r) => r.cmdCode,
      label: (c) => codeLabel(labels, c),
      titre: (c) => {
        const m = matiere(labels, c) || {};
        return `${c} — ${codeLabel(labels, c)} (${m.mineral || "?"}, ${m.forme ? formeLabel(labels, m.forme) : "?"})`;
      },
      couleur: (c) => couleurStade[(matiere(labels, c) || {}).stade] || NEUTRE,
      teinte: (c) => couleurStade[(matiere(labels, c) || {}).stade] || NEUTRE,
      topN: 14,
      labelAutres: "Autres positions",
    };
    const etapeMineral = {
      cle: (r) => r.mineral, label: (m) => m,
      couleur: (m) => couleurMineral[m] || NEUTRE, teinte: (m) => couleurMineral[m] || NEUTRE,
      topN: MAX_MINERAUX_COLORES,
      cleAutres: AUTRES_MIN,
      labelAutres: "Autres minéraux",
    };
    const etapePays = (cle) => ({
      cle: (r) => r[cle], label: nomPays, couleur: () => NEUTRE, topN,
    });

    return {
      annee, metric, topN, iso3, sens, estImport, codes, cible, SRC, base,
      stadeSql, mineralSql, stadesPanier, minerauxPanier, couleurStade, couleurMineral,
      NEUTRE, disp, fmt, nomPays,
      etapeStade, etapeForme, etapeCode, etapeMineral, etapePays,
      portee: iso3 === MONDE ? null : iso3,
    };
  }

  // --- Rendu commun aux sections à diagramme -----------------------------
  function afficher(hote, ctx, { kpis, titre, graphe, entetes, lignes, colonnes, fichier, legende, apres }) {
    hote.innerHTML = "";
    const kpiWrap = document.createElement("div");
    kpiWrap.innerHTML = kpisHTML(kpis, 3) +
      avertirPoidsMultiStades(ctx.metric, ctx.stadesPanier,
        ctx.stadesPanier.map((s) => stadeLabel(labels, s)));
    hote.appendChild(kpiWrap);

    const cSankey = card(titre, "fx-sankey");
    hote.appendChild(cSankey);
    const corps = cSankey.querySelector(".card-body");
    const items = legende || ctx.stadesPanier
      .map((s) => ({ label: stadeLabel(labels, s), couleur: ctx.couleurStade[s] }));
    corps.insertAdjacentHTML("beforeend", `<div class="legende">${items
      .map((i) => `<span class="legende-item"><i style="background:${i.couleur}"></i>${i.label}</span>`)
      .join("")}</div>`);
    const hoteSvg = document.createElement("div");
    corps.appendChild(hoteSvg);
    sankey(hoteSvg, graphe, { fmt: ctx.disp, entetes });

    if (apres) apres(hote);

    const tri = lignes.filter((r) => r.mesure > 0).sort((a, b) => b.mesure - a.mesure).slice(0, 50);
    const cTable = card("Principaux flux détaillés (50 premiers)", "fx-table");
    hote.appendChild(cTable);
    renderTable(cTable.querySelector(".card-body"), colonnes, tri);

    brancherExport(cSankey, `${fichier}.csv`, tri.map(arrondir));
    brancherExport(cTable, `${fichier}_table.csv`, tri.map(arrondir));
  }

  function brancherExport(carte, nom, donnees) {
    carte.querySelector("[data-export]").addEventListener("click", () => downloadCsv(nom, donnees));
  }

  // ------------------------------------------------------------- 1. chaîne
  async function rendreChaine(hote, ctx) {
    const lignes = await query(`
      SELECT reporterISO3 AS exp, partnerISO3 AS imp, ${ctx.stadeSql} AS stade,
             SUM(primaryValue) valeur, SUM(netWgt) poids
      FROM ${ctx.SRC} WHERE ${ctx.base} AND flowCode = 'X'
      GROUP BY 1, 2, 3`);
    const graphe = grapheAlluvial(lignes, ctx.metric, [ctx.etapePays("exp"), ctx.etapeStade, ctx.etapePays("imp")]);

    const total = [...graphe.volumes[0].values()].reduce((s, v) => s + v, 0);
    const top5 = [...graphe.volumes[0].entries()].filter(([k]) => !estAutres(k))
      .sort((a, b) => b[1] - a[1]).slice(0, 5).reduce((s, [, v]) => s + v, 0);
    const brut = graphe.volumes[1].get("extraction") || 0;
    afficher(hote, ctx, {
      kpis: [
        { label: `Échanges mondiaux ${ctx.annee}`, value: ctx.disp(total) },
        { label: "Part au stade extraction", value: pct(brut, total) },
        { label: "Concentration (5 premiers exportateurs)", value: pct(top5, total),
          cls: total && top5 / total > 0.7 ? "neg" : "" },
      ],
      titre: `Chaîne de valeur : ${ctx.cible} (${ctx.annee})`,
      graphe,
      entetes: ["Pays exportateurs", "Stade de transformation", "Pays importateurs"],
      lignes: lignes.map((r) => ({
        exportateur: ctx.nomPays(r.exp), importateur: ctx.nomPays(r.imp),
        stade: stadeLabel(labels, r.stade), mesure: r[ctx.metric] || 0,
      })),
      colonnes: [
        { key: "exportateur", label: "Exportateur" },
        { key: "importateur", label: "Importateur" },
        { key: "stade", label: "Stade" },
        { key: "mesure", label: ctx.metric === "poids" ? "Poids" : "Valeur", render: (r) => `<span>${ctx.disp(r.mesure)}</span>` },
      ],
      fichier: `flux_chaine_${slug(ctx.cible)}_${ctx.annee}`,
    });
  }

  // --------------------------------------------------------- 2. dépendance
  async function rendrePays(hote, ctx) {
    // Cet angle décrit la position d'UN pays : sans pays, il n'a pas d'objet.
    if (!ctx.portee) {
      hote.innerHTML = `<div class="empty">Choisissez un pays à analyser : cet angle décrit ses
        importations et ses exportations. Pour une lecture mondiale, voyez « Chaîne de valeur »
        ou « Comparer des minéraux ».</div>`;
      return;
    }
    const lignes = await query(`
      SELECT partnerISO3 AS autre, ${ctx.stadeSql} AS stade, flowCode,
             SUM(primaryValue) valeur, SUM(netWgt) poids
      FROM ${ctx.SRC} WHERE ${ctx.base} AND reporterISO3 = ${sqlStr(ctx.portee)}
      GROUP BY 1, 2, 3`);
    const imports = lignes.filter((r) => r.flowCode === "M");
    const exports = lignes.filter((r) => r.flowCode === "X");

    // Deux demi-graphes autour d'un pivot commun : le pays analysé.
    const gImp = grapheAlluvial(imports, ctx.metric, [ctx.etapePays("autre"), ctx.etapeStade]);
    const gExp = grapheAlluvial(exports, ctx.metric, [ctx.etapeStade, ctx.etapePays("autre")]);
    const graphe = fusionnerAutourDuPivot(gImp, gExp, ctx.nomPays(ctx.portee), ctx.NEUTRE);

    const totalImp = imports.reduce((s, r) => s + (r[ctx.metric] || 0), 0);
    const totalExp = exports.reduce((s, r) => s + (r[ctx.metric] || 0), 0);
    const parOrigine = new Map();
    for (const r of imports) cumul(parOrigine, r.autre, r[ctx.metric] || 0);
    const top3 = [...parOrigine.values()].sort((a, b) => b - a).slice(0, 3).reduce((s, v) => s + v, 0);
    afficher(hote, ctx, {
      kpis: [
        { label: `Importations ${ctx.annee}`, value: ctx.disp(totalImp) },
        { label: `Exportations ${ctx.annee}`, value: ctx.disp(totalExp) },
        { label: "Concentration des importations (3 premières origines)", value: pct(top3, totalImp),
          cls: totalImp && top3 / totalImp > 0.7 ? "neg" : "" },
      ],
      titre: `${ctx.nomPays(ctx.portee)} : importations et exportations, ${ctx.cible} (${ctx.annee})`,
      graphe,
      entetes: ["Importations (origines)", ctx.nomPays(ctx.portee), "Exportations (destinations)"],
      lignes: lignes.map((r) => ({
        sens: r.flowCode === "M" ? "Importation" : "Exportation",
        partenaire: ctx.nomPays(r.autre), stade: stadeLabel(labels, r.stade), mesure: r[ctx.metric] || 0,
      })),
      colonnes: [
        { key: "sens", label: "Sens" },
        { key: "partenaire", label: "Partenaire" },
        { key: "stade", label: "Stade" },
        { key: "mesure", label: ctx.metric === "poids" ? "Poids" : "Valeur", render: (r) => `<span>${ctx.disp(r.mesure)}</span>` },
      ],
      fichier: `flux_pays_${ctx.portee}_${slug(ctx.cible)}_${ctx.annee}`,
    });
  }

  // ------------------------------------------------------------ 3. origine
  async function rendreOrigine(hote, ctx) {
    const { portee, estImport, sens } = ctx;
    const inverse = estImport ? "X" : "M";
    // Côté « partenaire » du flux déclaré : origine à l'import, destination à
    // l'export. Le miroir se lit toujours dans l'autre sens et depuis l'autre
    // déclarant, ce qui est précisément ce qui rend l'écart informatif.
    const motPartenaire = estImport ? "origine" : "destination";
    const motPartenaires = estImport ? "Pays d'origine" : "Pays de destination";

    // Les trois requêtes sont indépendantes : les enchaîner en série ajoutait
    // deux allers-retours d'attente pure avant le premier pixel affiché.
    const [flux, miroir, parCode] = await Promise.all([
      query(`
        SELECT partnerISO3 AS partenaire, ${ctx.stadeSql} AS stade,
               SUM(primaryValue) valeur, SUM(netWgt) poids, ${SQL_VALEUR_PESEE}
        FROM ${ctx.SRC} WHERE ${ctx.base} AND flowCode = ${sqlStr(sens)}
        ${portee ? `AND reporterISO3 = ${sqlStr(portee)}` : ""}
        GROUP BY 1, 2`),
      query(`
        SELECT reporterISO3 AS partenaire, SUM(primaryValue) valeur, SUM(netWgt) poids
        FROM ${ctx.SRC} WHERE ${ctx.base} AND flowCode = ${sqlStr(inverse)}
        ${portee ? `AND partnerISO3 = ${sqlStr(portee)}` : ""}
        GROUP BY 1`),
      query(`
        SELECT partnerISO3 AS partenaire, cmdCode,
               SUM(primaryValue) valeur, SUM(netWgt) poids
        FROM ${ctx.SRC} WHERE ${ctx.base} AND flowCode = ${sqlStr(sens)}
        ${portee ? `AND reporterISO3 = ${sqlStr(portee)}` : ""}
        GROUP BY 1, 2`),
    ]);

    const parPartenaire = new Map();
    const qualite = new Map();
    for (const r of flux) {
      cumul(parPartenaire, r.partenaire, r[ctx.metric] || 0);
      const q = qualite.get(r.partenaire) || { cle: r.partenaire, valeur: 0, poids: 0, valeurPesee: 0 };
      q.valeur += r.valeur || 0;
      q.poids += r.poids || 0;
      q.valeurPesee += r.valeurPesee || 0;
      qualite.set(r.partenaire, q);
    }
    const noteQualite = noteQualitePoids(analyserPoids([...qualite.values()]),
      { metric: ctx.metric, nomDe: ctx.nomPays });
    const classement = triDesc(parPartenaire).filter(([, v]) => v > 0);
    const total = classement.reduce((s, [, v]) => s + v, 0);
    const top3 = classement.slice(0, 3).reduce((s, [, v]) => s + v, 0);
    const parMiroir = new Map();
    for (const r of miroir) cumul(parMiroir, r.partenaire, r[ctx.metric] || 0);

    hote.innerHTML = "";
    const libelleTotal = portee
      ? `${estImport ? "Importations" : "Exportations"} de ${ctx.nomPays(portee)} en ${ctx.annee}`
      : `${estImport ? "Importations" : "Exportations"} mondiales ${ctx.annee}`;
    const kpiWrap = document.createElement("div");
    kpiWrap.innerHTML = kpisHTML([
      { label: libelleTotal, value: ctx.disp(total) },
      { label: `Pays de ${motPartenaire} actifs`, value: String(classement.length) },
      { label: `Concentration (3 premières ${estImport ? "origines" : "destinations"})`, value: pct(top3, total),
        cls: total && top3 / total > 0.7 ? "neg" : "" },
    ], 3) + avertirPoidsMultiStades(ctx.metric, ctx.stadesPanier,
      ctx.stadesPanier.map((s) => stadeLabel(labels, s))) + noteQualite;
    hote.appendChild(kpiWrap);

    const top = classement.slice(0, 20);
    const cBar = card(`Principaux pays de ${motPartenaire} : ${ctx.cible} (${ctx.annee})`, "fx-origine-bar");
    hote.appendChild(cBar);
    barChart(cBar.querySelector(".card-body"), top.map(([k]) => ctx.nomPays(k)),
      top.map(([, v]) => v), ctx.metric === "poids" ? "Poids" : "Valeur", ctx.fmt);

    const cTable = card(`${motPartenaires}, part et miroir des déclarations`, "fx-origine-table");
    hote.appendChild(cTable);
    const lignesTable = top.map(([k, v], i) => ({
      rang: i + 1, partenaire: ctx.nomPays(k), iso3: k, mesure: v, part: pct(v, total),
      miroir: parMiroir.has(k) ? ctx.disp(parMiroir.get(k)) : "non déclaré",
      ecart: parMiroir.get(k) ? pct(Math.abs(parMiroir.get(k) - v), v) : "—",
    }));
    renderTable(cTable.querySelector(".card-body"), [
      { key: "rang", label: "Rang" },
      { key: "partenaire", label: motPartenaires },
      { key: "mesure", label: ctx.metric === "poids"
          ? (estImport ? "Poids importé" : "Poids exporté")
          : (estImport ? "Valeur importée" : "Valeur exportée"),
        render: (r) => `<span>${ctx.disp(r.mesure)}</span>` },
      { key: "part", label: "Part" },
      { key: "miroir", label: estImport ? "Déclaré à l'export par l'origine" : "Déclaré à l'import par la destination" },
      { key: "ecart", label: "Écart au miroir" },
    ], lignesTable);

    // Quel produit précis, et à quel stade : c'est ce qui distingue un pays
    // qui vend son minerai d'un pays qui vend du métal raffiné.
    const parCodeTot = new Map();
    for (const r of parCode) cumul(parCodeTot, r.partenaire + SEP + r.cmdCode, r[ctx.metric] || 0);
    const detail = triDesc(parCodeTot).slice(0, 30).map(([k, v]) => {
      const [org, code] = k.split(SEP);
      const m = matiere(labels, code) || {};
      return {
        partenaire: ctx.nomPays(org), code, produit: codeLabel(labels, code),
        mineral: m.mineral || "—", stade: m.stade ? stadeLabel(labels, m.stade) : "—",
        forme: m.forme ? formeLabel(labels, m.forme) : "—", mesure: v,
      };
    });
    const cDetail = card("Détail par position HS6 (30 premiers flux)", "fx-origine-detail");
    hote.appendChild(cDetail);
    renderTable(cDetail.querySelector(".card-body"), [
      { key: "partenaire", label: estImport ? "Origine" : "Destination" },
      { key: "code", label: "Code HS6" },
      { key: "produit", label: "Produit" },
      { key: "stade", label: "Stade" },
      { key: "forme", label: "Forme" },
      { key: "mesure", label: ctx.metric === "poids" ? "Poids" : "Valeur", render: (r) => `<span>${ctx.disp(r.mesure)}</span>` },
    ], detail);

    const fichier = `flux_${estImport ? "origine" : "destination"}_${portee || "monde"}_${slug(ctx.cible)}_${ctx.annee}`;
    brancherExport(cBar, `${fichier}.csv`, lignesTable.map(arrondir));
    brancherExport(cTable, `${fichier}_table.csv`, lignesTable.map(arrondir));
    brancherExport(cDetail, `${fichier}_hs6.csv`, detail.map(arrondir));
  }

  // ----------------------------------------------------------- 4. comparer
  async function rendreComparer(hote, ctx) {
    const lignes = await query(`
      SELECT reporterISO3 AS exp, partnerISO3 AS imp,
             ${ctx.mineralSql} AS mineral, ${ctx.stadeSql} AS stade,
             SUM(primaryValue) valeur, SUM(netWgt) poids
      FROM ${ctx.SRC} WHERE ${ctx.base} AND flowCode = 'X'
      GROUP BY 1, 2, 3, 4`);
    const graphe = grapheAlluvial(lignes, ctx.metric,
      [ctx.etapePays("exp"), ctx.etapeMineral, ctx.etapeStade, ctx.etapePays("imp")]);

    const total = [...graphe.volumes[1].values()].reduce((s, v) => s + v, 0);
    const parMineral = triDesc(graphe.volumes[1]);
    afficher(hote, ctx, {
      kpis: [
        { label: `Échanges ${ctx.annee}`, value: ctx.disp(total) },
        { label: "Minéraux comparés", value: String(ctx.minerauxPanier.length) },
        { label: "Premier minéral",
          value: parMineral.length ? `${parMineral[0][0] === AUTRES_MIN ? "Autres" : parMineral[0][0]} (${pct(parMineral[0][1], total)})` : "—" },
      ],
      titre: `Comparaison de minéraux : ${ctx.cible} (${ctx.annee})`,
      graphe,
      entetes: ["Pays exportateurs", "Minéral", "Stade", "Pays importateurs"],
      legende: parMineral.map(([m]) => ({
        label: m === AUTRES_MIN ? "Autres minéraux" : m,
        couleur: m === AUTRES_MIN ? jeton("--ink-muted", "#8393a7") : ctx.couleurMineral[m] || ctx.NEUTRE,
      })),
      lignes: lignes.map((r) => ({
        exportateur: ctx.nomPays(r.exp), importateur: ctx.nomPays(r.imp), mineral: r.mineral,
        stade: stadeLabel(labels, r.stade), mesure: r[ctx.metric] || 0,
      })),
      colonnes: [
        { key: "exportateur", label: "Exportateur" },
        { key: "importateur", label: "Importateur" },
        { key: "mineral", label: "Minéral" },
        { key: "stade", label: "Stade" },
        { key: "mesure", label: ctx.metric === "poids" ? "Poids" : "Valeur", render: (r) => `<span>${ctx.disp(r.mesure)}</span>` },
      ],
      fichier: `flux_comparaison_${slug(ctx.cible)}_${ctx.annee}`,
    });
  }

  // ------------------------------------------------------------- 5. détail
  async function rendreDetail(hote, ctx) {
    const { portee, estImport, sens } = ctx;
    // Le pays analysé est toujours le DÉCLARANT ; ce qui change avec le sens,
    // c'est le côté du graphe où il se place. À l'import il est le point
    // d'arrivée, à l'export le point de départ.
    const colDepart = estImport ? "partnerISO3" : "reporterISO3";
    const colArrivee = estImport ? "reporterISO3" : "partnerISO3";
    const lignes = await query(`
      SELECT ${colDepart} AS depart, ${colArrivee} AS arrivee, cmdCode,
             ${ctx.stadeSql} AS stade, SUM(primaryValue) valeur, SUM(netWgt) poids
      FROM ${ctx.SRC} WHERE ${ctx.base} AND flowCode = ${sqlStr(sens)}
      ${portee ? `AND reporterISO3 = ${sqlStr(portee)}` : ""}
      GROUP BY 1, 2, 3, 4`);

    // Cinq colonnes : la forme s'intercale entre la position douanière et le
    // stade industriel. C'est elle qui explique le rattachement — sans elle, le
    // saut d'un code HS6 à un stade reste une affirmation invérifiable.
    const graphe = grapheAlluvial(lignes, ctx.metric,
      [ctx.etapePays("depart"), ctx.etapeCode, ctx.etapeForme, ctx.etapeStade, ctx.etapePays("arrivee")]);

    const total = [...graphe.volumes[0].values()].reduce((s, v) => s + v, 0);
    const codesActifs = [...new Set(lignes.filter((r) => (r[ctx.metric] || 0) > 0).map((r) => r.cmdCode))];
    const libelleTotal = portee
      ? `${estImport ? "Importations" : "Exportations"} de ${ctx.nomPays(portee)} en ${ctx.annee}`
      : `${estImport ? "Importations" : "Exportations"} mondiales ${ctx.annee}`;

    afficher(hote, ctx, {
      kpis: [
        { label: libelleTotal, value: ctx.disp(total) },
        { label: "Positions HS6 actives", value: String(codesActifs.length) },
        { label: "Part au stade extraction", value: pct(graphe.volumes[3].get("extraction") || 0, total) },
      ],
      titre: `Origine détaillée : ${ctx.cible} (${ctx.annee})`,
      graphe,
      entetes: estImport
        ? ["Pays d'origine", "Position HS6", "Forme du produit", "Stade", "Pays destinataires"]
        : ["Pays exportateur", "Position HS6", "Forme du produit", "Stade", "Pays de destination"],
      apres: (h) => h.appendChild(blocMethode(ctx, codesActifs)),
      lignes: lignes.map((r) => {
        const m = matiere(labels, r.cmdCode) || {};
        return {
          depart: ctx.nomPays(r.depart), arrivee: ctx.nomPays(r.arrivee), code: r.cmdCode,
          produit: codeLabel(labels, r.cmdCode), mineral: m.mineral || "—",
          stade: stadeLabel(labels, r.stade), forme: m.forme ? formeLabel(labels, m.forme) : "—",
          mesure: r[ctx.metric] || 0,
        };
      }),
      colonnes: [
        { key: "depart", label: estImport ? "Origine" : "Exportateur" },
        { key: "arrivee", label: estImport ? "Destinataire" : "Destination" },
        { key: "code", label: "Code HS6" },
        { key: "produit", label: "Produit" },
        { key: "forme", label: "Forme" },
        { key: "stade", label: "Stade" },
        { key: "mesure", label: ctx.metric === "poids" ? "Poids" : "Valeur", render: (r) => `<span>${ctx.disp(r.mesure)}</span>` },
      ],
      fichier: `flux_detail_${portee || "monde"}_${slug(ctx.cible)}_${ctx.annee}`,
    });
  }

  // Note de méthode + table d'affectation : rendent vérifiable le passage
  // d'une position douanière à un stade industriel, qui est autrement le seul
  // endroit du graphe où le lecteur doit croire l'application sur parole.
  function blocMethode(ctx, codesActifs) {
    const bloc = document.createElement("div");

    const note = document.createElement("div");
    note.className = "note methodo";
    note.innerHTML = `<b>Comment une position HS6 est rattachée à un stade.</b>
      Chaque code du périmètre porte, dans le référentiel <code>materiaux_fr.json</code>, un triplet
      (minéral, forme, stade). La <b>forme</b> décrit l'état physico-chimique du produit tel qu'il est
      déclaré en douane — minerai, concentré, oxyde, sel, métal brut, alliage, poudre, demi-produit,
      déchet, produit fini. Le <b>stade</b> en est le regroupement industriel. L'affectation est
      expertisée code par code dans <code>scraper/config.py</code>, jamais déduite du libellé
      douanier : deux positions d'un même chapitre HS peuvent relever de stades différents.
      <br><b>Ordre d'affichage.</b> Les colonnes « forme » et « stade » suivent l'ordre industriel du
      référentiel (extraction → produit fini), jamais le volume : leur ordre <i>est</i> une
      information. Les colonnes de pays et de positions HS6 sont classées par volume décroissant,
      tronquées aux ${ctx.topN} et 14 premières, le reste regroupé sous « Autres » — regroupé, jamais
      retiré, pour que les totaux restent justes.`;
    bloc.appendChild(note);

    const affect = codesActifs.map((code) => {
      const m = matiere(labels, code) || {};
      return {
        code, produit: codeLabel(labels, code), mineral: m.mineral || "—",
        forme: m.forme ? formeLabel(labels, m.forme) : "—",
        stade: m.stade ? stadeLabel(labels, m.stade) : "—",
      };
    }).sort((a, b) => a.code.localeCompare(b.code));

    const det = document.createElement("details");
    det.className = "panier";
    det.innerHTML = `<summary>Table d'affectation des ${affect.length} position${affect.length > 1 ? "s" : ""} HS6 affichée${affect.length > 1 ? "s" : ""}
      <span>— code, produit, minéral, forme, stade</span></summary>`;
    const corps = document.createElement("div");
    corps.style.padding = "0 16px 14px";
    det.appendChild(corps);
    renderTable(corps, [
      { key: "code", label: "Code HS6" },
      { key: "produit", label: "Produit" },
      { key: "mineral", label: "Minéral" },
      { key: "forme", label: "Forme" },
      { key: "stade", label: "Stade" },
    ], affect);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chart-btn btn-export";
    btn.textContent = "⭳ CSV de l'affectation";
    btn.style.marginTop = "10px";
    btn.addEventListener("click", () => downloadCsv(`affectation_hs6_${slug(ctx.cible)}.csv`, affect));
    corps.appendChild(btn);
    bloc.appendChild(det);
    return bloc;
  }

  const RENDUS = {
    chaine: rendreChaine, pays: rendrePays, origine: rendreOrigine,
    comparer: rendreComparer, detail: rendreDetail,
  };

  // --- Chargement à l'approche du regard ---------------------------------
  // Une génération est incrémentée à chaque changement de filtre : une section
  // n'est à jour que si sa dernière génération rendue est la génération
  // courante. Cela évite à la fois le double lancement d'une même requête et
  // l'affichage d'un résultat périmé arrivé après un changement de filtre.
  let generation = 0;
  const rendues = new Map();

  async function rendreSection(id) {
    if (rendues.get(id) === generation) return;
    const g = generation;
    rendues.set(id, g);
    const hote = hoteDe(id);
    skeletonKpis(hote, 3);
    try {
      await RENDUS[id](hote, contexte());
    } catch (e) {
      console.error(`Section « ${id} » :`, e);
      hote.innerHTML = `<div class="empty">Cette section n'a pas pu être calculée : ${e.message}</div>`;
      rendues.delete(id);
      return;
    }
    // Les filtres ont bougé pendant la requête : ce qui vient d'être affiché ne
    // décrit plus la sélection, on recommence.
    if (g !== generation) rendreSection(id);
  }

  const visibles = new Set();
  const observateur = new IntersectionObserver((entrees) => {
    for (const e of entrees) {
      const id = e.target.dataset.sec;
      if (e.isIntersecting) { visibles.add(id); rendreSection(id); }
      else visibles.delete(id);
    }
    // Amorce : la première section est rendue même si l'observateur n'a encore
    // rien signalé (fenêtre très haute, page ouverte au milieu…).
  }, { rootMargin: "320px 0px" });

  // Surligne l'entrée du sommaire correspondant à la section en cours de
  // lecture. Marge inférieure large : la section « courante » est celle dont le
  // titre vient de passer sous la barre, pas celle qui affleure en bas d'écran.
  const liens = [...container.querySelectorAll("#fx-sommaire a")];
  const observateurSommaire = new IntersectionObserver((entrees) => {
    for (const e of entrees) {
      if (!e.isIntersecting) continue;
      const id = e.target.dataset.sec;
      liens.forEach((a) => a.setAttribute("aria-current", a.dataset.vers === id ? "true" : "false"));
    }
  }, { rootMargin: "-150px 0px -65% 0px" });

  for (const s of SECTIONS) {
    const el = container.querySelector(`#fx-sec-${s.id}`);
    observateur.observe(el);
    observateurSommaire.observe(el);
  }

  // Invalide les cinq sections et relance celles qui sont sous les yeux.
  function relancer() {
    generation += 1;
    majAffichage();
    majPanier();
    majChips();
    ecrireHash();
    for (const s of SECTIONS) {
      if (visibles.has(s.id)) rendreSection(s.id);
      else hoteDe(s.id).innerHTML = "";
    }
    // Si rien n'est encore signalé visible (premier rendu), on amorce la
    // première section : sans cela la page resterait vide jusqu'au défilement.
    if (!visibles.size) rendreSection(SECTIONS[0].id);
  }

  // --- Câblage ------------------------------------------------------------
  container.querySelector("#fx-go").addEventListener("click", relancer);
  lire("min").addEventListener("change", () => { reconstruireFormes(); relancer(); });
  lire("stade").addEventListener("change", relancer);
  lire("forme").addEventListener("change", relancer);
  // Saisir un code neutralise le reste du panier : l'afficher encore actif
  // laisserait croire à un filtre qui n'est pas celui appliqué.
  lire("code").addEventListener("input", () => { majPanier(); majChips(); });
  lire("code").addEventListener("keydown", (e) => { if (e.key === "Enter") relancer(); });
  ["annee", "metric", "top", "sens"].forEach((id) => lire(id).addEventListener("change", relancer));
  combo.onChange(relancer);

  for (const a of liens) {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      const id = a.dataset.vers;
      container.querySelector(`#fx-sec-${id}`).scrollIntoView({ behavior: "smooth", block: "start" });
      ecrireHash(id);
    });
  }

  // Les SVG portent des couleurs en attributs : contrairement au CSS, elles ne
  // suivent pas le changement de thème. Les requêtes étant mémoïsées, ce
  // redessin ne relit aucune donnée sur le réseau.
  onThemeChange(() => { if (container.isConnected) relancer(); });

  const ancre = lireHash();
  relancer();
  if (ancre) {
    // Le défilement attend le rendu : la position d'une section dépend de la
    // hauteur des précédentes, encore inconnue tant qu'elles sont vides.
    requestAnimationFrame(() =>
      container.querySelector(`#fx-sec-${ancre}`)?.scrollIntoView({ block: "start" }));
  }
}
