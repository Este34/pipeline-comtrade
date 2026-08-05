// Graphe de démonstration pour le banc d'essai.
//
// ATTENTION — LES VALEURS SONT INVENTÉES. Ce fichier ne sert qu'à faire tourner
// les représentations hors de l'application : les données réelles viennent des
// Parquet UN Comtrade, qui ne sont pas disponibles en local (voir
// deploy/build.sh). Les codes ISO3 et les positions, eux, sont réels — c'est ce
// qui permet de vérifier la géographie.
//
// Ce dossier est à la racine du dépôt, donc HORS de `outputDirectory: webapp` :
// il n'est jamais déployé.

/** Quatorze exportateurs, ordre de grandeur plausible mais inventé. */
export const EXPORTATEURS = [
  ["CHL", 19_400], ["PER", 14_100], ["CHN", 11_800], ["AUS", 9_600],
  ["COD", 8_900], ["USA", 7_400], ["ZMB", 5_200], ["RUS", 4_800],
  ["IDN", 4_300], ["KAZ", 3_900], ["CAN", 3_500], ["POL", 3_100],
  ["MEX", 2_800], ["BRA", 2_400],
];

/** Flux : origine, destination, volume. Inventés eux aussi. */
export const FLUX = [
  ["CHL", "CHN", 9_800], ["PER", "CHN", 7_100], ["AUS", "CHN", 4_900],
  ["COD", "CHN", 4_400], ["ZMB", "CHN", 2_600], ["KAZ", "CHN", 2_100],
  ["CHL", "USA", 2_900], ["CAN", "USA", 2_200], ["MEX", "USA", 1_900],
  ["CHL", "POL", 1_300], ["PER", "USA", 1_500], ["RUS", "POL", 1_200],
  ["IDN", "CHN", 1_800], ["BRA", "CHN", 1_100], ["USA", "CAN", 900],
  ["POL", "CHN", 700], ["CHN", "USA", 2_400], ["CHN", "MEX", 1_000],
];

/** Onze États membres et leurs échanges internes. Inventés. */
export const MEMBRES = [
  ["DEU", 4_200], ["ITA", 2_900], ["FRA", 2_400], ["ESP", 1_800],
  ["POL", 1_600], ["BEL", 1_500], ["NLD", 1_400], ["AUT", 900],
  ["SWE", 800], ["CZE", 700], ["PRT", 500],
];

export const FLUX_INTRA = [
  ["DEU", "ITA", 1_200], ["DEU", "FRA", 1_050], ["BEL", "DEU", 980],
  ["NLD", "DEU", 870], ["DEU", "POL", 760], ["ITA", "ESP", 640],
  ["FRA", "ESP", 580], ["SWE", "DEU", 470], ["AUT", "DEU", 430],
  ["CZE", "DEU", 390], ["PRT", "ESP", 340], ["FRA", "BEL", 310],
];

/** Nom lisible d'un pays : de quoi étiqueter sans charger les libellés FR. */
export const NOMS = {
  CHL: "Chili", PER: "Pérou", CHN: "Chine", AUS: "Australie",
  COD: "Congo (RDC)", USA: "États-Unis", ZMB: "Zambie", RUS: "Russie",
  IDN: "Indonésie", KAZ: "Kazakhstan", CAN: "Canada", POL: "Pologne",
  MEX: "Mexique", BRA: "Brésil", DEU: "Allemagne", ITA: "Italie",
  FRA: "France", ESP: "Espagne", BEL: "Belgique", NLD: "Pays-Bas",
  AUT: "Autriche", SWE: "Suède", CZE: "Tchéquie", PRT: "Portugal",
};

export const nom = (iso) => NOMS[iso] || iso;

/** Mise en forme identique à celle de l'application, en millions de dollars. */
export const fmt = (v) =>
  v >= 1000 ? `${(v / 1000).toFixed(1)} Md $` : `${Math.round(v)} M$`;

/**
 * Construit le graphe attendu par `bulles()` et `globe()`.
 *
 * Les positions sont les centroïdes réels : `bulles()` a besoin de x, y dans
 * [0, 1] pour le cadre demandé, `globe()` de lon, lat. Les deux voyagent
 * ensemble pour que les deux représentations montrent exactement le même
 * graphe.
 */
export function graphe({ pays, flux, centres, projeter, couleurs }) {
  const noeuds = [];
  const hors = [];
  for (const [iso, valeur] of pays) {
    const lonlat = centres[iso];
    if (!lonlat) { hors.push(iso); continue; }
    const [x, y] = projeter(lonlat);
    if (x < 0 || x > 1 || y < 0 || y > 1) { hors.push(iso); continue; }
    noeuds.push({
      id: iso, label: iso, titre: nom(iso), valeur,
      x, y, lon: lonlat[0], lat: lonlat[1],
      couleur: couleurs(iso),
    });
  }
  const dans = new Set(noeuds.map((n) => n.id));
  const liens = flux
    .filter(([a, b]) => dans.has(a) && dans.has(b))
    .map(([source, target, valeur]) => ({ source, target, valeur }));
  return { noeuds, liens, hors };
}
