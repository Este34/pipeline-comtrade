// Diagramme à bulles et flèches : « qui échange avec qui, et combien ».
//
// SVG écrit à la main, dans le même esprit que sankey.js : aucune dépendance
// ajoutée, et l'habillage suit les jetons de la feuille de style.
//
// Deux grandeurs y sont encodées :
//   - la SURFACE d'une bulle (et non son rayon) est proportionnelle au volume.
//     Doubler le rayon quadruplerait la surface perçue, ce qui exagérerait les
//     écarts d'un facteur deux — l'erreur la plus courante de ce type de
//     graphe. D'où le rayon en racine carrée du volume.
//   - l'ÉPAISSEUR d'une flèche est proportionnelle à la racine du flux, pour la
//     même raison appliquée à la surface du ruban, et bornée pour qu'un flux
//     dominant ne recouvre pas la moitié du dessin.
//
// L'appelant fournit les positions : c'est lui qui sait si la disposition doit
// être géographique (retrouver un pays à sa place) ou schématique (l'UE au
// centre, ses partenaires autour). Le module se charge seulement de ne pas
// laisser deux bulles se recouvrir, d'écrire des libellés lisibles et de
// produire l'alternative textuelle.
import { esc } from "./format.js";
import { jeton } from "./theme.js";

const NS = "http://www.w3.org/2000/svg";

// Repère interne ; le viewBox met ensuite à l'échelle sans écouteur de resize.
const L = 1000;
const H = 620;
const MARGE = 60;

const R_MIN = 9;
const R_MAX = 62;
const EP_MIN = 1.5;
const EP_MAX = 18;

// Pointe de flèche, en unités du repère et NON en multiples de l'épaisseur du
// trait. C'est le défaut de SVG (`markerUnits="strokeWidth"`) : sur un flux
// dominant tracé à 18 unités d'épaisseur, la pointe atteindrait une centaine
// d'unités et masquerait la moitié du dessin.
const POINTE = 13;

// Place à réserver sous une bulle dont l'étiquette ne tient pas à l'intérieur :
// sans elle, le relâchement sépare bien les disques mais laisse les textes se
// chevaucher, ce qui est le vrai problème de lisibilité sur une carte dense.
const PLACE_ETIQUETTE = 15;

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

// Écarte les bulles qui se chevauchent, par petits pas répétés.
//
// Les positions d'entrée sont géographiques ou schématiques : dans les deux cas
// rien ne garantit que deux bulles voisines tiennent côte à côte une fois
// dimensionnées au volume (le Benelux, ou deux gros partenaires proches sur la
// couronne). Quelques itérations suffisent à les séparer sans les déplacer
// assez pour qu'on ne les reconnaisse plus.
function relacher(noeuds, iterations = 90) {
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
    n.y = Math.min(H - MARGE - n.rEff, Math.max(MARGE + n.rEff, n.y));
  }
}

// Flèche courbe entre deux bulles, s'arrêtant au bord de chacune.
function courbe(a, b, ecart) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const d = Math.hypot(dx, dy) || 1;
  const ux = dx / d;
  const uy = dy / d;
  // Départ et arrivée sur le bord des bulles : une flèche qui partirait du
  // centre passerait sous la bulle et paraîtrait plus courte qu'elle n'est.
  const x0 = a.x + ux * (a.r + 2);
  const y0 = a.y + uy * (a.r + 2);
  const x1 = b.x - ux * (b.r + POINTE);
  const y1 = b.y - uy * (b.r + POINTE);
  // Courbure perpendiculaire : elle sépare l'aller du retour entre deux mêmes
  // pays, qui se superposeraient exactement en ligne droite.
  const mx = (x0 + x1) / 2 - uy * ecart;
  const my = (y0 + y1) / 2 + ux * ecart;
  return { d: `M${x0},${y0} Q${mx},${my} ${x1},${y1}`, x1, y1 };
}

/**
 * Dessine le diagramme.
 *
 * @param {HTMLElement} hote conteneur (vidé au préalable)
 * @param {{noeuds: Array<{id,label,valeur,x,y,couleur?,fixe?,groupe?}>,
 *          liens: Array<{source,target,valeur,couleur?}>}} graphe
 *   x, y sont donnés dans [0,1] : l'appelant raisonne en proportions, le
 *   module les convertit dans son repère interne.
 * @param {{fmt:(v:number)=>string, resume?:string, legende?:Array}} opts
 */
export function bulles(hote, { noeuds, liens }, { fmt, resume } = {}) {
  hote.innerHTML = "";
  const utiles = (liens || []).filter((l) => l.valeur > 0);
  const actifs = (noeuds || []).filter((n) => n.valeur > 0);
  if (!actifs.length) {
    hote.innerHTML = `<div class="empty">Aucun échange déclaré pour ces paramètres.</div>`;
    return;
  }

  const NEUTRE = jeton("--viz-1", "#2a78d6");
  const INK = jeton("--ink", "#161616");
  const SURFACE = jeton("--surface", "#ffffff");

  // Rayon en racine de la valeur : c'est la SURFACE qui doit être lue.
  const vmax = Math.max(...actifs.map((n) => n.valeur));
  const rayon = (v) => R_MIN + (R_MAX - R_MIN) * Math.sqrt(v / vmax);

  const dispo = { x: L - 2 * MARGE, y: H - 2 * MARGE };
  const placés = actifs.map((n) => {
    const r = rayon(n.valeur);
    // Décidé AVANT le relâchement : une bulle étiquetée à l'extérieur occupe
    // davantage de place, et c'est cette place-là qu'il faut protéger.
    const tient = r >= 26 && n.label.length * 6.4 < r * 1.9;
    return {
      ...n,
      r,
      tient,
      rEff: r + (tient ? 0 : PLACE_ETIQUETTE),
      x: MARGE + n.x * dispo.x,
      y: MARGE + n.y * dispo.y,
      couleur: n.couleur || NEUTRE,
    };
  });
  relacher(placés);
  const parId = new Map(placés.map((n) => [n.id, n]));

  const fmax = utiles.length ? Math.max(...utiles.map((l) => l.valeur)) : 1;
  const epaisseur = (v) => EP_MIN + (EP_MAX - EP_MIN) * Math.sqrt(v / fmax);

  const svg = el("svg", {
    viewBox: `0 0 ${L} ${H}`,
    width: "100%",
    role: "img",
    class: "bulles",
    preserveAspectRatio: "xMidYMid meet",
  });

  // Une pointe de flèche par couleur employée : un marqueur SVG ne peut pas
  // hériter de la couleur du trait qui le porte sans `context-stroke`, encore
  // inégalement pris en charge.
  const defs = el("defs");
  const couleursFleches = [...new Set(utiles.map((l) => l.couleur || NEUTRE))];
  couleursFleches.forEach((c, i) => {
    const m = el("marker", {
      id: `pointe-${i}`, viewBox: "0 0 10 10", refX: 9, refY: 5,
      markerWidth: POINTE, markerHeight: POINTE,
      // Taille absolue : sans cela SVG l'exprime en multiples de l'épaisseur du
      // trait et la pointe d'un flux dominant devient un triangle géant.
      markerUnits: "userSpaceOnUse",
      orient: "auto-start-reverse",
    });
    m.appendChild(el("path", { d: "M0,0 L10,5 L0,10 z", fill: c }));
    defs.appendChild(m);
  });
  svg.appendChild(defs);
  const idPointe = (c) => `pointe-${couleursFleches.indexOf(c)}`;

  const gLiens = el("g", { class: "fleches" });
  const gNoeuds = el("g", { class: "noeuds" });
  svg.appendChild(gLiens);
  svg.appendChild(gNoeuds);

  // Les gros flux d'abord : les petits se dessinent par-dessus et restent
  // visibles au lieu d'être enfouis.
  const ordonnes = [...utiles].sort((a, b) => b.valeur - a.valeur);
  const vus = new Map();
  for (const l of ordonnes) {
    const a = parId.get(l.source);
    const b = parId.get(l.target);
    if (!a || !b) continue;
    // Deux flux de sens opposés entre les mêmes pays sont écartés l'un de
    // l'autre, sinon le second recouvrirait exactement le premier.
    const paire = [l.source, l.target].sort().join("|");
    const rang = vus.get(paire) || 0;
    vus.set(paire, rang + 1);
    const couleur = l.couleur || NEUTRE;
    const { d } = courbe(a, b, 26 + rang * 34);
    const p = el("path", {
      d, fill: "none", stroke: couleur,
      "stroke-width": epaisseur(l.valeur),
      "stroke-linecap": "round",
      opacity: 0.42,
      "marker-end": `url(#${idPointe(couleur)})`,
      class: "fleche",
      "data-source": l.source,
      "data-target": l.target,
    });
    titre(p, `${a.label} → ${b.label} : ${fmt(l.valeur)}`);
    gLiens.appendChild(p);
  }

  for (const n of placés) {
    const g = el("g", { class: "bulle", "data-id": n.id });
    const c = el("circle", {
      cx: n.x, cy: n.y, r: n.r,
      fill: n.couleur, "fill-opacity": 0.85,
      // Anneau de surface : détache la bulle des flèches qui passent dessous.
      stroke: SURFACE, "stroke-width": 2,
    });
    // `titre` porte le nom complet quand `label` a été raccourci pour tenir
    // dans une disposition dense (codes ISO3 sur les 27 États membres).
    titre(c, `${n.titre || n.label} : ${fmt(n.valeur)}`);
    g.appendChild(c);

    // Le libellé tient dans la bulle si elle est assez large ; sinon il se pose
    // juste au-dessus ou au-dessous. Une étiquette rognée serait pire que rien.
    if (n.tient) {
      const t = el("text", {
        x: n.x, y: n.y - 1, "text-anchor": "middle",
        class: "bulle-txt bulle-txt-int",
      });
      t.textContent = n.label;
      g.appendChild(t);
      const v = el("text", {
        x: n.x, y: n.y + 14, "text-anchor": "middle",
        class: "bulle-val bulle-val-int",
      });
      v.textContent = fmt(n.valeur);
      g.appendChild(v);
    } else {
      // Toujours SOUS la bulle, jamais au-dessus. Alterner selon la moitié de
      // l'écran faisait pointer l'une vers l'autre les étiquettes de deux
      // bulles situées de part et d'autre de la ligne médiane, qui se
      // percutaient dans l'espace laissé entre elles (le cas Benelux).
      const yTxt = n.y + n.r + 14;
      const t = el("text", { x: n.x, y: yTxt, "text-anchor": "middle", class: "bulle-txt" });
      t.textContent = n.label;
      g.appendChild(t);
      // Sous une certaine taille, le montant est abandonné : deux lignes de
      // texte par bulle saturent une disposition dense, et la valeur reste
      // disponible au survol comme dans le tableau équivalent.
      if (n.r >= 16) {
        const v = el("text", { x: n.x, y: yTxt + 14, "text-anchor": "middle", class: "bulle-val" });
        v.textContent = fmt(n.valeur);
        g.appendChild(v);
      }
    }
    gNoeuds.appendChild(g);
  }

  // Survol d'une bulle : ne garder lisibles que les flèches qui la touchent.
  gNoeuds.querySelectorAll(".bulle").forEach((g) => {
    const id = g.dataset.id;
    g.addEventListener("mouseenter", () => {
      gLiens.querySelectorAll(".fleche").forEach((p) => {
        const lie = p.dataset.source === id || p.dataset.target === id;
        p.classList.toggle("estompe", !lie);
        p.classList.toggle("surligne", lie);
      });
    });
    g.addEventListener("mouseleave", () => {
      gLiens.querySelectorAll(".fleche").forEach((p) => p.classList.remove("estompe", "surligne"));
    });
  });

  svg.setAttribute("aria-label",
    resume || `Diagramme d'échanges : ${placés.length} pays, ${utiles.length} flux.`);
  hote.appendChild(svg);

  // Alternative textuelle. Un SVG, même correctement étiqueté, ne restitue pas
  // ses valeurs à un lecteur d'écran : la même information est donc redonnée
  // sous forme de tableau, masqué visuellement mais bien dans le document.
  const alt = document.createElement("div");
  alt.className = "sr-only";
  alt.innerHTML = `
    <table>
      <caption>${esc(resume || "Flux représentés sur le diagramme")}</caption>
      <thead><tr><th scope="col">Origine</th><th scope="col">Destination</th><th scope="col">Montant</th></tr></thead>
      <tbody>${ordonnes.map((l) => {
        const a = parId.get(l.source);
        const b = parId.get(l.target);
        return a && b
          ? `<tr><td>${esc(a.titre || a.label)}</td><td>${esc(b.titre || b.label)}</td><td>${esc(fmt(l.valeur))}</td></tr>`
          : "";
      }).join("")}</tbody>
    </table>`;
  hote.appendChild(alt);
}
