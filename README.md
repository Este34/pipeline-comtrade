# Pipeline Comtrade

Phase 1 d'un pipeline en 3 phases sur le commerce international :

1. **Extraction massive** depuis l'API UN Comtrade (ce dépôt)
2. Nettoyage + export Parquet
3. Webapp d'analyse 100% offline (DuckDB-WASM + visualisations)

## Périmètre d'extraction

- Type : marchandises (`C`), fréquence annuelle (`A`), classification HS
- Flux : imports + exports (`M,X`)
- Produits : chapitres HS 2 chiffres (97 chapitres) + agrégat `TOTAL`
  (paramètre `HS_LEVEL` dans `scraper/config.py` pour passer à 4 chiffres plus tard)
- Reporters : tous les pays (liste dynamique via l'API de référence)
- Partenaires : tous
- Années : 2000 → 2025 (paramétrable via `ANNEE_DEBUT` / `ANNEE_FIN`)

Tous ces paramètres sont centralisés dans `scraper/config.py`.

## Installation

```bash
python -m venv venv
venv\Scripts\activate        # Windows
pip install -r requirements.txt
```

Copier `.env.example` en `.env` et renseigner ta clé API UN Comtrade :

```
COMTRADE_API_KEY=ta_cle_ici
```

## Utilisation

### 1. Extraction (`scraper/fetch_all.py`)

```bash
# Valider le pipeline sur un seul couple (France x 2023)
python scraper/fetch_all.py --test

# Restreindre à certains pays / années
python scraper/fetch_all.py --reporters FRA,DEU --years 2020-2023

# Lancement complet (demande confirmation avec estimation du nb d'appels)
python scraper/fetch_all.py --full

# Retenter uniquement les échecs enregistrés dans failed.json
python scraper/fetch_all.py --retry-failed
```

L'API étant payante, le script ne re-télécharge **jamais** un couple
(reporter, année) déjà présent dans `data/raw/` ou déjà marqué comme traité
dans `data/checkpoints/progress.json`. En cas d'interruption (Ctrl+C), la
reprise se fait automatiquement au prochain lancement.

- `data/checkpoints/progress.json` : couples traités avec succès (`ok` ou `empty`)
- `data/checkpoints/failed.json` : échecs définitifs (après 5 tentatives avec
  backoff exponentiel), à retenter avec `--retry-failed`
- `scraper.log` : log détaillé horodaté de chaque appel

### 2. Chargement dans DuckDB (`scraper/load_to_db.py`)

```bash
python scraper/load_to_db.py
```

Charge tous les fichiers CSV de `data/raw/` non encore chargés dans
`data/comtrade.duckdb` (table `trade_records`), de façon idempotente. Affiche
un résumé (nb de lignes, plage d'années, reporters distincts, taille du
fichier, % de nulls par colonne).

## Structure

```
scraper/
├── config.py          # Périmètre + paramètres
├── fetch_all.py        # Extraction par (reporter, année)
├── load_to_db.py        # Chargement fichiers → DuckDB
└── reference_data.py    # Listes pays / codes HS / flux
data/
├── raw/                # Réponses brutes {reporterCode}_{year}.csv
├── checkpoints/         # progress.json, failed.json, reporters_cache.csv
└── comtrade.duckdb       # Base locale
```

`data/` et `.env` sont exclus de git (voir `.gitignore`) : aucune clé ni
donnée n'est commitée.
