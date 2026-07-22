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

// Fichier agrégat (World/TOTAL) — petit, pour les vues macro.
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
