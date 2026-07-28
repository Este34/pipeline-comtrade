// Chargement des tables de traduction FR (petits JSON générés par
// clean/labels_fr.py). Utilisées pour afficher des libellés lisibles sans
// jointure DuckDB.
//
// materiaux_fr.json est plus qu'une table de libellés : c'est le RÉFÉRENTIEL de
// la taxonomie matières (stades, formes, code HS6 → minéral). Les Parquet
// portent bien des colonnes `mineral` et `categorie`, mais elles y sont figées
// depuis l'export et les vues ne les lisent plus : elles convertissent une
// sélection en liste de codes HS6 (codesPour) et filtrent sur `cmdCode`.
// Reclasser un code, renommer un stade, ajouter ou retirer un minéral se fait
// donc en régénérant ce fichier de quelques dizaines de Ko — sans toucher aux
// ~290 Mo de Parquet publiés, ni casser l'app pour qui a l'ancien jeu.

const _cache = {};

async function _load(nom) {
  if (_cache[nom]) return _cache[nom];
  const res = await fetch(`data/reference/${nom}.json`);
  _cache[nom] = await res.json();
  return _cache[nom];
}

// Charge toutes les tables de libellés en parallèle (au démarrage).
export async function loadLabels() {
  const [countries, chapters, materiaux, flows] = await Promise.all([
    _load("countries_fr"),
    _load("hs_chapters_fr"),
    _load("materiaux_fr"),
    _load("flows_fr"),
  ]);
  return { countries, chapters, materiaux, flows };
}

// Nom FR d'un pays depuis son ISO3 (fallback : le code lui-même).
export function pays(labels, iso3) {
  return labels.countries[iso3] || iso3 || "n.d.";
}

// Intitulé FR d'un chapitre HS (fallback : le code).
export function chapitre(labels, code) {
  return labels.chapters[code] || code;
}

// --- Référentiel matières -------------------------------------------------

// Stades de la chaîne de valeur, dans l'ordre industriel (extraction → fini).
export function stades(labels) {
  return [...labels.materiaux.stades].sort((a, b) => a.ordre - b.ordre);
}

export function stadeLabel(labels, id) {
  return stades(labels).find((s) => s.id === id)?.label || id;
}

// Libellé FR d'une forme (minerai, oxyde, demi-produit…).
export function formeLabel(labels, id) {
  return labels.materiaux.formes[id] || id;
}

// Fiche complète d'un code HS6 ({mineral, stade, forme, labelFr}), ou null.
export function matiere(labels, code) {
  return labels.materiaux.codes[code] || null;
}

// Libellé FR d'un code HS6 (fallback : le code, jamais l'anglais de Comtrade).
export function codeLabel(labels, code) {
  return labels.materiaux.codes[code]?.labelFr || code;
}

// Liste des minéraux du référentiel, triée en français.
export function mineraux(labels) {
  return [...new Set(Object.values(labels.materiaux.codes).map((m) => m.mineral))]
    .sort((a, b) => a.localeCompare(b, "fr"));
}

// Formes réellement présentes dans une sélection de minéraux, dans l'ordre du
// référentiel. Proposer les 13 formes quand la sélection n'en contient que 4
// donnerait des filtres qui ne filtrent rien.
export function formesPour(labels, mins) {
  const presentes = new Set(
    Object.values(labels.materiaux.codes)
      .filter((m) => !mins || !mins.length || mins.includes(m.mineral))
      .map((m) => m.forme)
  );
  return Object.keys(labels.materiaux.formes).filter((f) => presentes.has(f));
}

// Codes HS6 correspondant à une sélection. Un critère de facette absent ou vide
// ne filtre pas : codesPour(labels, {}) renvoie les 207 codes, et une liste de
// cases toutes décochées se lit « tout », comme dans l'interface.
//
// `codes` obéit à la règle inverse, et c'est délibéré : il restreint à un
// ensemble déjà calculé (le panier courant), donc un tableau VIDE veut dire
// « aucun code », pas « tous ». Sans cette distinction, intersecter un panier
// vide élargirait la sélection au lieu de la réduire.
//
// `prefixe` accepte une saisie partielle (« 8507 » couvre tous les
// accumulateurs), ce qui est le comportement du champ de recherche par code.
export function codesPour(labels, { mineraux: mins, stades: sts, formes: fms, codes, prefixe } = {}) {
  const facette = (liste, valeur) => !liste || !liste.length || liste.includes(valeur);
  const restreint = (code) => codes == null || codes.includes(code);
  return Object.entries(labels.materiaux.codes)
    .filter(([code, m]) =>
      facette(mins, m.mineral) &&
      facette(sts, m.stade) &&
      facette(fms, m.forme) &&
      restreint(code) &&
      (!prefixe || code.startsWith(prefixe)))
    .map(([code]) => code)
    .sort();
}
