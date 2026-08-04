// Vue « Europe » : un minéral, lu à trois échelles emboîtées.
//
//   1. Mondiale    — qui produit, qui achète, à l'échelle du monde.
//   2. Européenne  — l'UE face au reste du monde, flux extra-UE seulement.
//   3. Intra-UE    — ce que les États membres s'échangent entre eux.
//
// C'est une progression, pas trois graphes indépendants : on part du décor
// mondial, on y situe l'Union, puis on ouvre l'Union. Un seul minéral à la
// fois — superposer plusieurs filières sur une carte de flux la rendrait
// illisible, et les volumes de deux minéraux ne sont pas comparables.
//
// L'identité comptable qui tient l'ensemble :
//     importations extra-UE  +  importations intra-UE
//   = total des importations déclarées par les États membres
// Les deux premières sont mesurées séparément (partenaire hors UE / dans l'UE)
// sur les mêmes déclarations d'importation, ce qui la rend vérifiable — un KPI
// l'affiche explicitement en section 3.
import { query, srcCritical, srcCriticalAgg, clauseCodes, caseCodes } from "../db.js";
import { fmtMetric, axisFmt, pct, downloadCsv } from "../format.js";
import { pays, stades, stadeLabel, codesPour, mineraux } from "../labels.js";
import {
  selectHTML, anneeOptions, metricOptions, ctrl, kpisHTML, renderTable, card,
  renderChips, skeletonKpis, mineralOptions, stadeOptions, multiSelectHTML,
  wireMultiSelect, viewHead, ANNEES, avertirPoidsMultiStades, noteCommerceNonProduction,
} from "../ui.js";
import { diagrammeFlux } from "../diagramme-flux.js";
import { barChart, stackedBarChart, stackedBar100 } from "../charts.js";
import {
  estUE27, PERIMETRES, clausePerimetre, libellePerimetre,
  centroides, CADRES, couronne,
} from "../geo.js";
import { paletteStades, jeton, onThemeChange } from "../theme.js";
import { analyserPoids, noteQualitePoids, SQL_VALEUR_PESEE } from "../qualite.js";

const SECTIONS = [
  {
    id: "monde", num: 1, titre: "Échelle mondiale",
    question: "Le décor : qui vend, qui achète, et à quel point le marché est concentré.",
  },
  {
    id: "ue", num: 2, titre: "L'Union face au monde",
    question: "L'UE agrégée en un seul acteur, et ses partenaires extérieurs. Flux intra-UE exclus.",
  },
  {
    id: "intra", num: 3, titre: "À l'intérieur de l'Union",
    question: "Ce que les États membres s'achètent entre eux, et à quel stade de transformation.",
  },
];

const NB_BULLES_MONDE = 14;
const NB_PARTENAIRES = 10;
const NB_FLECHES = 22;
const NB_BARRES = 8;

let _geo = null;
async function geo() {
  if (!_geo) _geo = await (await fetch("vendor/world.geo.json")).json();
  return _geo;
}

export async function mount(container, { labels }) {
  const TOUS_STADES = stades(labels).map((s) => s.id);
  const TOUS_MINERAUX = mineraux(labels);
  const defautMineral = TOUS_MINERAUX.includes("Cuivre") ? "Cuivre" : TOUS_MINERAUX[0];

  container.innerHTML = `
    ${viewHead({
      titre: "L'Europe dans les chaînes de matières critiques",
      lede: `Un minéral, trois échelles emboîtées : le marché mondial, la position de l'Union face à
        l'extérieur, puis les échanges entre États membres. Les bulles donnent le poids de chaque
        pays, les flèches le sens et l'intensité des échanges.`,
      meta: `${noteCommerceNonProduction()}
        <br>Lecture des bulles : c'est la <b>surface</b> qui est proportionnelle au volume, pas le
        rayon. <b>Périmètre</b> : l'UE27 est le périmètre douanier et réglementaire (CRMA) ;
        l'« Europe géographique » y ajoute le Royaume-Uni, la Norvège, la Suisse, la Serbie, la
        Russie… — utile pour situer un voisinage, trompeur pour mesurer une dépendance de l'Union.`,
    })}

    <div class="filterbar">
      ${ctrl("Minéral", selectHTML("eu-min", mineralOptions(labels), defautMineral), true)}
      ${ctrl("Année", selectHTML("eu-annee", anneeOptions(), 2023))}
      ${ctrl("Mesure", selectHTML("eu-metric", metricOptions(), "valeur"))}
      ${ctrl("Périmètre européen", selectHTML("eu-perimetre", PERIMETRES, "ue27"))}
      <div class="ctrl grow"><label>Stades de la chaîne de valeur</label>
        ${multiSelectHTML("eu-stade", stadeOptions(labels), TOUS_STADES)}</div>
      <button class="btn" id="eu-go">Actualiser</button>
    </div>

    <div class="chips" id="eu-chips" aria-label="Filtres actifs"></div>

    <nav class="sommaire" id="eu-sommaire" aria-label="Échelles d'analyse">
      <span class="sommaire-lab">Échelles</span>
      ${SECTIONS.map((s) => `<a href="#eu-sec-${s.id}" data-vers="${s.id}">${s.num}. ${s.titre}</a>`).join("")}
    </nav>

    ${SECTIONS.map((s) => `
      <section class="section" id="eu-sec-${s.id}" data-sec="${s.id}" aria-labelledby="eu-t-${s.id}">
        <div class="section-head">
          <span class="section-num" aria-hidden="true">${s.num}</span>
          <h3 id="eu-t-${s.id}">${s.titre}</h3>
          <p class="section-q">${s.question}</p>
        </div>
        <div id="eu-hote-${s.id}"></div>
      </section>`).join("")}`;

  const chipsEl = container.querySelector("#eu-chips");
  const lire = (id) => container.querySelector(`#eu-${id}`);
  const valeurs = (id) => [...lire(id).selectedOptions].map((o) => o.value);
  const hoteDe = (id) => container.querySelector(`#eu-hote-${id}`);
  const msStade = wireMultiSelect("eu-stade");

  function majChips() {
    const items = [
      { label: "Minéral", value: lire("min").value,
        onReset: () => { lire("min").value = defautMineral; relancer(); } },
      { label: "Année", value: lire("annee").value,
        onReset: () => { lire("annee").value = "2023"; relancer(); } },
      { label: "Mesure", value: lire("metric").selectedOptions[0].text,
        onReset: () => { lire("metric").value = "valeur"; relancer(); } },
      { label: "Périmètre", value: libellePerimetre(lire("perimetre").value),
        onReset: () => { lire("perimetre").value = "ue27"; relancer(); } },
    ];
    const sts = valeurs("stade");
    if (sts.length < TOUS_STADES.length) {
      items.push({ label: "Stades", value: `${sts.length}/${TOUS_STADES.length}`,
        onReset: () => { msStade.setTout(true); relancer(); } });
    }
    renderChips(chipsEl, items);
  }

  // --- Contexte partagé ---------------------------------------------------
  function contexte() {
    const mineral = lire("min").value;
    const annee = Number(lire("annee").value);
    const metric = lire("metric").value;
    const perimetre = lire("perimetre").value;
    const sts = valeurs("stade");
    const codes = codesPour(labels, { mineraux: [mineral], stades: sts });
    const SRC = srcCritical([annee]);
    const base = `${clauseCodes(codes)}
      AND partnerCode <> '0' AND reporterISO3 IS NOT NULL AND partnerISO3 IS NOT NULL`;
    const stadeSql = caseCodes(Object.fromEntries(
      TOUS_STADES.map((s) => [s, codesPour(labels, { stades: [s], codes })])));
    const stadesPanier = TOUS_STADES.filter((s) => codesPour(labels, { stades: [s], codes }).length);

    const stadeP = paletteStades();
    const couleurStade = Object.fromEntries(
      TOUS_STADES.map((s, i) => [s, stadeP[i] || stadeP[stadeP.length - 1]]));

    // Deux rôles seulement dans ces diagrammes — entrant / sortant — donc deux
    // teintes de la palette validée, jamais davantage : sur un nuage de bulles
    // n'importe quelle paire de couleurs peut se retrouver côte à côte, ce qui
    // est un test bien plus dur que sur des barres voisines.
    const C_IMPORT = jeton("--viz-1", "#2a78d6");
    const C_EXPORT = jeton("--viz-2", "#eb6834");
    const C_PIVOT = jeton("--accent", "#000091");

    return {
      mineral, annee, metric, perimetre, codes, SRC, base, stadeSql, stadesPanier,
      couleurStade, C_IMPORT, C_EXPORT, C_PIVOT,
      avertPoids: avertirPoidsMultiStades(metric, stadesPanier,
        stadesPanier.map((s) => stadeLabel(labels, s))),
      dedans: (col, colCont) => clausePerimetre(perimetre, col, colCont, true),
      dehors: (col, colCont) => clausePerimetre(perimetre, col, colCont, false),
      libPerim: libellePerimetre(perimetre),
      disp: (v) => fmtMetric(v, metric),
      fmt: axisFmt(metric),
      nomPays: (i) => pays(labels, i),
      estDedans: (iso) => (perimetre === "ue27" ? estUE27(iso) : null),
    };
  }

  /**
   * Positions géographiques (lon, lat) des pays du cadre demandé.
   *
   * Les nœuds ne voyagent plus qu'en coordonnées géographiques : le globe s'en
   * sert directement, et `diagramme-flux.js` les projette pour le diagramme.
   * C'est ce qui permet de changer de représentation sans que cette vue en
   * sache quoi que ce soit.
   *
   * Un pays hors cadre (l'Australie sur un cadre européen) n'est pas rabattu
   * sur le bord — il serait posé à une place fausse. Il est écarté et signalé
   * sous le graphe.
   */
  async function positions(cadre) {
    const c = centroides(await geo());
    const limites = CADRES[cadre];
    const out = {};
    for (const [iso, lonlat] of Object.entries(c)) {
      const [lon, lat] = lonlat;
      if (lon < limites.lon[0] || lon > limites.lon[1]) continue;
      if (lat < limites.lat[0] || lat > limites.lat[1]) continue;
      out[iso] = { lon, lat };
    }
    return out;
  }

  const vide = (h, msg) => { h.innerHTML = `<div class="empty">${msg}</div>`; };

  // ---------------------------------------------------- 1. échelle mondiale
  async function rendreMonde(hote, ctx) {
    const [flux, serie] = await Promise.all([
      query(`
        SELECT reporterISO3 AS exp, partnerISO3 AS imp,
               SUM(primaryValue) valeur, SUM(netWgt) poids, ${SQL_VALEUR_PESEE}
        FROM ${ctx.SRC} WHERE ${ctx.base} AND flowCode = 'X'
        GROUP BY 1, 2`),
      serieMondiale(ctx),
    ]);

    if (!flux.length) return vide(hote, `Aucun échange déclaré pour ${ctx.mineral} en ${ctx.annee}.`);

    const parPays = new Map();
    // Valeur et poids sont suivis séparément, quelle que soit la mesure
    // affichée : le contrôle de qualité a besoin des deux pour calculer une
    // valeur unitaire, et c'est elle qui trahit une erreur d'unité.
    const qualite = new Map();
    for (const r of flux) {
      const v = r[ctx.metric] || 0;
      const q = qualite.get(r.exp) || { cle: r.exp, valeur: 0, poids: 0, valeurPesee: 0 };
      q.valeur += r.valeur || 0;
      q.poids += r.poids || 0;
      q.valeurPesee += r.valeurPesee || 0;
      qualite.set(r.exp, q);
      if (v <= 0) continue;
      parPays.set(r.exp, (parPays.get(r.exp) || 0) + v);
    }
    const classement = [...parPays.entries()].sort((a, b) => b[1] - a[1]);
    const total = classement.reduce((s, [, v]) => s + v, 0);
    const top5 = classement.slice(0, 5).reduce((s, [, v]) => s + v, 0);
    const noteQualite = noteQualitePoids(analyserPoids([...qualite.values()]),
      { metric: ctx.metric, nomDe: ctx.nomPays });

    hote.innerHTML = "";
    const kpiWrap = document.createElement("div");
    kpiWrap.innerHTML = kpisHTML([
      { label: `Échanges mondiaux ${ctx.annee}`, value: ctx.disp(total) },
      { label: "Pays exportateurs actifs", value: String(classement.length) },
      { label: "Concentration (5 premiers exportateurs)", value: pct(top5, total),
        cls: total && top5 / total > 0.7 ? "neg" : "" },
    ], 3) + ctx.avertPoids + noteQualite;
    hote.appendChild(kpiWrap);

    // Diagramme : les principaux exportateurs, à leur place géographique.
    const pos = await positions("monde");
    const retenus = classement.slice(0, NB_BULLES_MONDE).map(([iso]) => iso).filter((iso) => pos[iso]);
    const manquants = classement.slice(0, NB_BULLES_MONDE).length - retenus.length;
    const dans = new Set(retenus);
    const liens = flux
      .filter((r) => dans.has(r.exp) && dans.has(r.imp) && (r[ctx.metric] || 0) > 0)
      .sort((a, b) => (b[ctx.metric] || 0) - (a[ctx.metric] || 0))
      .slice(0, NB_FLECHES)
      .map((r) => ({ source: r.exp, target: r.imp, valeur: r[ctx.metric], couleur: ctx.C_IMPORT }));

    const cBul = card(`Principaux échanges mondiaux : ${ctx.mineral} (${ctx.annee})`, "eu-monde-bul");
    hote.appendChild(cBul);
    diagrammeFlux(cBul.querySelector(".card-body"), {
      // Le code ISO3 plutôt que le nom complet : à quatorze bulles sur une
      // carte du monde, les noms se chevauchent. Le nom reste au survol, dans
      // le tableau équivalent et sous le graphe.
      noeuds: retenus.map((iso) => ({
        id: iso, label: iso, titre: ctx.nomPays(iso), valeur: parPays.get(iso),
        lon: pos[iso].lon, lat: pos[iso].lat,
        couleur: ctx.estDedans(iso) ? ctx.C_PIVOT : ctx.C_IMPORT,
      })),
      liens,
    }, {
      fmt: ctx.disp,
      cadre: "monde",
      geojson: await geo(),
      resume: `Les ${retenus.length} premiers exportateurs mondiaux de ${ctx.mineral} en ${ctx.annee}
        et leurs ${liens.length} principaux flux. Les pays du périmètre ${ctx.libPerim} sont en bleu foncé.`,
    });
    cBul.querySelector(".card-body").insertAdjacentHTML("afterbegin",
      `<div class="legende">
        <span class="legende-item"><i style="background:${ctx.C_PIVOT}"></i>${ctx.libPerim}</span>
        <span class="legende-item"><i style="background:${ctx.C_IMPORT}"></i>Reste du monde</span>
      </div>`);
    if (manquants) {
      cBul.querySelector(".card-body").insertAdjacentHTML("beforeend",
        `<div class="note methodo" style="margin-top:10px">${manquants} pays parmi les premiers
         exportateurs ne figurent pas sur le fond de carte (territoires et zones sans polygone
         propre) : ils restent comptés dans les totaux et le classement ci-dessous, mais ne peuvent
         pas être placés sur le diagramme.</div>`);
    }

    const cBar = card(`Concentration : 20 premiers exportateurs de ${ctx.mineral} (${ctx.annee})`, "eu-monde-bar");
    hote.appendChild(cBar);
    const top20 = classement.slice(0, 20);
    barChart(cBar.querySelector(".card-body"), top20.map(([k]) => ctx.nomPays(k)),
      top20.map(([, v]) => v), ctx.metric === "poids" ? "Poids" : "Valeur", ctx.fmt);

    if (serie) {
      const cEvo = card(`Évolution du commerce mondial par stade : ${ctx.mineral}`, "eu-monde-evo");
      hote.appendChild(cEvo);
      stackedBarChart(cEvo.querySelector(".card-body"), ANNEES,
        ctx.stadesPanier.map((s) => ({
          label: stadeLabel(labels, s),
          data: ANNEES.map((y) => serie.get(`${y}|${s}`) || 0),
          couleur: ctx.couleurStade[s],
        })), ctx.fmt);
      cEvo.querySelector("[data-export]").addEventListener("click", () =>
        downloadCsv(`europe_monde_evolution_${ctx.mineral}.csv`,
          ANNEES.flatMap((y) => ctx.stadesPanier.map((s) => ({
            annee: y, stade: stadeLabel(labels, s), mesure: Math.round(serie.get(`${y}|${s}`) || 0),
          })))));
    }

    const lignesCsv = classement.map(([iso, v], i) => ({
      rang: i + 1, pays: ctx.nomPays(iso), iso3: iso, mesure: Math.round(v), part: pct(v, total),
    }));
    cBul.querySelector("[data-export]").addEventListener("click", () =>
      downloadCsv(`europe_monde_${ctx.mineral}_${ctx.annee}.csv`, lignesCsv));
    cBar.querySelector("[data-export]").addEventListener("click", () =>
      downloadCsv(`europe_monde_classement_${ctx.mineral}_${ctx.annee}.csv`, lignesCsv));
  }

  // Série mondiale par année et par stade, lue sur le pré-agrégat (une seule
  // lecture au lieu des 26 partitions du détail). Renvoie null si le
  // pré-agrégat manque : mieux vaut une carte en moins qu'un balayage de 26
  // fichiers pour un graphe d'appoint.
  async function serieMondiale(ctx) {
    try {
      const rows = await query(`
        SELECT period, ${ctx.stadeSql} AS stade,
               SUM(primaryValue) valeur, SUM(netWgt) poids
        FROM ${srcCriticalAgg()} WHERE ${clauseCodes(ctx.codes)} AND flowCode = 'X'
        GROUP BY 1, 2`);
      const m = new Map();
      for (const r of rows) m.set(`${r.period}|${r.stade}`, r[ctx.metric] || 0);
      return m;
    } catch {
      return null;
    }
  }

  // ------------------------------------------------- 2. l'Union face au monde
  async function rendreUE(hote, ctx) {
    const lignes = await query(`
      SELECT partnerISO3 AS partenaire, flowCode, ${ctx.stadeSql} AS stade,
             SUM(primaryValue) valeur, SUM(netWgt) poids
      FROM ${ctx.SRC} WHERE ${ctx.base}
        AND ${ctx.dedans("reporterISO3", "reporterContinent")}
        AND ${ctx.dehors("partnerISO3", "partnerContinent")}
      GROUP BY 1, 2, 3`);

    if (!lignes.length) {
      return vide(hote, `Aucun échange extra-${ctx.libPerim} déclaré pour ${ctx.mineral} en ${ctx.annee}.`);
    }

    const imp = new Map();
    const exp = new Map();
    const parStadeImp = new Map();
    for (const r of lignes) {
      const v = r[ctx.metric] || 0;
      if (v <= 0) continue;
      const cible = r.flowCode === "M" ? imp : exp;
      cible.set(r.partenaire, (cible.get(r.partenaire) || 0) + v);
      if (r.flowCode === "M") {
        parStadeImp.set(`${r.partenaire}|${r.stade}`, (parStadeImp.get(`${r.partenaire}|${r.stade}`) || 0) + v);
      }
    }
    const totalImp = [...imp.values()].reduce((s, v) => s + v, 0);
    const totalExp = [...exp.values()].reduce((s, v) => s + v, 0);
    const origines = [...imp.entries()].sort((a, b) => b[1] - a[1]);
    const top3 = origines.slice(0, 3).reduce((s, [, v]) => s + v, 0);

    hote.innerHTML = "";
    const kpiWrap = document.createElement("div");
    kpiWrap.innerHTML = kpisHTML([
      { label: `Importations extra-${ctx.libPerim} ${ctx.annee}`, value: ctx.disp(totalImp) },
      { label: `Exportations extra-${ctx.libPerim} ${ctx.annee}`, value: ctx.disp(totalExp) },
      { label: "Concentration (3 premières origines)", value: pct(top3, totalImp),
        cls: totalImp && top3 / totalImp > 0.7 ? "neg" : "" },
    ], 3);
    hote.appendChild(kpiWrap);

    // Disposition en couronne : l'Union au centre, les origines sur l'arc
    // gauche, les destinations sur l'arc droit. La géographie n'apporterait
    // rien ici — l'UE n'est pas un point — alors que le sens des échanges, lui,
    // se lit d'un coup d'œil.
    const topImp = origines.slice(0, NB_PARTENAIRES);
    const topExp = [...exp.entries()].sort((a, b) => b[1] - a[1]).slice(0, NB_PARTENAIRES);
    const posImp = couronne(topImp.length, { cx: 0.5, cy: 0.5, rx: 0.42, ry: 0.44, depart: 120, etendue: 120 });
    const posExp = couronne(topExp.length, { cx: 0.5, cy: 0.5, rx: 0.42, ry: 0.44, depart: -60, etendue: 120 });

    const noeuds = [
      { id: "__ue__", label: ctx.libPerim, valeur: Math.max(totalImp, totalExp),
        x: 0.5, y: 0.5, couleur: ctx.C_PIVOT, fixe: true },
      ...topImp.map(([iso, v], i) => ({
        id: `i:${iso}`, label: ctx.nomPays(iso), valeur: v,
        x: posImp[i][0], y: posImp[i][1], couleur: ctx.C_IMPORT,
      })),
      ...topExp.map(([iso, v], i) => ({
        id: `e:${iso}`, label: ctx.nomPays(iso), valeur: v,
        x: posExp[i][0], y: posExp[i][1], couleur: ctx.C_EXPORT,
      })),
    ];
    const liens = [
      ...topImp.map(([iso, v]) => ({ source: `i:${iso}`, target: "__ue__", valeur: v, couleur: ctx.C_IMPORT })),
      ...topExp.map(([iso, v]) => ({ source: "__ue__", target: `e:${iso}`, valeur: v, couleur: ctx.C_EXPORT })),
    ];

    const cBul = card(`${ctx.libPerim} et le reste du monde : ${ctx.mineral} (${ctx.annee})`, "eu-ue-bul");
    hote.appendChild(cBul);
    cBul.querySelector(".card-body").insertAdjacentHTML("beforeend",
      `<div class="legende">
        <span class="legende-item"><i style="background:${ctx.C_IMPORT}"></i>Origines des importations</span>
        <span class="legende-item"><i style="background:${ctx.C_EXPORT}"></i>Destinations des exportations</span>
        <span class="legende-item"><i style="background:${ctx.C_PIVOT}"></i>${ctx.libPerim} (agrégé)</span>
      </div>`);
    const hoteBul = document.createElement("div");
    cBul.querySelector(".card-body").appendChild(hoteBul);
    // Ni fond de carte ni globe ici : la disposition en couronne est
    // délibérément non géographique — l'UE agrégée n'est pas un point sur la
    // carte, et l'y poser serait un mensonge. Elle profite en revanche des
    // nouveaux rubans.
    diagrammeFlux(hoteBul, { noeuds, liens }, {
      fmt: ctx.disp,
      resume: `Échanges extra-${ctx.libPerim} de ${ctx.mineral} en ${ctx.annee} : ${topImp.length}
        origines et ${topExp.length} destinations principales. Les flux entre États membres sont exclus.`,
    });

    // Décomposition produit : de quel STADE est faite la dépendance. Deux pays
    // au même volume mais l'un vendant du minerai et l'autre du métal raffiné
    // ne posent pas du tout le même problème d'approvisionnement.
    const barres = topImp.slice(0, NB_BARRES);
    if (barres.length) {
      const cDec = card(`Composition des importations par origine : ${ctx.mineral} (${ctx.annee})`, "eu-ue-dec");
      hote.appendChild(cDec);
      stackedBar100(cDec.querySelector(".card-body"), barres.map(([iso]) => ctx.nomPays(iso)),
        ctx.stadesPanier.map((s) => ({
          label: stadeLabel(labels, s),
          data: barres.map(([iso]) => parStadeImp.get(`${iso}|${s}`) || 0),
          couleur: ctx.couleurStade[s],
        })), ctx.disp, { horizontal: true });
      cDec.querySelector(".card-body").insertAdjacentHTML("beforeend",
        `<div class="note methodo" style="margin-top:10px">Barres à 100 % : elles montrent des
         <b>parts</b>, pas des volumes. Deux barres de même longueur peuvent représenter des montants
         très différents — le volume de chaque origine est dans le tableau ci-dessous.</div>`);
      cDec.querySelector("[data-export]").addEventListener("click", () =>
        downloadCsv(`europe_ue_composition_${ctx.mineral}_${ctx.annee}.csv`,
          barres.flatMap(([iso]) => ctx.stadesPanier.map((s) => ({
            origine: ctx.nomPays(iso), iso3: iso, stade: stadeLabel(labels, s),
            mesure: Math.round(parStadeImp.get(`${iso}|${s}`) || 0),
          })))));
    }

    const cTable = card(`Partenaires extra-${ctx.libPerim} : ${ctx.mineral} (${ctx.annee})`, "eu-ue-table");
    hote.appendChild(cTable);
    const partenaires = [...new Set([...imp.keys(), ...exp.keys()])]
      .map((iso) => ({
        pays: ctx.nomPays(iso), iso3: iso,
        importe: imp.get(iso) || 0, exporte: exp.get(iso) || 0,
        part: pct(imp.get(iso) || 0, totalImp),
        solde: (imp.get(iso) || 0) - (exp.get(iso) || 0),
      }))
      .sort((a, b) => b.importe - a.importe);
    renderTable(cTable.querySelector(".card-body"), [
      { key: "pays", label: "Partenaire" },
      { key: "importe", label: `${ctx.libPerim} importe`, render: (r) => `<span>${ctx.disp(r.importe)}</span>` },
      { key: "part", label: "Part des importations" },
      { key: "exporte", label: `${ctx.libPerim} exporte`, render: (r) => `<span>${ctx.disp(r.exporte)}</span>` },
      { key: "solde", label: "Solde (import − export)", render: (r) => `<span>${ctx.disp(r.solde)}</span>` },
    ], partenaires);

    const csv = partenaires.map((r) => ({ ...r, importe: Math.round(r.importe), exporte: Math.round(r.exporte), solde: Math.round(r.solde) }));
    cBul.querySelector("[data-export]").addEventListener("click", () =>
      downloadCsv(`europe_ue_${ctx.mineral}_${ctx.annee}.csv`, csv));
    cTable.querySelector("[data-export]").addEventListener("click", () =>
      downloadCsv(`europe_ue_partenaires_${ctx.mineral}_${ctx.annee}.csv`, csv));
  }

  // -------------------------------------------------- 3. à l'intérieur de l'UE
  async function rendreIntra(hote, ctx) {
    // Les deux moitiés de l'identité comptable sont demandées ensemble : c'est
    // ce qui permet de l'afficher, donc de la faire vérifier par le lecteur.
    const [intra, extra] = await Promise.all([
      query(`
        SELECT partnerISO3 AS depart, reporterISO3 AS arrivee, ${ctx.stadeSql} AS stade,
               SUM(primaryValue) valeur, SUM(netWgt) poids
        FROM ${ctx.SRC} WHERE ${ctx.base} AND flowCode = 'M'
          AND ${ctx.dedans("reporterISO3", "reporterContinent")}
          AND ${ctx.dedans("partnerISO3", "partnerContinent")}
        GROUP BY 1, 2, 3`),
      query(`
        SELECT SUM(primaryValue) valeur, SUM(netWgt) poids
        FROM ${ctx.SRC} WHERE ${ctx.base} AND flowCode = 'M'
          AND ${ctx.dedans("reporterISO3", "reporterContinent")}
          AND ${ctx.dehors("partnerISO3", "partnerContinent")}`),
    ]);

    if (!intra.length) {
      return vide(hote, `Aucun échange intra-${ctx.libPerim} déclaré pour ${ctx.mineral} en ${ctx.annee}.`);
    }

    const parImportateur = new Map();
    const parStade = new Map();
    let totalIntra = 0;
    for (const r of intra) {
      const v = r[ctx.metric] || 0;
      if (v <= 0) continue;
      totalIntra += v;
      parImportateur.set(r.arrivee, (parImportateur.get(r.arrivee) || 0) + v);
      parStade.set(`${r.arrivee}|${r.stade}`, (parStade.get(`${r.arrivee}|${r.stade}`) || 0) + v);
    }
    const totalExtra = extra.length ? (extra[0][ctx.metric] || 0) : 0;
    const totalMembres = totalIntra + totalExtra;

    hote.innerHTML = "";
    const kpiWrap = document.createElement("div");
    kpiWrap.innerHTML = kpisHTML([
      { label: `Importations intra-${ctx.libPerim} ${ctx.annee}`, value: ctx.disp(totalIntra) },
      { label: "Part intra dans les importations des membres", value: pct(totalIntra, totalMembres) },
      { label: `Total importé par les membres (intra + extra)`, value: ctx.disp(totalMembres) },
    ], 3);
    hote.appendChild(kpiWrap);

    hote.insertAdjacentHTML("beforeend", `<div class="note methodo">
      <b>Contrôle de cohérence.</b> Importations intra-${ctx.libPerim}
      (<b>${ctx.disp(totalIntra)}</b>) + importations extra-${ctx.libPerim}
      (<b>${ctx.disp(totalExtra)}</b>) = <b>${ctx.disp(totalMembres)}</b>, soit exactement le total
      déclaré à l'importation par les États du périmètre. Les deux moitiés sont mesurées sur les
      mêmes déclarations, séparées par la seule position du partenaire : aucun flux n'est compté
      deux fois, aucun n'est perdu.</div>`);

    const pos = await positions("europe");
    const membres = [...parImportateur.entries()].sort((a, b) => b[1] - a[1]);
    const placables = membres.filter(([iso]) => pos[iso]).slice(0, 27);
    const dans = new Set(placables.map(([iso]) => iso));
    const liens = intra
      .filter((r) => dans.has(r.depart) && dans.has(r.arrivee) && (r[ctx.metric] || 0) > 0)
      .reduce((acc, r) => {
        // Les stades sont additionnés : une flèche par couple de pays, sinon
        // quatre flèches superposées relieraient les deux mêmes bulles.
        const k = `${r.depart}|${r.arrivee}`;
        acc.set(k, (acc.get(k) || 0) + (r[ctx.metric] || 0));
        return acc;
      }, new Map());
    const fleches = [...liens.entries()]
      .map(([k, v]) => ({ k, v }))
      .sort((a, b) => b.v - a.v)
      .slice(0, NB_FLECHES)
      .map(({ k, v }) => {
        const [source, target] = k.split("|");
        return { source, target, valeur: v, couleur: ctx.C_IMPORT };
      });

    const cBul = card(`Échanges entre États membres : ${ctx.mineral} (${ctx.annee})`, "eu-intra-bul");
    hote.appendChild(cBul);
    diagrammeFlux(cBul.querySelector(".card-body"), {
      // 27 bulles serrées sur un cadre européen : les noms complets se
      // chevaucheraient. Le code ISO3 est lisible pour ce public, et le nom
      // complet reste au survol, dans le tableau équivalent et sous le graphe.
      noeuds: placables.map(([iso, v]) => ({
        id: iso, label: iso, titre: ctx.nomPays(iso), valeur: v,
        lon: pos[iso].lon, lat: pos[iso].lat, couleur: ctx.C_PIVOT,
      })),
      liens: fleches,
    }, {
      fmt: ctx.disp,
      cadre: "europe",
      geojson: await geo(),
      // Le globe s'ouvre sur l'Europe, quel que soit le barycentre des
      // volumes : c'est l'objet même de la section.
      centre: { lon: 12, lat: 52 },
      resume: `Importations intra-${ctx.libPerim} de ${ctx.mineral} en ${ctx.annee} :
        ${placables.length} États et leurs ${fleches.length} principaux flux. La bulle donne le
        volume importé par chaque État depuis ses partenaires du périmètre.`,
    });

    const barres = membres.slice(0, NB_BARRES);
    const cDec = card(`Composition des importations intra-${ctx.libPerim} par État (${ctx.annee})`, "eu-intra-dec");
    hote.appendChild(cDec);
    stackedBar100(cDec.querySelector(".card-body"), barres.map(([iso]) => ctx.nomPays(iso)),
      ctx.stadesPanier.map((s) => ({
        label: stadeLabel(labels, s),
        data: barres.map(([iso]) => parStade.get(`${iso}|${s}`) || 0),
        couleur: ctx.couleurStade[s],
      })), ctx.disp, { horizontal: true });

    const cTable = card(`États membres : ${ctx.mineral} (${ctx.annee})`, "eu-intra-table");
    hote.appendChild(cTable);
    const rows = membres.map(([iso, v], i) => ({
      rang: i + 1, pays: ctx.nomPays(iso), iso3: iso, mesure: v, part: pct(v, totalIntra),
    }));
    renderTable(cTable.querySelector(".card-body"), [
      { key: "rang", label: "Rang" },
      { key: "pays", label: "État membre" },
      { key: "mesure", label: `Importé depuis le périmètre`, render: (r) => `<span>${ctx.disp(r.mesure)}</span>` },
      { key: "part", label: "Part de l'intra" },
    ], rows);

    const csv = rows.map((r) => ({ ...r, mesure: Math.round(r.mesure) }));
    for (const c of [cBul, cDec, cTable]) {
      c.querySelector("[data-export]").addEventListener("click", () =>
        downloadCsv(`europe_intra_${ctx.mineral}_${ctx.annee}.csv`, csv));
    }
  }

  const RENDUS = { monde: rendreMonde, ue: rendreUE, intra: rendreIntra };

  // --- Chargement à l'approche du regard (même mécanique que la vue Flux) ---
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
      console.error(`Échelle « ${id} » :`, e);
      hote.innerHTML = `<div class="empty">Cette échelle n'a pas pu être calculée : ${e.message}</div>`;
      rendues.delete(id);
      return;
    }
    if (g !== generation) rendreSection(id);
  }

  const visibles = new Set();
  const observateur = new IntersectionObserver((entrees) => {
    for (const e of entrees) {
      const id = e.target.dataset.sec;
      if (e.isIntersecting) { visibles.add(id); rendreSection(id); }
      else visibles.delete(id);
    }
  }, { rootMargin: "320px 0px" });

  const liens = [...container.querySelectorAll("#eu-sommaire a")];
  const observateurSommaire = new IntersectionObserver((entrees) => {
    for (const e of entrees) {
      if (!e.isIntersecting) continue;
      const id = e.target.dataset.sec;
      liens.forEach((a) => a.setAttribute("aria-current", a.dataset.vers === id ? "true" : "false"));
    }
  }, { rootMargin: "-150px 0px -65% 0px" });

  for (const s of SECTIONS) {
    const el = container.querySelector(`#eu-sec-${s.id}`);
    observateur.observe(el);
    observateurSommaire.observe(el);
  }

  function relancer() {
    generation += 1;
    majChips();
    for (const s of SECTIONS) {
      if (visibles.has(s.id)) rendreSection(s.id);
      else hoteDe(s.id).innerHTML = "";
    }
    if (!visibles.size) rendreSection(SECTIONS[0].id);
  }

  container.querySelector("#eu-go").addEventListener("click", relancer);
  ["min", "annee", "metric", "perimetre", "stade"].forEach((id) =>
    lire(id).addEventListener("change", relancer));

  for (const a of liens) {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      container.querySelector(`#eu-sec-${a.dataset.vers}`)
        .scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  // Les couleurs des SVG sont posées en attributs : elles ne suivent pas le
  // thème toutes seules. Les requêtes étant mémoïsées, ce redessin ne relit
  // rien sur le réseau.
  onThemeChange(() => { if (container.isConnected) relancer(); });

  relancer();
}
