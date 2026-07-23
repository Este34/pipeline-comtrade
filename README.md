# Pipeline Comtrade

Pipeline en 3 phases sur le commerce international :

1. **Extraction massive** depuis l'API UN Comtrade, *fait*
2. **Nettoyage + export Parquet**, *fait*
3. **Webapp d'analyse 100% offline** (DuckDB-WASM), *fait*

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

## Phase 2, nettoyage + export Parquet (`clean/clean_export.py`)

```bash
python clean/clean_export.py
```

Depuis `data/comtrade.duckdb`, produit un jeu de données Parquet propre, enrichi
et partitionné, prêt pour la webapp offline DuckDB-WASM (Phase 3). Export 100 %
natif DuckDB. Résultat typique : ~4,2 Go de base → ~240 Mo de Parquet.

- `data/parquet/detail/period=YYYY/data.parquet` : détail complet (~36 M lignes),
  partitionné par année pour des lectures partielles en navigateur
- `data/parquet/aggregat/data.parquet` : lignes agrégées (partenaire *World* ou
  produit `TOTAL`), pour des dashboards macro instantanés
- `data/parquet/reference/*.parquet` : reporters, hs_codes, flows, continents

Chaque ligne de détail est enrichie de `reporterISO3`, `reporterContinent`,
`partnerISO3`, `partnerContinent` (ISO3 depuis les références Comtrade, continent
via `pycountry-convert` ; les codes spéciaux, World, zones *nes*, groupes, ont
un continent nul, ce qui est attendu).

## Minéraux critiques (dataset HS6 dédié)

En complément des chapitres HS2, un dataset **HS6** cible ~40 codes de minéraux
critiques (lithium, cobalt, terres rares, graphite, tungstène…), défini dans
`scraper/config.py → CRITICAL_MINERALS_HS6`.

```bash
python scraper/fetch_all.py --critical     # extraction (tous pays, 2000-2025)
python scraper/load_to_db.py --critical     # -> table trade_critical
python clean/clean_export.py --critical      # -> data/parquet/critical/
```

## Phase 3, webapp d'analyse offline (`webapp/`)

Application **vanilla** (aucun framework, aucun build) à identité **DSFR**, qui
interroge les Parquet directement dans le navigateur via **DuckDB-WASM**
(vendorisé, 100 % hors-ligne). Cinq vues : Profil pays, Analyse bilatérale,
Analyse par produit, Cartes & séries, Minéraux critiques. Libellés en français.

Fonctionnalités clés :
- **Bascule Valeur (US$) / Poids (t)** dans chaque vue. Le poids (`netWgt`) est
  fiable au niveau HS6 (minéraux) ; au niveau HS2 agrégé, Comtrade ne le rapporte
  généralement pas → affichage « poids non déclaré ».
- **Carte interactive** (Leaflet) dans « Cartes & séries » et « Minéraux
  critiques » : curseur d'années + bouton **Play** (animation 2000→2025), survol,
  clic pays. Le **fond de carte tuilé est chargé en ligne** (habillage
  uniquement) ; **les données restent 100 % offline** (DuckDB-WASM). Sans réseau,
  les pays colorés s'affichent quand même, sans le fond.
- **Minéraux critiques** : ~149 codes HS6 couvrant la chaîne matière première →
  alliage/demi-produit → produit fini (batteries, aimants, catalyseurs…), avec
  **filtre par catégorie** et **recherche par code HS6**. *Rappel : un produit
  fini contient le minéral sans en indiquer la teneur.*
- **Navigation** : barre de contrôle sticky en verre (logo Isec, onglets en
  pilules), **palette de commandes** (`Ctrl`/`Cmd` + `K`) pour sauter à une vue
  ou ouvrir directement le profil d'un pays, **combobox avec recherche**
  remplaçant les `<select>` à liste longue (pays, chapitres HS), **puces de
  filtres actifs** retirables, **squelettes de chargement** pendant les
  requêtes DuckDB-WASM, bouton de retour en haut de page.

### Piège hors-ligne : l'extension parquet de DuckDB

DuckDB charge la lecture Parquet comme une extension **à la demande**, récupérée
par défaut sur `extensions.duckdb.org`. Sans correctif, l'app n'est donc pas
réellement hors-ligne dès qu'une requête `read_parquet(...)` s'exécute. Le
correctif (`custom_extension_repository` pointé vers une copie locale de
l'extension) est documenté dans `webapp/vendor/duckdb-wasm/README.md`.

### Développement : cache navigateur

Le rechargement des modules ES peut être masqué par le cache du navigateur.
Pour fiabiliser l'itération, servir avec un en-tête `Cache-Control: no-store`
(sans réponses 304) ou changer de port entre deux essais. En production (site
statique), le cache est au contraire souhaitable.

### Générer les libellés FR puis lancer en local

```bash
python clean/labels_fr.py                    # webapp/data/reference/*.json (pays, chapitres, minéraux)
python -m http.server 8000                    # depuis la RACINE du dépôt
# puis ouvrir http://localhost:8000/webapp/
```

En développement, `webapp/data/parquet` est une **jonction** vers `data/parquet`
(voir ci-dessous). Le binaire `webapp/vendor/duckdb-wasm/duckdb-eh.wasm` (~35 Mo)
n'est pas commité : voir `webapp/vendor/duckdb-wasm/README.md` pour le récupérer.

### Déploiement sur Vercel

Le dépôt est prêt à déployer tel quel : `vercel.json` sert `webapp/` à la racine
du site. La seule étape manuelle est de publier les données une fois.

**Le problème que ça résout.** Vercel plafonne l'upload de *sources* à 100 Mo
sur le plan Hobby, or les Parquet et le moteur DuckDB-WASM pèsent ~290 Mo, et ils
sont exclus de git. Ils sont donc publiés en **asset de release GitHub**, et
`deploy/build.sh` les télécharge pendant le build : ils arrivent en *sortie* de
build, où le plafond des 100 Mo ne s'applique pas.

```bash
# 1. Fabriquer l'archive (Parquet + .wasm + extension parquet) -> dist/
python deploy/package_assets.py

# 2. La publier en release GitHub (tag = ASSETS_TAG dans deploy/build.sh)
gh release create donnees-v1 dist/webapp-assets.tar.gz --notes "Parquet Comtrade + DuckDB-WASM"

# 3. Connecter le dépôt à Vercel : aucun réglage à saisir, vercel.json fait tout.
```

Après un ré-export des données, republier l'archive puis redéployer :

```bash
python deploy/package_assets.py
gh release upload donnees-v1 dist/webapp-assets.tar.gz --clobber
```

Le build échoue explicitement (et non silencieusement) si l'archive est
absente ou incomplète. Pour publier une nouvelle version des données sans écraser
l'ancienne, créer un tag `donnees-v2` et définir la variable d'environnement
`ASSETS_TAG` dans les réglages Vercel du projet.

`vercel.json` met aussi les Parquet et le `.wasm` en cache immuable (un an) :
seule la première visite paie le téléchargement du moteur.

**Note sur les en-têtes.** Les en-têtes de sécurité usuels (`nosniff`,
`X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`) sont posés, mais pas
de CSP : `index.html` contient une *import map* inline, qui imposerait soit
`'unsafe-inline'` (CSP sans valeur réelle), soit un hash à resynchroniser à
chaque modification. Le site étant statique, en lecture seule, sans
authentification ni saisie utilisateur, le compromis ne le justifie pas.

### Déploiement ailleurs (dossier statique)

Copier dans un dossier autonome : tout `webapp/`, en remplaçant la jonction
`webapp/data/parquet` par une **copie réelle** de `data/parquet/` (détail +
aggregat + reference + critical) et en incluant le `.wasm`. Servir en HTTP
(les hôtes statiques gèrent les *range requests* nécessaires à DuckDB-WASM).
Aucune requête vers l'API Comtrade au runtime.

Recréer la jonction de dev (Windows) si besoin :
```powershell
New-Item -ItemType Junction -Path "webapp\data\parquet" -Target "data\parquet"
```

## Structure

```
scraper/                # Phase 1, extraction
├── config.py           # Périmètre + paramètres + chemins
├── fetch_all.py        # Extraction par (reporter, année)
├── load_to_db.py        # Chargement fichiers → DuckDB
└── reference_data.py    # Listes pays / codes HS / flux
clean/                   # Phase 2/3, nettoyage + export Parquet + libellés FR
├── enrich.py           # Mapping code pays → ISO3 + continent
├── clean_export.py      # Export Parquet partitionné + enrichi (+ --critical)
└── labels_fr.py          # Libellés FR (pays, chapitres HS, minéraux) → JSON
deploy/                  # Déploiement Vercel
├── build.sh            # Build Vercel : récupère les données depuis la release
└── package_assets.py    # Fabrique dist/webapp-assets.tar.gz à publier
webapp/                  # Phase 3, application d'analyse offline (DSFR)
├── index.html          # Coquille + onglets
├── css/, assets/         # Styles DSFR + police Marianne
├── vendor/               # DuckDB-WASM, Chart.js, apache-arrow, fond de carte
├── js/                    # db.js (DuckDB-WASM), charts, format, labels + views/
└── data/                   # reference/*.json (FR) + parquet/ (jonction/copie)
data/
├── raw/, raw_critical/   # Réponses brutes {reporterCode}_{year}.csv
├── checkpoints/           # progress*.json, failed*.json, reporters_cache.csv
├── comtrade.duckdb         # Base locale (trade_records + trade_critical)
└── parquet/               # detail/, aggregat/, reference/, critical/
```

`data/` et `.env` sont exclus de git (voir `.gitignore`) : aucune clé ni
donnée n'est commitée.
