// Diagramme de flux : « qui échange avec qui, combien, et dans quel sens ».
//
// SVG écrit à la main, dans le même esprit que sankey.js : aucune dépendance
// ajoutée, et l'habillage suit les jetons de la feuille de style.
//
// Trois grandeurs y sont encodées :
//   - la SURFACE d'une bulle (et non son rayon) est proportionnelle au volume.
//     Doubler le rayon quadruplerait la surface perçue, ce qui exagérerait les
//     écarts d'un facteur deux — l'erreur la plus courante de ce type de
//     graphe. D'où le rayon en racine carrée du volume.
//   - la LARGEUR AU DÉPART d'un ruban est proportionnelle à la racine du flux,
//     pour la même raison appliquée à la surface du ruban, et bornée pour qu'un
//     flux dominant ne recouvre pas la moitié du dessin.
//   - le SENS se lit dans la forme : le ruban part large de l'origine et
//     s'affine vers la destination. C'est la convention des « tapered flow
//     lines » de la cartographie des flux, et elle remplace les pointes de
//     flèches que portait la version précédente — sur vingt-deux flux, vingt-
//     deux triangles encombraient plus qu'ils n'informaient.
//
// L'appelant fournit les positions : c'est lui qui sait si la disposition doit
// être géographique (retrouver un pays à sa place) ou schématique (l'UE au
// centre, ses partenaires autour). Le module se charge de ne pas laisser deux
// bulles se recouvrir, d'écrire des libellés lisibles, de dessiner le fond de
// carte quand il y en a un, et de produire l'alternative textuelle.
import { jeton } from "./theme.js";
import { tableauFlux } from "./ui.js";

const NS = "http://www.w3.org/2000/svg";

// Repère interne ; le viewBox met ensuite à l'échelle sans écouteur de resize.
const L = 1000;
const H_DEFAUT = 620;
const MARGE = 60;

// Bornes de la hauteur utile quand un fond de carte impose son format : un
// cadre européen est presque carré et voudrait 820 unités de haut, un cadre
// mondial n'en demande que 326. Sans ces bornes, la carte du monde flotterait
// au milieu d'un vide et l'Europe déborderait de l'écran.
const H_UTILE_MIN = 300;
const H_UTILE_MAX = 660;

const R_MIN = 9;
const R_MAX = 62;
const EP_MIN = 2.5;
const EP_MAX = 26;

// Part de la hauteur de la carte que la plus grosse bulle a le droit d'occuper.
//
// R_MAX a été calibré sur un cadre de 620 unités sans fond. Un cadre mondial
// n'en fait que 326 de haut une fois son format respecté : la même bulle y
// couvre alors un cinquième de la carte, écrase le dessin et, en repoussant ses
// voisines, détruit la géographie qu'on venait d'ajouter.
const PART_MAX_BULLE = 0.12;

// Part de l'écart entre deux pays voisins qu'une bulle a le droit d'occuper.
//
// La contrainte précédente ne suffit pas : sur un cadre européen, onze pays
// serrés au centre d'une carte pourtant grande se recouvraient intégralement.
// Ce n'est pas la taille de la carte qui limite, c'est la distance entre ses
// occupants — et elle se mesure.
const PART_ECART_VOISIN = 0.7;

// Largeur de la pointe du ruban, en fraction de sa largeur au départ. À zéro,
// le ruban se termine en aiguille invisible et le flux semble s'arrêter avant
// d'arriver ; ce reste de matière est ce qui fait qu'on voit où il aboutit.
const EFFILEMENT = 0.16;
const POINTE_MIN = 1.4;

// Nombre de rubans recevant le halo. Un filtre SVG sur vingt-deux chemins coûte
// cher à chaque image ; sur trois, il fait ressortir l'essentiel sans ralentir.
const NB_HALOS = 3;

// Place à réserver sous une bulle dont l'étiquette ne tient pas à l'intérieur :
// sans elle, le relâchement sépare bien les disques mais laisse les textes se
// chevaucher, ce qui est le vrai problème de lisibilité sur une carte dense.
const PLACE_ETIQUETTE = 15;

// Marge au-delà du rayon de la bulle à partir de laquelle une tige de rappel
// est tracée. En deçà, la position vraie tombe encore sous le disque : il n'y a
// rien à signaler.
const SEUIL_TIGE = 4;

/*
 * Compteur d'instances, pour préfixer les identifiants internes du SVG.
 *
 * Les `clipPath`, filtres et dégradés sont désignés par `url(#id)`, et cette
 * référence est résolue dans le DOCUMENT entier, pas dans le SVG qui la porte.
 * La vue Europe affiche trois diagrammes sur une même page : avec des
 * identifiants fixes, les deux derniers empruntaient le cadre de découpe et les
 * dégradés du premier. Le symptôme était spectaculaire — la carte d'Europe
 * était tranchée à la hauteur de la carte du monde — et parfaitement
 * silencieux.
 */
let instance = 0;

function el(nom, attrs = {}) {
  const e = document.createElementNS(NS, nom);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

function titre(parent, texte) {
  const t = el("title");
  t.textContent = texte;
  parent.appendChild(t);
}

/**
 * Géométrie du dessin : hauteur du repère, et rectangle de la carte.
 *
 * Sans fond de carte, on garde le cadre historique et toute sa surface.
 *
 * Avec un fond, le rectangle doit respecter le format réel du cadre
 * géographique, sans quoi les continents sont déformés — et une déformation
 * qui passait inaperçue tant que rien n'était dessiné derrière les bulles
 * saute aux yeux dès qu'on trace des côtes.
 *
 * Le facteur cos(latitude moyenne) corrige l'étirement propre à la projection
 * plate carrée : sur le cadre européen (34°–68° N), sans lui, la Scandinavie
 * fait 60 % de trop en largeur.
 */
function geometrie(cadre) {
  const dispoX = L - 2 * MARGE;
  if (!cadre) {
    return { hauteur: H_DEFAUT, rect: { x: MARGE, y: MARGE, l: dispoX, h: H_DEFAUT - 2 * MARGE } };
  }
  const dLon = cadre.lon[1] - cadre.lon[0];
  const dLat = cadre.lat[1] - cadre.lat[0];
  const latMoy = ((cadre.lat[0] + cadre.lat[1]) / 2) * (Math.PI / 180);
  const format = (dLon * Math.cos(latMoy)) / dLat;

  const h = Math.min(Math.max(dispoX / format, H_UTILE_MIN), H_UTILE_MAX);
  const l = Math.min(dispoX, h * format);
  return {
    hauteur: h + 2 * MARGE,
    rect: { x: MARGE + (dispoX - l) / 2, y: MARGE, l, h },
  };
}

/**
 * Contours des pays, dans la même projection que les bulles.
 *
 * Le fond ne sert pas à lire des frontières : il sert à ce que la position
 * d'une bulle veuille dire quelque chose. D'où un remplissage très pâle et un
 * trait filiforme — au premier plan, ce sont les flux qu'on doit voir.
 */
function tracerFond(geojson, projeter, rect) {
  const g = el("g", { class: "fond-carte", "aria-hidden": "true" });

  const anneau = (coords) => {
    let d = "";
    let ouvert = false;
    let lonPrec = null;
    for (const point of coords) {
      const [lon, lat] = point;
      // Un anneau qui franchit l'antiméridien (Russie, Fidji) verrait ses deux
      // moitiés reliées par un trait qui barre toute la carte. Un saut de plus
      // de 180° entre deux points consécutifs ne peut être qu'un franchissement
      // : on referme le morceau en cours et on lève le crayon.
      const saut = lonPrec !== null && Math.abs(lon - lonPrec) > 180;
      lonPrec = lon;
      const [u, v] = projeter([lon, lat]);
      const x = rect.x + u * rect.l;
      const y = rect.y + v * rect.h;
      if (saut && ouvert) { d += "Z"; ouvert = false; }
      d += `${ouvert ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
      ouvert = true;
    }
    return ouvert ? `${d}Z` : d;
  };

  /*
   * Un chemin PAR PAYS, et non un seul chemin pour les 294 anneaux.
   *
   * `fill-rule: evenodd` est indispensable pour que les trous (enclaves, lacs)
   * se creusent quel que soit le sens de parcours des anneaux — le sens
   * conventionnel de GeoJSON n'est pas fiable dans les jeux réels. Mais cette
   * règle s'applique au chemin ENTIER : tous les pays réunis dans un même
   * chemin, le moindre recouvrement entre deux d'entre eux s'annulait. C'est ce
   * qui effaçait toute l'Europe continentale sous un artefact venu de la
   * Russie. Un chemin par pays confine la règle à l'intérieur d'un pays, là où
   * elle est utile, et empêche deux pays de s'annuler l'un l'autre.
   */
  for (const f of geojson.features || []) {
    const geo = f.geometry;
    if (!geo) continue;
    const polys = geo.type === "Polygon" ? [geo.coordinates] : geo.coordinates;
    if (!Array.isArray(polys)) continue;
    let d = "";
    for (const poly of polys) for (const a of poly) d += anneau(a);
    if (d) g.appendChild(el("path", { d, class: "fond-terres", "fill-rule": "evenodd" }));
  }
  return g;
}

/**
 * Médiane des distances au plus proche voisin, sur les positions VRAIES.
 *
 * C'est la mesure qui dit si la disposition est serrée ou aérée. Une bulle plus
 * large que cet écart chevauche systématiquement sa voisine, et le relâchement
 * finit alors par déplacer tout le monde — la carte ne veut plus rien dire.
 * La médiane, et non la moyenne : un pays isolé (la Suède dans un groupe
 * continental) ne doit pas relever le seuil pour les autres.
 */
function ecartVoisin(points) {
  if (points.length < 2) return Infinity;
  const distances = points.map((a, i) => {
    let mini = Infinity;
    points.forEach((b, j) => {
      if (i === j) return;
      mini = Math.min(mini, Math.hypot(b.x - a.x, b.y - a.y));
    });
    return mini;
  }).sort((u, v) => u - v);
  return distances[Math.floor(distances.length / 2)];
}

// Écarte les bulles qui se chevauchent, par petits pas répétés.
//
// Les positions d'entrée sont géographiques ou schématiques : dans les deux cas
// rien ne garantit que deux bulles voisines tiennent côte à côte une fois
// dimensionnées au volume (le Benelux, ou deux gros partenaires proches sur la
// couronne). Quelques itérations suffisent à les séparer sans les déplacer
// assez pour qu'on ne les reconnaisse plus.
function relacher(noeuds, hauteur, iterations = 90) {
  for (let k = 0; k < iterations; k++) {
    let bouge = false;
    for (let i = 0; i < noeuds.length; i++) {
      for (let j = i + 1; j < noeuds.length; j++) {
        const a = noeuds[i];
        const b = noeuds[j];
        if (a.fixe && b.fixe) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d = Math.hypot(dx, dy) || 0.01;
        const mini = a.rEff + b.rEff + 6;
        if (d >= mini) continue;
        // Répartition du recouvrement entre les deux bulles, sauf si l'une est
        // ancrée (le pivot d'un diagramme en couronne ne doit pas dériver).
        const pousse = (mini - d) / 2;
        const ux = dx / d;
        const uy = dy / d;
        if (a.fixe) { b.x += ux * pousse * 2; b.y += uy * pousse * 2; }
        else if (b.fixe) { a.x -= ux * pousse * 2; a.y -= uy * pousse * 2; }
        else { a.x -= ux * pousse; a.y -= uy * pousse; b.x += ux * pousse; b.y += uy * pousse; }
        bouge = true;
      }
    }
    if (!bouge) break;
  }
  // Rien ne doit sortir du cadre, sous peine d'être rogné par le viewBox. Le
  // rayon effectif est utilisé et non le rayon dessiné : c'est l'étiquette,
  // posée sous la bulle, qui touche le bord en premier.
  for (const n of noeuds) {
    n.x = Math.min(L - MARGE - n.rEff, Math.max(MARGE + n.rEff, n.x));
    n.y = Math.min(hauteur - MARGE - n.rEff, Math.max(MARGE + n.rEff, n.y));
  }
}

/**
 * Ruban effilé entre deux bulles.
 *
 * Le squelette est une quadratique de Bézier, décalée perpendiculairement pour
 * que l'aller et le retour entre deux mêmes pays ne se superposent pas. Le
 * ruban est ensuite construit en parcourant ce squelette d'un côté puis de
 * l'autre : c'est un chemin REMPLI, pas un trait épais, ce qui est la seule
 * façon d'obtenir une largeur variable en SVG.
 *
 * Renvoie le contour du ruban et sa ligne médiane — cette dernière porte
 * l'impulsion animée, qui a besoin d'un trait et non d'une surface.
 */
function ruban(a, b, ecart, epaisseur) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const d = Math.hypot(dx, dy) || 1;
  const ux = dx / d;
  const uy = dy / d;
  // Départ et arrivée sur le bord des bulles : un ruban qui partirait du centre
  // passerait sous la bulle et paraîtrait plus court qu'il n'est.
  const x0 = a.x + ux * (a.r + 2);
  const y0 = a.y + uy * (a.r + 2);
  const x1 = b.x - ux * (b.r + 3);
  const y1 = b.y - uy * (b.r + 3);
  // Courbure perpendiculaire.
  const cx = (x0 + x1) / 2 - uy * ecart;
  const cy = (y0 + y1) / 2 + ux * ecart;

  const PAS = 24;
  const large = epaisseur;
  const fine = Math.max(POINTE_MIN, epaisseur * EFFILEMENT);

  const gauche = [];
  const droite = [];
  for (let i = 0; i <= PAS; i++) {
    const t = i / PAS;
    const mt = 1 - t;
    const px = mt * mt * x0 + 2 * mt * t * cx + t * t * x1;
    const py = mt * mt * y0 + 2 * mt * t * cy + t * t * y1;
    // Tangente de la quadratique, donc normale du ruban.
    const tx = 2 * mt * (cx - x0) + 2 * t * (x1 - cx);
    const ty = 2 * mt * (cy - y0) + 2 * t * (y1 - cy);
    const tn = Math.hypot(tx, ty) || 1;
    const nx = -ty / tn;
    const ny = tx / tn;
    // Décroissance en puissance 0,75 : linéaire, le ruban maigrit trop vite
    // près du départ et l'effilement ne se lit plus qu'au dernier tiers.
    const w = (large + (fine - large) * Math.pow(t, 0.75)) / 2;
    gauche.push([px + nx * w, py + ny * w]);
    droite.push([px - nx * w, py - ny * w]);
  }

  const pt = ([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`;
  const contour =
    `M${gauche.map(pt).join("L")}L${droite.reverse().map(pt).join("L")}Z`;
  return {
    contour,
    mediane: `M${x0.toFixed(1)},${y0.toFixed(1)}Q${cx.toFixed(1)},${cy.toFixed(1)} ${x1.toFixed(1)},${y1.toFixed(1)}`,
  };
}

/**
 * Dessine le diagramme.
 *
 * @param {HTMLElement} hote conteneur (vidé au préalable)
 * @param {{noeuds: Array<{id,label,titre?,valeur,x,y,couleur?,fixe?}>,
 *          liens: Array<{source,target,valeur,couleur?}>}} graphe
 *   x, y sont donnés dans [0,1] : l'appelant raisonne en proportions, le
 *   module les convertit dans son repère interne.
 * @param {{fmt:(v:number)=>string, resume?:string,
 *          fond?:{geojson:object, projeter:(lonlat:number[])=>number[], cadre:object}}} opts
 *   `fond` est facultatif : sans lui, le diagramme reste le schéma abstrait
 *   qu'il était, ce dont la disposition en couronne a besoin.
 */
export function bulles(hote, { noeuds, liens }, { fmt, resume, fond } = {}) {
  hote.innerHTML = "";
  const utiles = (liens || []).filter((l) => l.valeur > 0);
  const actifs = (noeuds || []).filter((n) => n.valeur > 0);
  if (!actifs.length) {
    hote.innerHTML = `<div class="empty">Aucun échange déclaré pour ces paramètres.</div>`;
    return;
  }

  const NEUTRE = jeton("--viz-1", "#2a78d6");
  const SURFACE = jeton("--surface", "#ffffff");
  // Préfixe unique : voir le commentaire de `instance`.
  const uid = `bul${(instance += 1)}`;

  const { hauteur, rect } = geometrie(fond?.cadre);

  // Positions vraies, dans le repère du dessin : elles servent à calibrer la
  // taille des bulles avant même de les créer.
  const vraies = actifs.map((n) => ({ x: rect.x + n.x * rect.l, y: rect.y + n.y * rect.h }));

  // Rayon en racine de la valeur : c'est la SURFACE qui doit être lue.
  const vmax = Math.max(...actifs.map((n) => n.valeur));
  const rMax = fond
    ? Math.max(R_MIN + 6, Math.min(
        R_MAX,
        rect.h * PART_MAX_BULLE,
        ecartVoisin(vraies) * PART_ECART_VOISIN,
      ))
    : R_MAX;
  const rayon = (v) => R_MIN + (rMax - R_MIN) * Math.sqrt(v / vmax);

  const placés = actifs.map((n) => {
    const r = rayon(n.valeur);
    /*
     * Décidé AVANT le relâchement : une bulle étiquetée à l'extérieur occupe
     * davantage de place, et c'est cette place-là qu'il faut protéger.
     *
     * Le seuil était de 26 unités de rayon, calibré sur des bulles bien plus
     * grosses. Depuis que leur taille suit celle de la carte, presque toutes
     * les étiquettes passaient à l'extérieur et se percutaient en travers du
     * dessin — le défaut de lisibilité le plus visible. Un code ISO3 tient dans
     * un disque de 15 unités de rayon : on l'y met.
     */
    const tient = r >= 15 && n.label.length * 6 <= r * 1.85;
    const x = rect.x + n.x * rect.l;
    const y = rect.y + n.y * rect.h;
    // Position vraie conservée : c'est elle que la tige de rappel désigne une
    // fois le relâchement passé.
    return { ...n, r, tient, rEff: r + (tient ? 0 : PLACE_ETIQUETTE), x, y, x0: x, y0: y, couleur: n.couleur || NEUTRE };
  });
  relacher(placés, hauteur);
  const parId = new Map(placés.map((n) => [n.id, n]));

  const fmax = utiles.length ? Math.max(...utiles.map((l) => l.valeur)) : 1;
  const epaisseur = (v) => EP_MIN + (EP_MAX - EP_MIN) * Math.sqrt(v / fmax);

  const svg = el("svg", {
    viewBox: `0 0 ${L} ${hauteur}`,
    width: "100%",
    role: "img",
    class: "bulles",
    preserveAspectRatio: "xMidYMid meet",
  });

  const defs = el("defs");
  svg.appendChild(defs);

  // Halo des flux dominants. `feGaussianBlur` seul remplacerait le ruban par sa
  // version floue : il faut le recomposer sous l'original.
  const lueur = el("filter", {
    id: `${uid}-lueur`, x: "-30%", y: "-30%", width: "160%", height: "160%",
    filterUnits: "objectBoundingBox",
  });
  lueur.appendChild(el("feGaussianBlur", { in: "SourceGraphic", stdDeviation: 5, result: "flou" }));
  const fusion = el("feMerge");
  fusion.appendChild(el("feMergeNode", { in: "flou" }));
  fusion.appendChild(el("feMergeNode", { in: "SourceGraphic" }));
  lueur.appendChild(fusion);
  defs.appendChild(lueur);

  if (fond?.geojson && fond.projeter) {
    // Le fond est découpé au rectangle de la carte : les pays qui débordent du
    // cadre (l'Alaska sur un cadre européen) sont coupés net par le navigateur,
    // ce qui vaut mieux que de les rabattre à une position fausse.
    const clip = el("clipPath", { id: `${uid}-cadre` });
    clip.appendChild(el("rect", { x: rect.x, y: rect.y, width: rect.l, height: rect.h, rx: 6 }));
    defs.appendChild(clip);
    const gFond = el("g", { "clip-path": `url(#${uid}-cadre)` });
    gFond.appendChild(el("rect", {
      x: rect.x, y: rect.y, width: rect.l, height: rect.h, rx: 6, class: "fond-mer",
    }));
    gFond.appendChild(tracerFond(fond.geojson, fond.projeter, rect));
    svg.appendChild(gFond);
  }

  const gTiges = el("g", { class: "tiges" });
  const gLiens = el("g", { class: "rubans" });
  const gNoeuds = el("g", { class: "noeuds" });
  svg.append(gTiges, gLiens, gNoeuds);

  // Les gros flux d'abord : les petits se dessinent par-dessus et restent
  // visibles au lieu d'être enfouis.
  const ordonnes = [...utiles].sort((a, b) => b.valeur - a.valeur);
  const vus = new Map();
  ordonnes.forEach((l, rangFlux) => {
    const a = parId.get(l.source);
    const b = parId.get(l.target);
    if (!a || !b) return;
    // Deux flux de sens opposés entre les mêmes pays sont écartés l'un de
    // l'autre, sinon le second recouvrirait exactement le premier.
    const paire = [l.source, l.target].sort().join("|");
    const rang = vus.get(paire) || 0;
    vus.set(paire, rang + 1);

    const couleur = l.couleur || NEUTRE;
    const { contour, mediane } = ruban(a, b, 26 + rang * 34, epaisseur(l.valeur));

    // Dégradé orienté du départ vers l'arrivée : le ruban perd en largeur ce
    // qu'il gagne en densité, de sorte que sa pointe reste visible et que la
    // destination s'impose. Coordonnées en unités de l'utilisateur, sinon le
    // dégradé suivrait la boîte englobante du ruban et non son axe.
    const idDeg = `${uid}-deg-${rangFlux}`;
    const deg = el("linearGradient", {
      id: idDeg, gradientUnits: "userSpaceOnUse",
      x1: a.x.toFixed(1), y1: a.y.toFixed(1), x2: b.x.toFixed(1), y2: b.y.toFixed(1),
    });
    deg.appendChild(el("stop", { offset: "0%", "stop-color": couleur, "stop-opacity": 0.3 }));
    deg.appendChild(el("stop", { offset: "55%", "stop-color": couleur, "stop-opacity": 0.62 }));
    deg.appendChild(el("stop", { offset: "100%", "stop-color": couleur, "stop-opacity": 0.95 }));
    defs.appendChild(deg);

    const g = el("g", {
      class: "ruban", "data-source": l.source, "data-target": l.target,
      ...(rangFlux < NB_HALOS ? { filter: `url(#${uid}-lueur)` } : {}),
    });
    g.appendChild(el("path", { d: contour, fill: `url(#${idDeg})`, class: "ruban-corps" }));
    // Impulsion : `pathLength` normalise la longueur du tracé à 100, ce qui
    // permet d'écrire le motif de tirets et l'animation en pourcentage, sans
    // mesurer chaque chemin après insertion. Le décalage évite que tous les
    // flux défilent au même pas.
    const imp = el("path", {
      d: mediane, class: "ruban-impulsion", pathLength: 100,
      stroke: couleur, fill: "none",
      "stroke-width": Math.max(1.6, epaisseur(l.valeur) * 0.32),
      style: `animation-delay:${((rangFlux * 0.37) % 2.6).toFixed(2)}s`,
    });
    g.appendChild(imp);
    titre(g, `${a.titre || a.label} → ${b.titre || b.label} : ${fmt(l.valeur)}`);
    gLiens.appendChild(g);
  });

  for (const n of placés) {
    // Tige de rappel : le relâchement a écarté la bulle de sa position vraie,
    // et avec un fond de carte cet écart devient une erreur visible. Le point
    // marque l'endroit exact, la bulle reste lisible.
    //
    // Le seuil est le RAYON de la bulle, pas une constante : tant que la
    // position vraie tombe encore sous le disque, il n'y a rien à signaler — et
    // une tige entièrement enfouie sous la bulle ne se verrait pas de toute
    // façon. La tige s'arrête au bord du disque pour la même raison.
    const derive = Math.hypot(n.x - n.x0, n.y - n.y0);
    if (fond && derive > n.r + SEUIL_TIGE) {
      const ux = (n.x - n.x0) / derive;
      const uy = (n.y - n.y0) / derive;
      gTiges.appendChild(el("line", {
        x1: n.x0, y1: n.y0, x2: n.x - ux * n.r, y2: n.y - uy * n.r,
        class: "tige", "data-id": n.id,
      }));
      gTiges.appendChild(el("circle", { cx: n.x0, cy: n.y0, r: 2.4, class: "tige-point" }));
    }

    const g = el("g", { class: "bulle", "data-id": n.id });
    const c = el("circle", {
      cx: n.x, cy: n.y, r: n.r,
      fill: n.couleur, "fill-opacity": 0.85,
      // Anneau de surface : détache la bulle des rubans qui passent dessous.
      stroke: SURFACE, "stroke-width": 2,
    });
    // `titre` porte le nom complet quand `label` a été raccourci pour tenir
    // dans une disposition dense (codes ISO3 sur les 27 États membres).
    titre(c, `${n.titre || n.label} : ${fmt(n.valeur)}`);
    g.appendChild(c);

    // Le libellé tient dans la bulle si elle est assez large ; sinon il se pose
    // juste au-dessous. Une étiquette rognée serait pire que rien.
    if (n.tient) {
      // Les deux lignes tiennent dans le disque : ni l'une ni l'autre ne peut
      // percuter une bulle voisine, ce qui est la seule garantie solide sur une
      // disposition dense.
      const deuxLignes = n.r >= 26;
      const t = el("text", {
        x: n.x, y: n.y + (deuxLignes ? -1 : 4), "text-anchor": "middle",
        class: "bulle-txt bulle-txt-int",
      });
      t.textContent = n.label;
      g.appendChild(t);
      if (deuxLignes) {
        const v = el("text", {
          x: n.x, y: n.y + 14, "text-anchor": "middle",
          class: "bulle-val bulle-val-int",
        });
        v.textContent = fmt(n.valeur);
        g.appendChild(v);
      }
    } else {
      // Trop petite pour porter son code : l'étiquette se pose SOUS la bulle,
      // jamais au-dessus. Alterner selon la moitié de l'écran faisait pointer
      // l'une vers l'autre les étiquettes de deux bulles situées de part et
      // d'autre de la ligne médiane, qui se percutaient dans l'espace laissé
      // entre elles (le cas Benelux). Le montant est abandonné : à cette
      // taille, il reste disponible au survol et dans le tableau équivalent.
      const t = el("text", {
        x: n.x, y: n.y + n.r + 14, "text-anchor": "middle", class: "bulle-txt",
      });
      t.textContent = n.label;
      g.appendChild(t);
    }
    gNoeuds.appendChild(g);
  }

  // Isolement au survol.
  //
  // C'est le principal levier de lisibilité d'un graphe dense : plutôt que de
  // réduire le nombre de flux affichés, on laisse le lecteur en isoler un
  // voisinage. Les bulles étrangères s'effacent aussi, sans quoi l'œil continue
  // de les compter dans le motif.
  const isoler = (id) => {
    const relies = new Set();
    gLiens.querySelectorAll(".ruban").forEach((p) => {
      const lie = id !== null && (p.dataset.source === id || p.dataset.target === id);
      p.classList.toggle("estompe", id !== null && !lie);
      p.classList.toggle("surligne", Boolean(lie));
      if (lie) { relies.add(p.dataset.source); relies.add(p.dataset.target); }
    });
    gNoeuds.querySelectorAll(".bulle").forEach((b) => {
      b.classList.toggle("estompe", id !== null && b.dataset.id !== id && !relies.has(b.dataset.id));
    });
    gTiges.querySelectorAll(".tige").forEach((t) => {
      t.classList.toggle("estompe", id !== null && t.dataset.id !== id && !relies.has(t.dataset.id));
    });
  };

  gNoeuds.querySelectorAll(".bulle").forEach((g) => {
    g.addEventListener("mouseenter", () => isoler(g.dataset.id));
    g.addEventListener("mouseleave", () => isoler(null));
  });
  // Survoler un ruban met en avant ses deux extrémités : sur un faisceau serré,
  // c'est souvent le ruban qu'on vise, pas la bulle.
  gLiens.querySelectorAll(".ruban").forEach((p) => {
    p.addEventListener("mouseenter", () => isoler(p.dataset.source));
    p.addEventListener("mouseleave", () => isoler(null));
  });

  svg.setAttribute("aria-label",
    resume || `Diagramme d'échanges : ${placés.length} pays, ${utiles.length} flux.`);
  hote.appendChild(svg);

  // Clé de lecture de la forme des rubans. Sans elle, l'effilement se comprend
  // au bout d'un moment ; avec elle, tout de suite. Elle n'a pas lieu d'être
  // quand il n'y a aucun flux à lire.
  if (utiles.length) {
    hote.insertAdjacentHTML("beforeend",
      `<p class="legende-flux">Chaque ruban part <b>large de l'origine</b> et s'affine vers la
       <b>destination</b> ; sa largeur au départ suit le volume du flux. Survolez un pays pour ne
       garder que ses échanges.</p>`);
  }

  // Alternative textuelle, partagée avec le globe : les deux représentations
  // portent le même graphe et doivent le restituer de la même façon.
  hote.appendChild(tableauFlux(ordonnes, parId, fmt, resume));
}
