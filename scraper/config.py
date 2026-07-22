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

# Liste curée de codes HS6 de minéraux/matières critiques (tous validés dans la
# référence Comtrade 'cmd:HS'). Un minéral peut couvrir plusieurs codes
# (minerai, oxyde, métal brut). Base : listes UE/USGS des matières premières
# critiques, restreintes aux formes primaires (minerais, concentrés, oxydes,
# métaux bruts) pertinentes pour une analyse de dépendance d'approvisionnement.
CRITICAL_MINERALS_HS6 = {
    "250410": "Graphite",
    "250490": "Graphite",
    "380110": "Graphite",
    "251910": "Magnésium",
    "251990": "Magnésium",
    "280461": "Silicium",
    "260200": "Manganèse",
    "282010": "Manganèse",
    "260400": "Nickel",
    "282540": "Nickel",
    "260500": "Cobalt",
    "282200": "Cobalt",
    "810510": "Cobalt",
    "282520": "Lithium",
    "283691": "Lithium",
    "261100": "Tungstène",
    "810191": "Tungstène",
    "261590": "Niobium, tantale, vanadium",
    "810310": "Tantale",
    "810390": "Tantale",
    "261400": "Titane",
    "282300": "Titane",
    "262050": "Vanadium",
    "282530": "Vanadium",
    "260300": "Cuivre",
    "260800": "Zinc",
    "260600": "Aluminium (bauxite)",
    "261000": "Chrome",
    "261710": "Antimoine",
    "282580": "Antimoine",
    "280530": "Terres rares",
    "284610": "Terres rares",
    "284690": "Terres rares",
    "711011": "Platine",
    "711021": "Palladium",
    "711041": "Iridium, osmium, ruthénium",
    "811211": "Béryllium",
    "811230": "Germanium",
    "811292": "Gallium, germanium, indium",
    "282560": "Germanium, zirconium",
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
