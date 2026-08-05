// Périmètres géographiques et dispositions schématiques.
//
// Deux notions d'« Europe » coexistent, et les confondre fausse toute analyse
// de dépendance :
//
//  - l'UE27, périmètre POLITIQUE et douanier. C'est celui du règlement sur les
//    matières premières critiques (CRMA) et le seul qui ait un sens quand on
//    parle d'autonomie stratégique européenne. Il n'existe pas dans les
//    données : il faut l'énumérer.
//  - l'Europe GÉOGRAPHIQUE, déjà portée par les colonnes reporterContinent /
//    partnerContinent des Parquet. Elle inclut le Royaume-Uni, la Norvège, la
//    Suisse, la Serbie, l'Ukraine, la Russie… Utile pour situer un voisinage,
//    trompeuse pour mesurer une dépendance de l'Union.
//
// L'application propose les deux et dit toujours lequel est actif.

// UE27 au 1er janvier 2021 (après le retrait du Royaume-Uni).
export const UE27 = [
  "AUT", "BEL", "BGR", "CYP", "CZE", "DEU", "DNK", "ESP", "EST", "FIN",
  "FRA", "GRC", "HRV", "HUN", "IRL", "ITA", "LTU", "LUX", "LVA", "MLT",
  "NLD", "POL", "PRT", "ROU", "SVK", "SVN", "SWE",
];

const UE27_SET = new Set(UE27);
export const estUE27 = (iso3) => UE27_SET.has(iso3);

export const PERIMETRES = [
  { value: "ue27", label: "UE27 (périmètre douanier)" },
  { value: "geo", label: "Europe géographique" },
];

// Clause SQL restreignant une colonne ISO3 au périmètre choisi.
//
// Le périmètre géographique s'appuie sur la colonne continent déjà calculée à
// l'export (clean/enrich.py) : aucune liste à maintenir de ce côté.
export function clausePerimetre(perimetre, colISO3, colContinent, dedans = true) {
  if (perimetre === "geo") {
    return `${colContinent} ${dedans ? "=" : "IS DISTINCT FROM"} 'Europe'`;
  }
  const liste = UE27.map((c) => `'${c}'`).join(",");
  return `${colISO3} ${dedans ? "IN" : "NOT IN"} (${liste})`;
}

export function libellePerimetre(perimetre) {
  return perimetre === "geo" ? "Europe géographique" : "UE27";
}

// --- Dispositions ---------------------------------------------------------

// Centroïde approché de chaque pays, calculé sur le fond de carte déjà
// embarqué (vendor/world.geo.json) plutôt que sur une table de coordonnées
// écrite à la main : une table de 200 lignes serait à maintenir, et le fond de
// carte est de toute façon téléchargé par les vues cartographiques.
//
// Le centroïde est pris sur l'anneau le plus étendu du pays, et non sur
// l'ensemble de ses polygones : sinon la France se retrouverait au milieu de
// l'Atlantique, tirée par la Guyane et les territoires d'outre-mer.
export function centroides(geojson) {
  const out = {};
  for (const f of geojson.features || []) {
    const iso = f.id || f.properties?.ISO_A3 || f.properties?.iso_a3;
    if (!iso) continue;
    const anneaux = [];
    const collecter = (coords, profondeur) => {
      if (profondeur === 1) anneaux.push(coords);
      else for (const c of coords) collecter(c, profondeur - 1);
    };
    const g = f.geometry;
    if (!g) continue;
    if (g.type === "Polygon") collecter(g.coordinates, 2);
    else if (g.type === "MultiPolygon") collecter(g.coordinates, 3);
    if (!anneaux.length) continue;

    let meilleur = null;
    let meilleureEtendue = -1;
    for (const a of anneaux) {
      const xs = a.map((p) => p[0]);
      const ys = a.map((p) => p[1]);
      const etendue = (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys));
      if (etendue > meilleureEtendue) { meilleureEtendue = etendue; meilleur = a; }
    }
    const n = meilleur.length;
    out[iso] = [
      meilleur.reduce((s, p) => s + p[0], 0) / n,
      meilleur.reduce((s, p) => s + p[1], 0) / n,
    ];
  }
  return out;
}

/**
 * Barycentre géographique d'un ensemble de pays, en degrés.
 *
 * Calculé sur les VECTEURS unité et non sur les longitudes : une moyenne
 * d'angles place le barycentre du Pacifique en plein Sahara dès qu'on franchit
 * l'antiméridien. Sans objet pour l'UE27, mais la fonction ne doit pas dépendre
 * de la bonne volonté de son appelant.
 *
 * Ce point n'est PAS un lieu où se passerait quelque chose : c'est une commodité
 * de dessin, à annoncer comme telle partout où il sert à poser un bloc de pays.
 */
export function barycentre(isos, centres) {
  let x = 0;
  let y = 0;
  let z = 0;
  let n = 0;
  for (const iso of isos) {
    const c = centres[iso];
    if (!c) continue;
    const phi = (c[1] * Math.PI) / 180;
    const lam = (c[0] * Math.PI) / 180;
    x += Math.cos(phi) * Math.sin(lam);
    y += Math.sin(phi);
    z += Math.cos(phi) * Math.cos(lam);
    n += 1;
  }
  if (!n) return null;
  const norme = Math.hypot(x, y, z);
  if (!norme) return null;
  return {
    lon: (Math.atan2(x, z) * 180) / Math.PI,
    lat: (Math.asin(y / norme) * 180) / Math.PI,
  };
}

// Cadres de projection : monde entier, ou Europe resserrée.
export const CADRES = {
  monde: { lon: [-165, 175], lat: [-52, 72] },
  europe: { lon: [-24, 34], lat: [34, 68] },
};

// Projection équirectangulaire vers le repère interne du diagramme.
// Suffisante ici : le diagramme n'est pas une carte, il ne sert qu'à donner au
// lecteur un repère spatial familier pour retrouver un pays.
export function projeter(cadre, largeur, hauteur) {
  const { lon, lat } = cadre;
  return ([x, y]) => [
    ((x - lon[0]) / (lon[1] - lon[0])) * largeur,
    hauteur - ((y - lat[0]) / (lat[1] - lat[0])) * hauteur,
  ];
}

// Disposition en couronne autour d'un centre : utilisée quand la géographie
// n'apporte rien (l'UE agrégée face à ses partenaires mondiaux). Les entrants
// se placent sur l'arc gauche, les sortants sur l'arc droit, ce qui rend le
// sens des échanges lisible avant même de suivre une flèche.
export function couronne(n, { cx, cy, rx, ry, depart = -90, etendue = 180 }) {
  if (n === 1) return [[cx + rx * Math.cos((depart + etendue / 2) * Math.PI / 180),
                        cy + ry * Math.sin((depart + etendue / 2) * Math.PI / 180)]];
  return Array.from({ length: n }, (_, i) => {
    const a = ((depart + (etendue * i) / (n - 1)) * Math.PI) / 180;
    return [cx + rx * Math.cos(a), cy + ry * Math.sin(a)];
  });
}
