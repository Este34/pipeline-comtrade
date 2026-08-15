// Construction de fragments SQL — fonctions pures, sans connexion ni DuckDB.
//
// Elles vivaient dans db.js, qui importe le moteur DuckDB-WASM et sa dépendance
// apache-arrow : ce module-ci est isolé pour qu'elles restent testables hors
// navigateur. `db.js` les ré-exporte, donc aucun appelant n'a changé.

// Échappe une valeur texte pour l'injecter dans une clause SQL.
export function sqlStr(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

// Clause de sélection de produits à partir d'une liste de codes HS6.
//
// On filtre sur `cmdCode`, colonne brute des déclarations, et jamais sur les
// colonnes `mineral` / `categorie` : celles-ci sont figées dans les Parquet
// depuis l'export, alors que la taxonomie vit dans materiaux_fr.json. Une liste
// de 207 codes au maximum reste très en dessous de ce que DuckDB avale sans
// broncher, et le prédicat reste poussé jusqu'au Parquet.
//
// Renvoie une clause toujours fausse si la sélection est vide, ce qui donne un
// résultat vide affiché comme tel — plutôt qu'une sélection silencieusement
// élargie à tout le jeu de données.
export function clauseCodes(codes) {
  if (!codes || !codes.length) return "FALSE";
  return `cmdCode IN (${codes.map(sqlStr).join(",")})`;
}

// Expression CASE affectant une étiquette à chaque code HS6, depuis
// { étiquette: [codes] }. Elle remplace les colonnes `mineral` / `categorie`
// figées dans les Parquet : le regroupement se fait donc côté SQL, avec la
// taxonomie courante, et le résultat reste aussi compact qu'avant.
export function caseCodes(groupes) {
  const branches = Object.entries(groupes)
    .filter(([, codes]) => codes && codes.length)
    .map(([etiquette, codes]) => `WHEN ${clauseCodes(codes)} THEN ${sqlStr(etiquette)}`);
  return branches.length ? `CASE ${branches.join(" ")} END` : "NULL";
}
