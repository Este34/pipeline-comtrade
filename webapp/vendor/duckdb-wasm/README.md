# DuckDB-WASM (vendorisé, offline)

Fichiers du build **eh** de `@duckdb/duckdb-wasm@1.29.0`, servis en local pour
un fonctionnement 100 % hors-ligne (aucun CDN au runtime) :

- `duckdb-browser.mjs` : API async (importe `apache-arrow`, résolu via l'import
  map de `index.html` vers `../apache-arrow/arrow.min.mjs`)
- `duckdb-browser-eh.worker.js` : worker
- `duckdb-eh.wasm` : moteur (~35 Mo, **non commité**, voir ci-dessous)
- `extensions/v1.1.1/wasm_eh/parquet.duckdb_extension.wasm` : extension parquet
  (~2,8 Mo, **non commitée**, voir ci-dessous)

Le build `eh` ne nécessite pas d'isolation cross-origin (COOP/COEP) ni de
`SharedArrayBuffer` : il fonctionne derrière un simple serveur statique.

## Piège découvert : l'extension parquet se charge par défaut depuis Internet

DuckDB charge la lecture Parquet comme une extension **à la demande**, et va
la chercher par défaut sur `extensions.duckdb.org`. Sans correctif, l'app
n'est donc pas réellement hors-ligne dès qu'une requête `read_parquet(...)`
s'exécute. `webapp/js/db.js` fixe `custom_extension_repository` vers le
dossier `extensions/` local juste après la connexion, pour que ce
téléchargement se fasse depuis notre propre serveur plutôt que depuis
Internet.

## Re-télécharger les binaires (exclus de git)

```bash
curl -L -o duckdb-eh.wasm \
  https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.29.0/dist/duckdb-eh.wasm

mkdir -p extensions/v1.1.1/wasm_eh
curl -L -o extensions/v1.1.1/wasm_eh/parquet.duckdb_extension.wasm \
  https://extensions.duckdb.org/v1.1.1/wasm_eh/parquet.duckdb_extension.wasm
```
