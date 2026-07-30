// Diagramme de Sankey en SVG, écrit à la main : aucune dépendance ajoutée, et
// l'habillage suit les mêmes jetons DSFR que le reste de l'application.
//
// Le graphe attendu a N colonnes (0..N-1, N ≥ 2), les liens n'allant que d'une
// colonne vers la suivante, et pas de cycle : ce placement direct évite
// l'algorithme itératif d'un Sankey généraliste. Les colonnes intermédiaires
// sont dessinées comme des bandeaux larges portant leur libellé à l'intérieur,
// ce qui évite les collisions d'étiquettes au milieu du graphe, là où les
// rubans sont les plus denses. Trois colonnes donnent un Sankey classique,
// quatre ou plus un diagramme alluvial (origines → minéral → stade →
// destinations).

const NS = "http://www.w3.org/2000/svg";

// Repère interne : le SVG est ensuite mis à l'échelle par viewBox, ce qui le
// rend responsive sans écouteur de redimensionnement.
//
// Au-delà de quatre colonnes, le repère s'élargit. Avec cinq colonnes il reste
// trois bandeaux intermédiaires à loger : à 1000 unités de large, les rubans
// n'auraient plus que ~67 unités entre deux bandeaux et les courbes se
// tasseraient au point de ne plus être suivables à l'œil.
const L_ETROIT = 1000;
const L_LARGE = 1200;
const MARGE = 150;
const BARRE = 12;
const BANDE = 150;
const ECART = 10; // espace vertical entre deux nœuds d'une même colonne

// Géométrie horizontale pour n colonnes : les deux extrêmes sont des barres
// fines collées aux marges (leurs étiquettes se posent à l'extérieur), les
// intermédiaires des bandeaux répartis régulièrement dans l'espace restant.
// Avec n = 3, la formule redonne exactement l'ancien placement centré.
function geometrie(n, L) {
  if (n < 2) return [{ x: MARGE, w: BARRE }];
  const debut = MARGE + BARRE;
  const fin = L - MARGE - BARRE;
  const dispo = fin - debut;
  const k = n - 2; // nombre de colonnes intermédiaires
  // Au-delà de deux bandeaux, la largeur nominale mangerait tout l'espace des
  // rubans : on la réduit plutôt que de laisser les courbes se tasser.
  const bande = k > 0 ? Math.min(BANDE, (dispo * 0.6) / k) : 0;
  const gap = k > 0 ? (dispo - k * bande) / (k + 1) : dispo;
  const cols = [{ x: MARGE, w: BARRE }];
  for (let i = 0; i < k; i++) cols.push({ x: debut + gap * (i + 1) + bande * i, w: bande });
  cols.push({ x: fin, w: BARRE });
  return cols;
}

function el(nom, attrs = {}) {
  const e = document.createElementNS(NS, nom);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

// Replie un libellé sur `max` caractères par ligne, au plus `nMax` lignes, la
// dernière tronquée avec une ellipse. Un mot plus long que la ligne est coupé
// net plutôt que de déborder du bandeau.
function couperEnLignes(texte, max, nMax) {
  const lignes = [];
  let courante = "";
  for (let mot of String(texte).split(/\s+/)) {
    while (mot.length > max) {
      if (courante) { lignes.push(courante); courante = ""; }
      lignes.push(mot.slice(0, max));
      mot = mot.slice(max);
    }
    if (!courante) courante = mot;
    else if (courante.length + 1 + mot.length <= max) courante += " " + mot;
    else { lignes.push(courante); courante = mot; }
  }
  if (courante) lignes.push(courante);
  if (lignes.length <= nMax) return lignes;
  const gardees = lignes.slice(0, nMax);
  gardees[nMax - 1] = gardees[nMax - 1].slice(0, Math.max(1, max - 1)) + "…";
  return gardees;
}

function titre(parent, texte) {
  const t = el("title");
  t.textContent = texte;
  parent.appendChild(t);
}

// Ruban de source (x0, y0) vers cible (x1, y1), d'épaisseur ep, en deux
// courbes de Bézier symétriques refermées.
function chemin(x0, y0, x1, y1, ep) {
  const xm = (x0 + x1) / 2;
  return `M${x0},${y0} C${xm},${y0} ${xm},${y1} ${x1},${y1}
          L${x1},${y1 + ep} C${xm},${y1 + ep} ${xm},${y0 + ep} ${x0},${y0 + ep} Z`;
}

/**
 * Dessine un Sankey / alluvial à N colonnes.
 * @param {HTMLElement} host conteneur (vidé au préalable)
 * @param {{nodes: Array, links: Array}} graphe
 *   nodes : [{ id, label, col, couleur }]
 *   links : [{ source, target, value, couleur }]
 * @param {{fmt: (v:number)=>string, hauteur?: number,
 *          entetes?: string[] | {gauche: string, centre: string, droite: string}}} opts
 *   entetes accepte un tableau (un libellé par colonne) ; la forme
 *   {gauche, centre, droite} reste acceptée pour les appels à trois colonnes.
 */
export function sankey(host, { nodes, links }, { fmt, hauteur, entetes } = {}) {
  host.innerHTML = "";
  const utiles = links.filter((k) => k.value > 0);
  if (!utiles.length) {
    host.innerHTML = '<div class="empty">Aucun flux pour ces filtres.</div>';
    return;
  }

  const parId = new Map(nodes.map((n) => [n.id, { ...n, entrant: 0, sortant: 0 }]));
  for (const k of utiles) {
    parId.get(k.source).sortant += k.value;
    parId.get(k.target).entrant += k.value;
  }
  for (const n of parId.values()) n.valeur = Math.max(n.entrant, n.sortant);

  // Colonnes, dans l'ordre fourni par l'appelant : c'est lui qui porte le sens
  // métier (ordre de la chaîne de valeur, classement décroissant...).
  const nbCols = Math.max(2, ...nodes.map((n) => (n.col || 0) + 1));
  const L = nbCols >= 5 ? L_LARGE : L_ETROIT;
  const X = geometrie(nbCols, L);
  const cols = Array.from({ length: nbCols }, (_, c) =>
    nodes.filter((n) => n.col === c).map((n) => parId.get(n.id)).filter((n) => n.valeur > 0));

  // La hauteur suit la colonne la plus peuplée : sur un alluvial, ce n'est plus
  // forcément une colonne d'extrémité.
  const H = hauteur || Math.max(420, Math.max(...cols.map((c) => c.length)) * 30);

  // Une seule échelle pour toutes les colonnes, sinon l'épaisseur d'un même
  // ruban changerait entre son départ et son arrivée.
  const echelle = Math.min(
    ...cols.map((col) => {
      const total = col.reduce((s, n) => s + n.valeur, 0);
      return total > 0 ? (H - ECART * Math.max(0, col.length - 1)) / total : Infinity;
    })
  );

  cols.forEach((col) => {
    const totalPx = col.reduce((s, n) => s + n.valeur * echelle, 0) + ECART * Math.max(0, col.length - 1);
    let y = (H - totalPx) / 2;
    for (const n of col) {
      n.y = y;
      n.h = n.valeur * echelle;
      n.curseurSortie = y;
      n.curseurEntree = y;
      y += n.h + ECART;
    }
  });

  // Bandeau d'en-têtes : nomme explicitement ce que porte chaque colonne, et
  // matérialise le sens de lecture par des chevrons entre les colonnes.
  // La forme historique {gauche, centre, droite} est convertie en tableau.
  const libelles = Array.isArray(entetes)
    ? entetes
    : entetes ? [entetes.gauche, entetes.centre, entetes.droite] : null;
  const HAUT = libelles ? 52 : 0;

  const svg = el("svg", {
    viewBox: `0 0 ${L} ${H + HAUT}`,
    width: "100%",
    role: "img",
    class: "sankey",
    preserveAspectRatio: "xMidYMid meet",
  });

  if (libelles) {
    const gEntetes = el("g", { class: "sankey-entetes" });
    for (let c = 0; c < nbCols; c++) {
      const g = X[c];
      const ancre = c === 0 ? "end" : c === nbCols - 1 ? "start" : "middle";
      const x = c === 0 ? g.x + g.w : c === nbCols - 1 ? g.x : g.x + g.w / 2;
      const t = el("text", { x, y: 20, "text-anchor": ancre, class: "sankey-entete" });
      t.textContent = libelles[c] || "";
      gEntetes.appendChild(t);
    }
    // Chevrons dans chaque intervalle : ils matérialisent le sens de lecture.
    for (let c = 0; c < nbCols - 1; c++) {
      const fleche = el("text", {
        x: (X[c].x + X[c].w + X[c + 1].x) / 2, y: 21,
        "text-anchor": "middle", class: "sankey-fleche",
      });
      fleche.textContent = "❯";
      gEntetes.appendChild(fleche);
    }
    gEntetes.appendChild(el("line", { x1: 0, y1: 36, x2: L, y2: 36, class: "sankey-regle" }));
    svg.appendChild(gEntetes);
  }

  const gCorps = el("g", { transform: `translate(0,${HAUT})` });
  const gLiens = el("g", { class: "sankey-liens" });
  const gNoeuds = el("g", { class: "sankey-noeuds" });
  gCorps.appendChild(gLiens);
  gCorps.appendChild(gNoeuds);
  svg.appendChild(gCorps);

  // Empiler les rubans en suivant la position verticale de l'autre extrémité
  // limite fortement les croisements, sans algorithme d'optimisation.
  const ordonnes = [...utiles].sort((a, b) => {
    const na = parId.get(a.source), nb = parId.get(b.source);
    if (na.col !== nb.col) return na.col - nb.col;
    if (na.y !== nb.y) return na.y - nb.y;
    return parId.get(a.target).y - parId.get(b.target).y;
  });

  for (const k of ordonnes) {
    const s = parId.get(k.source);
    const t = parId.get(k.target);
    const ep = k.value * echelle;
    const x0 = X[s.col].x + X[s.col].w;
    const x1 = X[t.col].x;
    const p = el("path", {
      d: chemin(x0, s.curseurSortie, x1, t.curseurEntree, ep),
      fill: k.couleur || "var(--blue-france)",
      "fill-opacity": 0.32,
      class: "sankey-lien",
      "data-source": k.source,
      "data-target": k.target,
    });
    titre(p, `${s.label} → ${t.label} : ${fmt(k.value)}`);
    gLiens.appendChild(p);
    s.curseurSortie += ep;
    t.curseurEntree += ep;
  }

  for (const n of parId.values()) {
    if (!n.h) continue;
    const g = X[n.col];
    const intermediaire = n.col > 0 && n.col < nbCols - 1;
    const rect = el("rect", {
      x: g.x, y: n.y, width: g.w, height: Math.max(1, n.h),
      rx: intermediaire ? 4 : 2,
      fill: n.couleur || "var(--blue-france)",
      class: "sankey-noeud",
      "data-id": n.id,
    });
    // `titre` porte le libellé complet quand `label` a dû être raccourci pour
    // tenir dans le bandeau (intitulés de positions HS6, notamment).
    titre(rect, `${n.titre || n.label} : ${fmt(n.valeur)}`);
    gNoeuds.appendChild(rect);

    const milieu = n.y + n.h / 2;
    if (intermediaire) {
      // Libellé à l'intérieur du bandeau, replié sur la largeur disponible.
      // Un intitulé de position HS6 dépasse largement le bandeau : on le coupe
      // par mots, et on tronque au-delà de trois lignes — le libellé complet
      // reste accessible en infobulle.
      const lignes = couperEnLignes(n.label, Math.max(8, Math.floor(g.w / 7)), 3);
      lignes.forEach((ligne, i) => {
        const txt = el("text", {
          x: g.x + g.w / 2, y: milieu + (i - (lignes.length - 1) / 2) * 15 + 5,
          "text-anchor": "middle", class: "sankey-txt-bande",
        });
        txt.textContent = ligne;
        gNoeuds.appendChild(txt);
      });
    } else {
      const aGauche = n.col === 0;
      const txt = el("text", {
        x: aGauche ? g.x - 8 : g.x + g.w + 8,
        y: milieu + 4,
        "text-anchor": aGauche ? "end" : "start",
        class: "sankey-txt",
      });
      txt.textContent = n.label;
      gNoeuds.appendChild(txt);
    }
  }

  // Survol d'un nœud : ne garder lisibles que les rubans qui le touchent.
  gNoeuds.querySelectorAll(".sankey-noeud").forEach((rect) => {
    const id = rect.dataset.id;
    rect.addEventListener("mouseenter", () => {
      gLiens.querySelectorAll(".sankey-lien").forEach((p) => {
        const lie = p.dataset.source === id || p.dataset.target === id;
        p.classList.toggle("estompe", !lie);
        p.classList.toggle("surligne", lie);
      });
    });
    rect.addEventListener("mouseleave", () => {
      gLiens.querySelectorAll(".sankey-lien").forEach((p) => p.classList.remove("estompe", "surligne"));
    });
  });

  // Le flux étant conservé d'une colonne à l'autre, n'importe laquelle donne le
  // total ; on prend le maximum pour rester juste si une colonne est tronquée.
  const total = Math.max(...cols.map((c) => c.reduce((s, n) => s + n.valeur, 0)));
  svg.setAttribute("aria-label", `Diagramme de flux : ${nodes.length} nœuds, ${utiles.length} liens, total ${fmt(total)}.`);
  host.appendChild(svg);
}
