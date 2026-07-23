// Chargement des tables de traduction FR (petits JSON générés par
// clean/labels_fr.py). Utilisées pour afficher des libellés lisibles sans
// jointure DuckDB.

const _cache = {};

async function _load(nom) {
  if (_cache[nom]) return _cache[nom];
  const res = await fetch(`data/reference/${nom}.json`);
  _cache[nom] = await res.json();
  return _cache[nom];
}

// Charge toutes les tables de libellés en parallèle (au démarrage).
export async function loadLabels() {
  const [countries, chapters, minerals, flows] = await Promise.all([
    _load("countries_fr"),
    _load("hs_chapters_fr"),
    _load("minerals_fr"),
    _load("flows_fr"),
  ]);
  return { countries, chapters, minerals, flows };
}

// Nom FR d'un pays depuis son ISO3 (fallback : le code lui-même).
export function pays(labels, iso3) {
  return labels.countries[iso3] || iso3 || "n.d.";
}

// Intitulé FR d'un chapitre HS (fallback : le code).
export function chapitre(labels, code) {
  return labels.chapters[code] || code;
}
