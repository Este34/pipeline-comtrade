# DuckDB-WASM (vendorisé, offline)

Fichiers du build **eh** de `@duckdb/duckdb-wasm@1.29.0`, servis en local pour
un fonctionnement 100 % hors-ligne (aucun CDN au runtime) :

- `duckdb-browser.mjs` — API async (importe `apache-arrow`, résolu via l'import
  map de `index.html` vers `../apache-arrow/arrow.min.mjs`)
- `duckdb-browser-eh.worker.js` — worker
- `duckdb-eh.wasm` — moteur (~35 Mo, **non commité** : voir ci-dessous)

Le build `eh` ne nécessite pas d'isolation cross-origin (COOP/COEP) ni de
`SharedArrayBuffer` : il fonctionne derrière un simple serveur statique.

## Re-télécharger le WASM (exclu de git)

```bash
curl -L -o duckdb-eh.wasm \
  https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.29.0/dist/duckdb-eh.wasm
```
