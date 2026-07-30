// Heatmap : une grandeur lue à l'intersection de deux nomenclatures
// (typiquement pays × minéraux).
//
// Rendue comme un vrai <table> et non comme un SVG. Une grille de rectangles
// SVG serait plus rapide à écrire, mais elle sortirait la donnée de l'arbre
// d'accessibilité : un lecteur d'écran n'y trouverait ni en-tête de ligne, ni
// en-tête de colonne, et la navigation au clavier serait à réimplémenter. Le
// tableau donne tout cela gratuitement, et les en-têtes collants restent
// utilisables sur quarante lignes.
//
// La couleur encode une GRANDEUR : rampe séquentielle à teinte unique, du clair
// au sombre (l'ancrage s'inverse en thème sombre, voir css/styles.css). Jamais
// d'arc-en-ciel — il ferait lire des paliers là où la grandeur est continue.
import { esc } from "./format.js";
import { rampeSequentielle, jeton } from "./theme.js";

// Nombre de paliers de la rampe. Une échelle continue serait plus fidèle, mais
// des paliers nets rendent comparables deux cellules éloignées dans la grille,
// ce qu'un dégradé continu ne permet pas à l'œil.
const PALIERS = 6;

// Découpe en paliers sur une échelle logarithmique.
//
// Les échanges de matières s'étalent sur cinq ordres de grandeur : en échelle
// linéaire, la Chine écrase tout et 95 % des cellules tombent dans le premier
// palier, ce qui ne montre plus rien. Le log rend lisible la différence entre
// un petit et un très petit flux, qui est justement ce qu'on cherche ici.
function echelle(valeurs) {
  const positives = valeurs.filter((v) => v > 0);
  if (!positives.length) return () => -1;
  const min = Math.min(...positives);
  const max = Math.max(...positives);
  const lmin = Math.log10(min);
  const lmax = Math.log10(max);
  return (v) => {
    if (!(v > 0)) return -1;
    const t = lmax > lmin ? (Math.log10(v) - lmin) / (lmax - lmin) : 1;
    return Math.min(PALIERS - 1, Math.max(0, Math.floor(t * PALIERS)));
  };
}

/**
 * Dessine la heatmap.
 *
 * @param {HTMLElement} hote conteneur (vidé au préalable)
 * @param {{lignes: Array<{cle: string, label: string}>,
 *          colonnes: Array<{cle: string, label: string}>,
 *          valeur: (ligneCle: string, colonneCle: string) => number,
 *          brut?: (ligneCle: string, colonneCle: string) => number}} donnees
 * @param {{fmt: (v:number)=>string, fmtCellule?: (v:number)=>string,
 *          unite?: string, onTri?: (cle: string|null) => void,
 *          triCourant?: string|null, legende?: string}} opts
 */
export function heatmap(hote, donnees, opts = {}) {
  const { lignes, colonnes, valeur, brut } = donnees;
  const { fmt = String, fmtCellule, unite = "", onTri, triCourant = null, legende } = opts;
  hote.innerHTML = "";

  if (!lignes.length || !colonnes.length) {
    hote.innerHTML = `<div class="empty">Aucune donnée pour ces paramètres.
      Élargissez la sélection de minéraux ou changez d'année.</div>`;
    return;
  }

  const RAMP = rampeSequentielle();
  const VIDE = jeton("--ramp-0", "#eef1f7");
  const INK_CLAIR = jeton("--ramp-ink-clair", "#161616");
  const INK_SOMBRE = jeton("--ramp-ink-sombre", "#ffffff");

  const toutes = [];
  for (const l of lignes) for (const c of colonnes) toutes.push(valeur(l.cle, c.cle));
  const palier = echelle(toutes);
  const cellule = fmtCellule || fmt;

  const wrap = document.createElement("div");
  wrap.className = "table-wrap";
  const table = document.createElement("table");
  table.className = "heatmap";
  wrap.appendChild(table);

  const thead = document.createElement("thead");
  const trh = document.createElement("tr");
  const coin = document.createElement("th");
  coin.scope = "col";
  coin.textContent = "Pays";
  trh.appendChild(coin);
  for (const c of colonnes) {
    const th = document.createElement("th");
    th.scope = "col";
    th.textContent = c.label;
    if (onTri) {
      th.title = `Trier les pays sur « ${c.label} »`;
      // Le tri est une commande : un <th> cliquable seul est invisible au
      // clavier et muet pour un lecteur d'écran.
      th.tabIndex = 0;
      th.setAttribute("role", "columnheader");
      if (triCourant === c.cle) th.setAttribute("aria-sort", "descending");
      const trier = () => onTri(triCourant === c.cle ? null : c.cle);
      th.addEventListener("click", trier);
      th.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); trier(); }
      });
    }
    trh.appendChild(th);
  }
  thead.appendChild(trh);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (const l of lignes) {
    const tr = document.createElement("tr");
    if (l.total) tr.className = "hm-total";
    const th = document.createElement("th");
    th.scope = "row";
    th.textContent = l.label;
    tr.appendChild(th);
    for (const c of colonnes) {
      const v = valeur(l.cle, c.cle);
      const p = palier(v);
      const td = document.createElement("td");
      td.className = "hm-cell" + (p < 0 ? " hm-vide" : "");
      td.style.background = p < 0 ? VIDE : RAMP[p];
      // L'encre bascule au milieu de la rampe : garder une seule couleur de
      // texte rendrait illisible soit les cellules claires, soit les sombres.
      if (p >= 0) td.style.color = p >= PALIERS / 2 ? INK_SOMBRE : INK_CLAIR;
      td.textContent = p < 0 ? "–" : cellule(v);
      // La valeur affichée est arrondie pour tenir dans la cellule : l'infobulle
      // porte la valeur d'origine, sans quoi le tableau ne serait pas vérifiable.
      const exacte = brut ? brut(l.cle, c.cle) : v;
      td.title = `${l.label} · ${c.label}\n${p < 0 ? "aucun échange déclaré" : fmt(exacte) + unite}`;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  hote.appendChild(wrap);

  const leg = document.createElement("div");
  leg.className = "legend-ramp";
  const positives = toutes.filter((v) => v > 0);
  const min = positives.length ? Math.min(...positives) : 0;
  const max = positives.length ? Math.max(...positives) : 0;
  leg.innerHTML =
    `<span>${cellule(min)}</span>` +
    RAMP.map((c) => `<i style="background:${c}"></i>`).join("") +
    `<span>${cellule(max)}</span>` +
    `<span style="margin-left:10px">
       <i style="background:${VIDE};vertical-align:middle"></i> aucun échange déclaré</span>` +
    (legende ? `<span style="flex-basis:100%;margin-top:4px">${esc(legende)}</span>` : "");
  hote.appendChild(leg);
}
