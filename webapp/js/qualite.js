// Contrôle qualité des poids déclarés.
//
// Comtrade est une base DÉCLARATIVE : chaque ligne vient d'une administration
// douanière, sans retraitement par les Nations unies. Deux défauts en découlent,
// tous deux invisibles sur un graphe et tous deux capables de le rendre faux.
//
// 1. LE POIDS N'EST PAS TOUJOURS DÉCLARÉ. La valeur en dollars l'est presque
//    partout, `netWgt` beaucoup moins. Un classement au poids ne classe alors
//    que les pays qui ont renseigné la colonne, et fait disparaître les autres
//    — sans rien dire. D'où l'indicateur de couverture : quelle part de la
//    valeur échangée porte effectivement un poids.
//
// 2. CERTAINS POIDS SONT DANS LA MAUVAISE UNITÉ. Une administration qui déclare
//    en kilogrammes là où la nomenclature attend des tonnes (ou l'inverse)
//    produit un chiffre mille fois trop grand, qui domine ensuite tout
//    classement. Le cas est documenté et fréquent sur les petits déclarants.
//
// Le détecteur du second cas repose sur la VALEUR UNITAIRE IMPLICITE
// (dollars par tonne). Elle est physiquement bornée pour un produit donné : du
// concentré de cuivre vaut quelques centaines de dollars la tonne, une cathode
// quelques milliers. Un pays dont la valeur unitaire s'écarte d'un facteur dix
// de la médiane des autres ne vend pas un produit dix fois moins cher : il a
// déclaré son poids dans une autre unité.
//
// La médiane sert de référence plutôt qu'une valeur absolue codée en dur :
// elle se recalibre seule sur le minéral, le stade et l'année affichés, là où
// un seuil figé serait faux dès qu'on change de matière.

// Écart à la médiane au-delà duquel une valeur unitaire est jugée non crédible.
// Dix, et non deux ou trois : un rapport de deux entre deux pays s'explique
// très bien par la qualité du minerai ou la composition du panier de produits,
// alors qu'un rapport de dix ne s'explique par aucune réalité industrielle.
const FACTEUR_SUSPECT = 10;

// En dessous de ce nombre de pays comparables, la médiane n'a pas de sens et
// aucune alerte n'est levée : mieux vaut ne rien dire que dénoncer au hasard.
const MIN_PAYS = 5;

function mediane(valeurs) {
  if (!valeurs.length) return null;
  const t = [...valeurs].sort((a, b) => a - b);
  const m = Math.floor(t.length / 2);
  return t.length % 2 ? t[m] : (t[m - 1] + t[m]) / 2;
}

/**
 * Analyse la qualité des poids d'un ensemble d'entrées agrégées par pays.
 *
 * @param {Array<{cle: string, valeur: number, poids: number, valeurPesee?: number}>} entrees
 *   `valeur` en dollars, `poids` en kilogrammes, `valeurPesee` = part de la
 *   valeur dont le poids est renseigné (calculée en SQL).
 * @returns {{couverture: number|null, mediane: number|null,
 *            suspects: Array<{cle, usdParTonne, facteur, sens}>}}
 */
export function analyserPoids(entrees) {
  const totalValeur = entrees.reduce((s, e) => s + (e.valeur || 0), 0);
  const totalPesee = entrees.reduce((s, e) => s + (e.valeurPesee || 0), 0);
  const couverture = totalValeur > 0 && entrees.some((e) => e.valeurPesee != null)
    ? totalPesee / totalValeur
    : null;

  // Seuls les pays ayant à la fois une valeur et un poids peuvent porter une
  // valeur unitaire ; les autres n'ont rien à dire ici.
  const avecRatio = entrees
    .filter((e) => (e.valeur || 0) > 0 && (e.poids || 0) > 0)
    .map((e) => ({ cle: e.cle, usdParTonne: (e.valeur * 1000) / e.poids }));

  if (avecRatio.length < MIN_PAYS) return { couverture, mediane: null, suspects: [] };

  const med = mediane(avecRatio.map((r) => r.usdParTonne));
  const suspects = avecRatio
    .map((r) => ({
      ...r,
      // Facteur toujours ≥ 1 : c'est l'ampleur de l'écart qui compte, son sens
      // est porté séparément.
      facteur: r.usdParTonne > med ? r.usdParTonne / med : med / r.usdParTonne,
      sens: r.usdParTonne < med ? "poids surestimé" : "poids sous-estimé",
    }))
    .filter((r) => r.facteur >= FACTEUR_SUSPECT)
    .sort((a, b) => b.facteur - a.facteur);

  return { couverture, mediane: med, suspects };
}

const pourcent = (x) => (100 * x).toFixed(x >= 0.995 || x <= 0.005 ? 1 : 0).replace(".", ",") + " %";
const usd = (v) =>
  v >= 1e6 ? (v / 1e6).toFixed(1).replace(".", ",") + " M$/t"
  : v >= 1e3 ? (v / 1e3).toFixed(1).replace(".", ",") + " k$/t"
  : Math.round(v) + " $/t";

/**
 * Note de qualité à afficher sous un classement au poids.
 * Renvoie "" quand la mesure n'est pas le poids ou qu'il n'y a rien à signaler.
 *
 * @param {object} analyse résultat de analyserPoids()
 * @param {{metric: string, nomDe?: (cle: string) => string}} opts
 */
export function noteQualitePoids(analyse, { metric, nomDe = (c) => c } = {}) {
  if (metric !== "poids" || !analyse) return "";
  const blocs = [];

  if (analyse.couverture != null && analyse.couverture < 0.995) {
    const manque = 1 - analyse.couverture;
    // Sous 90 % de couverture, le classement ne décrit plus l'ensemble des
    // échanges mais seulement les déclarants soigneux : c'est un biais de
    // sélection, pas une imprécision.
    const grave = manque > 0.1;
    blocs.push(`<b>Couverture du poids : ${pourcent(analyse.couverture)}</b> de la valeur échangée
      porte un poids déclaré. ${grave
        ? `Les ${pourcent(manque)} restants sont <b>absents du classement au poids</b> alors qu'ils
           existent bien : un pays qui ne renseigne pas <code>netWgt</code> disparaît purement et
           simplement de ce graphe. Comparez avec la mesure « Valeur » avant de conclure.`
        : `Les ${pourcent(manque)} restants n'apparaissent pas dans ce classement.`}`);
  }

  if (analyse.suspects.length) {
    const liste = analyse.suspects.slice(0, 5).map((s) =>
      `<b>${nomDe(s.cle)}</b> (${usd(s.usdParTonne)}, soit ${Math.round(s.facteur)} × ${
        s.sens === "poids surestimé" ? "moins" : "plus"} que la médiane — ${s.sens})`).join(", ");
    blocs.push(`<b>Valeurs unitaires incohérentes détectées.</b> Rapportée au poids déclaré, la
      valeur médiane de ce périmètre est de ${usd(analyse.mediane)}. ${liste}${
        analyse.suspects.length > 5 ? `, et ${analyse.suspects.length - 5} autre(s)` : ""}.
      Un tel écart ne s'explique par aucune qualité de minerai : il signale presque toujours un
      <b>poids déclaré dans une autre unité</b> à la source. Ces pays sont conservés dans le graphe
      — les retirer en silence serait pire — mais leur position au poids n'est pas exploitable.
      Recoupez avec la production publiée (World Mining Data, USGS, JRC/RMIS) avant tout usage.`);
  }

  if (!blocs.length) return "";
  return `<div class="note note-alerte">${blocs.join("<br><br>")}</div>`;
}

// Expression SQL à ajouter aux agrégats pour mesurer la couverture.
// Isolée ici pour que les vues n'aient pas à retenir la convention (`netWgt`
// non renseigné vaut NULL ou 0 selon les déclarants).
export const SQL_VALEUR_PESEE =
  "SUM(CASE WHEN netWgt IS NOT NULL AND netWgt > 0 THEN primaryValue ELSE 0 END) AS valeurPesee";
