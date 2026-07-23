"""
Configuration centrale du pipeline d'extraction UN Comtrade.
Tous les paramètres du périmètre d'extraction sont regroupés ici.
"""

import os
from pathlib import Path

from dotenv import load_dotenv

# Racine du projet (parent du dossier scraper/)
BASE_DIR = Path(__file__).resolve().parent.parent

# Chargement des variables d'environnement (.env à la racine du projet)
load_dotenv(BASE_DIR / ".env")

COMTRADE_API_KEY = os.getenv("COMTRADE_API_KEY")

# --- Périmètre d'extraction ---
TYPE_CODE = "C"  # C = commodities (marchandises)
FREQ_CODE = "A"  # A = annuel
CL_CODE = "HS"  # classification HS
FLOW_CODE = "M,X"  # imports + exports

# Niveau de détail produit (2 = chapitres HS à 2 chiffres). Changer ici pour
# passer à 4 chiffres plus tard : reference_data.get_hs_codes() s'adapte
# automatiquement à ce niveau.
HS_LEVEL = 2

ANNEE_DEBUT = 2000
ANNEE_FIN = 2025

# --- Comportement réseau ---
PAUSE_ENTRE_REQUETES = 1.5  # secondes entre deux appels d'un même worker
MAX_RETRIES = 5
BACKOFF_BASE = 2  # secondes ; backoff exponentiel 2,4,8,16,32

# Nombre d'appels API en parallèle. La latence observée par appel (4 à 70s,
# selon le volume de données du pays) domine largement PAUSE_ENTRE_REQUETES :
# c'est donc le vrai levier pour accélérer un fetch --full de plusieurs
# milliers de paires. À ajuster à la baisse si des 429 répétés apparaissent
# dans scraper.log.
N_WORKERS = 6

# --- Chemins ---
DATA_DIR = BASE_DIR / "data"
RAW_DIR = DATA_DIR / "raw"
CHECKPOINTS_DIR = DATA_DIR / "checkpoints"
PROGRESS_FILE = CHECKPOINTS_DIR / "progress.json"
FAILED_FILE = CHECKPOINTS_DIR / "failed.json"
REPORTERS_CACHE_FILE = CHECKPOINTS_DIR / "reporters_cache.csv"
DB_PATH = DATA_DIR / "comtrade.duckdb"
LOG_PATH = BASE_DIR / "scraper.log"

# --- Phase 2 : export Parquet ---
PARQUET_DIR = DATA_DIR / "parquet"
PARQUET_DETAIL_DIR = PARQUET_DIR / "detail"
PARQUET_AGGREGAT_DIR = PARQUET_DIR / "aggregat"
PARQUET_REFERENCE_DIR = PARQUET_DIR / "reference"
PARQUET_CRITICAL_DIR = PARQUET_DIR / "critical"

# --- Phase 3 : extraction HS6 minéraux critiques (dataset dédié) ---
# Chemins séparés pour ne pas mélanger avec le run HS2 principal.
RAW_CRITICAL_DIR = DATA_DIR / "raw_critical"
PROGRESS_CRITICAL_FILE = CHECKPOINTS_DIR / "progress_critical.json"
FAILED_CRITICAL_FILE = CHECKPOINTS_DIR / "failed_critical.json"

# Catégories de la chaîne de valeur (utilisées comme filtre dans la webapp).
CAT_MP = "Matière première"          # minerais, concentrés, oxydes, sels
CAT_ALLIAGE = "Alliage / demi-produit"  # ferro-alliages, métal brut/ouvré, poudres, déchets
CAT_FINI = "Produit fini"             # batteries, aimants, catalyseurs, condensateurs, PV

# Liste curée élargie de codes HS6 (tous validés dans la référence Comtrade
# 'cmd:HS'), couvrant la chaîne : matière première → alliage/demi-produit →
# produit fini embarquant le minéral. Base : listes UE/USGS des matières
# premières critiques. Rappel : les stats douanières classent par PRODUIT, pas
# par teneur — les produits finis « contiennent » le minéral sans en donner la
# quantité embarquée.
# Structure : (minéral, catégorie, [codes HS6]).
_CRITICAL_GROUPS = [
    ("Lithium", CAT_MP, ["282520", "283691", "284530"]),
    ("Lithium", CAT_FINI, ["850650", "850760"]),
    ("Cobalt", CAT_MP, ["260500", "282200", "282734"]),
    ("Cobalt", CAT_ALLIAGE, ["810510", "810520", "810530", "810590"]),
    ("Terres rares", CAT_MP, ["280530", "284610", "284690"]),
    ("Terres rares", CAT_ALLIAGE, ["360690"]),
    ("Terres rares", CAT_FINI, ["850511", "850519"]),  # aimants permanents (NdFeB dominant)
    ("Graphite", CAT_MP, ["250410", "250490", "380110", "380120", "380190"]),
    ("Tungstène", CAT_MP, ["261100", "284180"]),
    ("Tungstène", CAT_ALLIAGE, ["720280", "810110", "810191", "810194", "810196", "810197", "810199"]),
    ("Tungstène", CAT_FINI, ["853921", "853922"]),  # lampes à filament tungstène
    ("Niobium, tantale, vanadium", CAT_MP, ["261590"]),
    ("Niobium", CAT_ALLIAGE, ["720293"]),
    ("Tantale", CAT_ALLIAGE, ["810310", "810320", "810330", "810390", "810391", "810399"]),
    ("Tantale", CAT_FINI, ["853221"]),  # condensateurs au tantale
    ("Vanadium", CAT_MP, ["262050", "282530"]),
    ("Vanadium", CAT_ALLIAGE, ["720292", "811240"]),
    ("Nickel", CAT_MP, ["260400", "282540", "282735", "283324"]),
    ("Nickel", CAT_ALLIAGE, ["750110", "750120", "750210", "750220", "750300", "750400", "750511", "750512"]),
    ("Nickel", CAT_FINI, ["381511", "381519", "850730", "850750"]),  # catalyseurs, batteries NiCd/NiMH
    ("Manganèse", CAT_MP, ["260200", "282010", "282090"]),
    ("Manganèse", CAT_ALLIAGE, ["720211", "720219", "720230", "811100"]),
    ("Manganèse", CAT_FINI, ["850610", "850611"]),  # piles au dioxyde de manganèse
    ("Titane", CAT_MP, ["261400", "282300", "320611", "320619"]),
    ("Titane", CAT_ALLIAGE, ["720291", "810810", "810820", "810830", "810890"]),
    ("Chrome", CAT_MP, ["261000", "281910", "281990", "283323"]),
    ("Chrome", CAT_ALLIAGE, ["720241", "720249", "720250", "811221", "811222", "811229"]),
    ("Platine", CAT_ALLIAGE, ["711011", "711019", "711292"]),
    ("Platine", CAT_FINI, ["711510"]),  # catalyseurs en toile de platine
    ("Palladium", CAT_ALLIAGE, ["711021", "711029"]),
    ("Rhodium", CAT_ALLIAGE, ["711031", "711039"]),
    ("Iridium, osmium, ruthénium", CAT_ALLIAGE, ["711041", "711049"]),
    ("Antimoine", CAT_MP, ["261710", "282580"]),
    ("Antimoine", CAT_ALLIAGE, ["811010", "811020", "811090"]),
    ("Magnésium", CAT_MP, ["251910", "251990", "281610", "282731"]),
    ("Magnésium", CAT_ALLIAGE, ["810411", "810419", "810420", "810430", "810490"]),
    ("Silicium", CAT_MP, ["280461", "280469", "281122", "284920"]),
    ("Silicium", CAT_ALLIAGE, ["720221", "720229"]),
    ("Silicium", CAT_FINI, ["850171", "854141", "854143"]),  # générateurs PV, cellules photovoltaïques
    ("Gallium, germanium, indium", CAT_MP, ["282560"]),
    ("Gallium, germanium, indium", CAT_ALLIAGE, ["811230", "811292", "811299"]),
    ("Béryllium", CAT_ALLIAGE, ["811211", "811212", "811213", "811219"]),
    ("Molybdène", CAT_MP, ["261310", "261390", "282570", "284170"]),
    ("Molybdène", CAT_ALLIAGE, ["720270", "810210", "810291", "810294", "810295", "810296", "810297", "810299"]),
    ("Bismuth", CAT_MP, ["283422", "283693"]),
    ("Bismuth", CAT_ALLIAGE, ["810600", "810610", "810690"]),
]

# code HS6 -> {"mineral": ..., "categorie": ...}
CRITICAL_MINERALS_HS6 = {
    code: {"mineral": mineral, "categorie": cat}
    for mineral, cat, codes in _CRITICAL_GROUPS
    for code in codes
}

# Colonnes attendues dans une réponse valide de l'API
COLONNES_ATTENDUES = [
    "period",
    "reporterCode",
    "reporterDesc",
    "partnerCode",
    "partnerDesc",
    "flowCode",
    "flowDesc",
    "cmdCode",
    "cmdDesc",
    "primaryValue",
    "netWgt",
    "qty",
    "qtyUnitAbbr",
]


def verifier_cle_api():
    """Vérifie que la clé API est bien présente, sort proprement sinon."""
    if not COMTRADE_API_KEY:
        raise SystemExit(
            "COMTRADE_API_KEY manquante. Copie .env.example en .env et "
            "renseigne ta clé API UN Comtrade."
        )
