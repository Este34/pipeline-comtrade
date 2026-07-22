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
