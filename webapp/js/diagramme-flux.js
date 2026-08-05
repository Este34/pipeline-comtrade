// Bascule entre les deux représentations d'un même graphe de flux.
//
// Les vues n'appellent plus `bulles()` directement : elles appellent
// `diagrammeFlux()`, qui dessine l'entête de bascule, se souvient du choix et
// délègue. Le diff dans chaque vue tient en une ligne, et la règle de repli est
// écrite à un seul endroit.
//
// Le repli est SILENCIEUX. Sans WebGL — pilote refusé, contexte épuisé,
// machine ancienne —, le diagramme s'affiche et la bascule disparaît. Un
// message d'erreur n'apprendrait rien d'actionnable à un lecteur venu regarder
// des flux de cuivre.
import { bulles } from "./bulles.js";
import { CADRES, projeter } from "./geo.js";

const CLE = "comtrade:representation";
const MODES = ["globe", "diagramme"];

function lireMode() {
  try {
    const v = localStorage.getItem(CLE);
    return MODES.includes(v) ? v : "globe";
  } catch {
    // Navigation privée ou stockage refusé : le choix vaut pour la session.
    return "globe";
  }
}

function ecrireMode(v) {
  try {
    localStorage.setItem(CLE, v);
  } catch {
    /* stockage indisponible */
  }
}

let mode = lireMode();

/** Instances vivantes, pour que la bascule s'applique partout d'un coup. */
const affichages = new Set();

/**
 * Détruit les représentations dont le conteneur a quitté le document.
 *
 * Appelée par `main.js` à chaque changement d'onglet, sur le modèle de
 * `purgerCartes()`. Elle passe par ce module plutôt que par `globe.js` pour que
 * ce dernier reste hors du chargement initial : un onglet sans globe ne doit
 * télécharger ni three.js ni le code qui l'utilise.
 */
export function purgerAffichages({ toutes = false } = {}) {
  for (const a of [...affichages]) {
    if (toutes || !a.hote.isConnected) {
      a.instanceGlobe?.detruire();
      affichages.delete(a);
    }
  }
}

/**
 * Affiche un graphe de flux, globe ou diagramme au choix du lecteur.
 *
 * @param {HTMLElement} hote conteneur (vidé au préalable)
 * @param {{noeuds: Array<{id,label,titre?,valeur,lon,lat,couleur?}>,
 *          liens: Array<{source,target,valeur,couleur?}>}} graphe
 *   Les nœuds portent lon/lat ; la projection vers le plan est faite ici pour
 *   le diagramme, de sorte qu'une vue n'ait plus à savoir laquelle des deux
 *   représentations attend quoi.
 * @param {{fmt, resume?, geojson, cadre?: "monde"|"europe",
 *          centre?: {lon,lat}, onClick?, sansGlobe?: boolean, sansFond?: boolean,
 *          grapheGlobe?: object, noteGlobe?: string}} opts
 *   `cadre` absent ⇒ pas de fond de carte ni de globe : c'est le cas d'une
 *   disposition purement schématique.
 *
 *   `sansFond` garde le globe mais retire le fond de carte du diagramme : une
 *   disposition en couronne n'est pas géographique, et poser des côtes derrière
 *   elle donnerait à ses positions un sens qu'elles n'ont pas.
 *
 *   `grapheGlobe` remplace le graphe en mode globe. Les deux lectures ne sont
 *   pas toujours le même graphe : sur la couronne, un pays à la fois origine et
 *   destination occupe deux places, alors qu'à sa position géographique il n'en
 *   a qu'une et porte deux flèches.
 */
export function diagrammeFlux(hote, graphe, opts) {
  const { cadre, geojson, sansGlobe } = opts;
  const geographique = Boolean(cadre && geojson) && !sansGlobe;

  hote.innerHTML = "";
  const barre = document.createElement("div");
  barre.className = "bascule-repr";
  const corps = document.createElement("div");
  hote.append(barre, corps);

  const etat = { hote, corps, barre, graphe, opts, instanceGlobe: null };
  // Une relance d'analyse remplace le contenu de la carte : les instances
  // devenues orphelines sont récupérées ici, comme le fait `interactiveMap`.
  purgerAffichages();
  affichages.add(etat);

  if (geographique) construireBascule(etat);
  rendre(etat);
  return etat;
}

function construireBascule(etat) {
  etat.barre.innerHTML = MODES.map((m) => `
    <button type="button" class="bascule-btn" data-mode="${m}"
            aria-pressed="${m === mode}">${m === "globe" ? "🌍 Globe" : "🗺 Diagramme"}</button>`).join("");
  etat.barre.addEventListener("click", (e) => {
    const b = e.target.closest("[data-mode]");
    if (!b || b.dataset.mode === mode) return;
    mode = b.dataset.mode;
    ecrireMode(mode);
    // Toutes les représentations de la page suivent : garder deux sections
    // dans deux modes différents n'aurait aucun sens pour le lecteur.
    for (const a of affichages) {
      if (a.hote.isConnected) { majBoutons(a); rendre(a); }
    }
  });
}

function majBoutons(etat) {
  etat.barre.querySelectorAll("[data-mode]").forEach((b) => {
    b.setAttribute("aria-pressed", String(b.dataset.mode === mode));
  });
}

function rendreDiagramme(etat) {
  const { cadre, geojson } = etat.opts;
  const proj = cadre ? projeter(CADRES[cadre], 1, 1) : null;
  // La projection vers le plan a lieu ici, et non dans la vue : les nœuds ne
  // voyagent qu'en lon/lat, et une vue qui change de cadre n'a rien à recalculer.
  const noeuds = etat.graphe.noeuds.map((n) => {
    if (!proj || n.x !== undefined) return n;
    const [x, y] = proj([n.lon, n.lat]);
    return { ...n, x, y };
  });
  bulles(etat.corps, { noeuds, liens: etat.graphe.liens }, {
    fmt: etat.opts.fmt,
    resume: etat.opts.resume,
    fond: cadre && geojson && !etat.opts.sansFond
      ? { geojson, projeter: proj, cadre: CADRES[cadre] }
      : undefined,
  });
}

async function rendre(etat) {
  etat.instanceGlobe?.detruire();
  etat.instanceGlobe = null;

  const geographique = Boolean(etat.opts.cadre && etat.opts.geojson) && !etat.opts.sansGlobe;
  if (!geographique || mode !== "globe") {
    rendreDiagramme(etat);
    return;
  }

  try {
    const { globe } = await import("./globe.js");
    const instance = await globe(etat.corps, etat.opts.grapheGlobe || etat.graphe, etat.opts);
    if (!instance) throw new Error("WebGL indisponible");
    etat.instanceGlobe = instance;
    // Une note qui n'a de sens qu'en mode globe : elle disparaît donc avec lui.
    if (etat.opts.noteGlobe) {
      etat.corps.insertAdjacentHTML("beforeend",
        `<div class="note methodo" style="margin-top:10px">${etat.opts.noteGlobe}</div>`);
    }
  } catch (e) {
    // Repli silencieux : le diagramme dit la même chose, et la bascule
    // disparaît puisqu'elle n'a plus qu'une option.
    console.warn("Globe indisponible, repli sur le diagramme :", e.message);
    etat.barre.innerHTML = "";
    rendreDiagramme(etat);
  }
}
