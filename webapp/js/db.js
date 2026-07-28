// Couche d'accès aux données : DuckDB-WASM (100 % offline) sur les Parquet.
// Les fichiers duckdb-wasm sont vendorisés localement (aucun CDN au runtime).
import * as duckdb from "../vendor/duckdb-wasm/duckdb-browser.mjs";

// Worker/wasm : URLs absolues résolues relativement à CE module (pas au
// document), car ces chaînes sont passées à Worker()/instantiate() qui, sinon,
// les résoudraient relativement à la page.
const VENDOR = new URL("../vendor/duckdb-wasm/", import.meta.url);
const BUNDLE = {
  mainModule: new URL("duckdb-eh.wasm", VENDOR).href,
  mainWorker: new URL("duckdb-browser-eh.worker.js", VENDOR).href,
};

// Base des Parquet, résolue en URL absolue relative à la page.
// En dev : servir le dépôt à la racine, ouvrir /webapp/ → pointe vers /data/parquet.
export const PARQUET_BASE = new URL("../data/parquet/", import.meta.url).href;

let _conn = null;
let _initPromise = null;

async function _init() {
  const worker = new Worker(BUNDLE.mainWorker);
  const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(), worker);
  await db.instantiate(BUNDLE.mainModule);
  _conn = await db.connect();
  // DuckDB charge l'extension parquet à la demande depuis extensions.duckdb.org
  // par défaut : on la fait pointer vers notre copie locale vendorisée pour
  // rester 100 % hors-ligne (aucun appel réseau externe au runtime).
  const repo = new URL("extensions", VENDOR).href;
  await _conn.query(`SET custom_extension_repository='${repo}';`);
  return _conn;
}

// Initialise (une seule fois) et renvoie la connexion.
export function initDB() {
  if (!_initPromise) _initPromise = _init();
  return _initPromise;
}

// Exécute une requête SQL et renvoie un tableau d'objets JS.
// DuckDB-WASM renvoie des BigInt pour les entiers 64 bits (COUNT, period…) :
// on les reconvertit en Number pour l'affichage et Chart.js.
export async function query(sql) {
  const conn = await initDB();
  const res = await conn.query(sql);
  return res.toArray().map((row) => {
    const obj = row.toJSON();
    for (const k in obj) if (typeof obj[k] === "bigint") obj[k] = Number(obj[k]);
    return obj;
  });
}

// --- Helpers de construction des sources Parquet ---

// Fichier agrégat (World/TOTAL), petit, pour les vues macro.
export function srcAggregat() {
  return `read_parquet('${PARQUET_BASE}aggregat/data.parquet')`;
}

// Détail : liste explicite des partitions annuelles (pas de glob possible en HTTP).
export function srcDetail(annees) {
  const urls = annees.map((y) => `'${PARQUET_BASE}detail/period=${y}/data.parquet'`);
  return `read_parquet([${urls.join(",")}])`;
}

// Minéraux critiques : partitions annuelles du dataset dédié.
export function srcCritical(annees) {
  const urls = annees.map((y) => `'${PARQUET_BASE}critical/period=${y}/data.parquet'`);
  return `read_parquet([${urls.join(",")}])`;
}

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
