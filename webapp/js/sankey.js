// Diagramme de Sankey en SVG, écrit à la main : aucune dépendance ajoutée, et
// l'habillage suit les mêmes jetons DSFR que le reste de l'application.
//
// Le graphe attendu a exactement trois colonnes (0, 1, 2) et pas de cycle, ce
// qui permet un placement direct sans l'algorithme itératif d'un Sankey
// généraliste. La colonne centrale est dessinée comme un bandeau large portant
// son libellé à l'intérieur : c'est ce qui évite les collisions d'étiquettes au
// milieu du graphe, là où les rubans sont les plus denses.

const NS = "http://www.w3.org/2000/svg";

// Repère interne fixe : le SVG est ensuite mis à l'échelle par viewBox, ce qui
// le rend responsive sans écouteur de redimensionnement.
const L = 1000;
const MARGE = 150;
const BARRE = 12;
const BANDE = 150;
const ECART = 10; // espace vertical entre deux nœuds d'une même colonne

const X = {
  0: { x: MARGE, w: BARRE },
  1: { x: (L - BANDE) / 2, w: BANDE },
  2: { x: L - MARGE - BARRE, w: BARRE },
};

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

// Ruban de source (x0, y0) vers cible (x1, y1), d'épaisseur ep, en deux
// courbes de Bézier symétriques refermées.
function chemin(x0, y0, x1, y1, ep) {
  const xm = (x0 + x1) / 2;
  return `M${x0},${y0} C${xm},${y0} ${xm},${y1} ${x1},${y1}
          L${x1},${y1 + ep} C${xm},${y1 + ep} ${xm},${y0 + ep} ${x0},${y0 + ep} Z`;
}

/**
 * Dessine un Sankey à trois colonnes.
 * @param {HTMLElement} host conteneur (vidé au préalable)
 * @param {{nodes: Array, links: Array}} graphe
 *   nodes : [{ id, label, col, couleur }]
 *   links : [{ source, target, value, couleur }]
 * @param {{fmt: (v:number)=>string, hauteur?: number}} opts
 */
export function sankey(host, { nodes, links }, { fmt, hauteur } = {}) {
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
  const cols = [0, 1, 2].map((c) => nodes.filter((n) => n.col === c).map((n) => parId.get(n.id)).filter((n) => n.valeur > 0));

  const H = hauteur || Math.max(420, Math.max(cols[0].length, cols[2].length) * 30);

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

  const svg = el("svg", {
    viewBox: `0 0 ${L} ${H}`,
    width: "100%",
    role: "img",
    class: "sankey",
    preserveAspectRatio: "xMidYMid meet",
  });
  const gLiens = el("g", { class: "sankey-liens" });
  const gNoeuds = el("g", { class: "sankey-noeuds" });
  svg.appendChild(gLiens);
  svg.appendChild(gNoeuds);

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
    const rect = el("rect", {
      x: g.x, y: n.y, width: g.w, height: Math.max(1, n.h),
      rx: n.col === 1 ? 4 : 2,
      fill: n.couleur || "var(--blue-france)",
      class: "sankey-noeud",
      "data-id": n.id,
    });
    titre(rect, `${n.label} : ${fmt(n.valeur)}`);
    gNoeuds.appendChild(rect);

    const milieu = n.y + n.h / 2;
    if (n.col === 1) {
      // Libellé à l'intérieur du bandeau central, sur deux lignes si besoin.
      const mots = n.label.split(" ");
      const lignes = mots.length > 2 ? [mots.slice(0, 2).join(" "), mots.slice(2).join(" ")] : [n.label];
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

  const total = cols[1].reduce((s, n) => s + n.valeur, 0);
  svg.setAttribute("aria-label", `Diagramme de flux : ${nodes.length} nœuds, ${utiles.length} liens, total ${fmt(total)}.`);
  host.appendChild(svg);
}
