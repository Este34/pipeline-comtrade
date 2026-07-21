"""
Données de référence UN Comtrade : reporters, codes HS, flux.
Ces appels ne consomment pas le quota premium (pas de subscription_key requise)
mais sont tout de même mis en cache sur disque pour éviter les allers-retours
réseau inutiles à chaque lancement.
"""

import comtradeapicall
import pandas as pd

import config


def get_reporters(force_refresh: bool = False) -> pd.DataFrame:
    """Retourne la liste de tous les pays reporters (hors groupes agrégés
    comme l'UE ou l'ASEAN), avec mise en cache sur disque."""
    if not force_refresh and config.REPORTERS_CACHE_FILE.exists():
        return pd.read_csv(config.REPORTERS_CACHE_FILE, dtype=str)

    df = comtradeapicall.getReference("reporter")
    df = df[df["isGroup"] == False].copy()  # noqa: E712 (comparaison explicite pandas)

    config.CHECKPOINTS_DIR.mkdir(parents=True, exist_ok=True)
    df.to_csv(config.REPORTERS_CACHE_FILE, index=False)
    return df


def get_hs_reference(level: int | None = None) -> pd.DataFrame:
    """Retourne la table de référence HS (code, libellé) pour le niveau
    demandé (2 chiffres par défaut) plus le code agrégat 'TOTAL', à partir de
    la classification HS combinée ('cmd:HS'). Fonctionne pour n'importe quel
    niveau (2, 4, 6...) sans modification, via la colonne aggrLevel fournie
    par l'API."""
    level = level or config.HS_LEVEL
    df = comtradeapicall.getReference(f"cmd:{config.CL_CODE}")
    return df[(df["id"] == "TOTAL") | (df["aggrLevel"] == level)][["id", "text"]]


def get_hs_codes(level: int | None = None) -> list[str]:
    """Retourne uniquement les codes (sans libellé) du niveau demandé, pour
    construire le paramètre cmdCode de getFinalData."""
    df = get_hs_reference(level)
    total = df[df["id"] == "TOTAL"]["id"].tolist()
    autres = sorted(df[df["id"] != "TOTAL"]["id"].tolist())
    return total + autres


def get_flows() -> pd.DataFrame:
    """Retourne la table de référence des flux commerciaux (import/export...)."""
    return comtradeapicall.getReference("flow")
