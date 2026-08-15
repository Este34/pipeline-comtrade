"""
Complète le dataset HS6 minéraux critiques avec les codes ajoutés à
config.CRITICAL_MINERALS_HS6 après une extraction, sans tout re-télécharger.

Pourquoi un script à part. fetch_all.py boucle sur (déclarant, année) et saute
tout couple déjà traité : ajouter des codes l'obligerait à effacer les
checkpoints et à relancer les ~4300 appels de l'extraction complète. Or l'API
accepte d'omettre le déclarant pour renvoyer tous les pays d'un coup. Un appel
par (année, flux) suffit donc, soit 52 appels au lieu de 4300, mesuré et vérifié :
un appel de contrôle sur 2023 a renvoyé 165 déclarants et 244 partenaires.

Le découpage par flux n'est pas cosmétique : ce même appel de contrôle, tous
flux confondus, atteignait 84 % du plafond de 250 000 lignes. Séparer imports et
exports ramène chaque réponse autour de 40 %, et le script échoue bruyamment si
une réponse frôle malgré tout le plafond, plutôt que de laisser passer des
données silencieusement tronquées.

Usage :
    python scraper/fetch_complement.py --dry-run   # ce qui manque, sans appeler
    python scraper/fetch_complement.py             # extraction (avec confirmation)
"""

import argparse
import contextlib
import io
import json
import logging
import sys
import time
from datetime import datetime

import comtradeapicall
import duckdb
from tqdm import tqdm

import config
import reference_data

PLAFOND = 250000
# En dessous de cette marge, on considère la réponse suspecte de troncature.
SEUIL_ALERTE = 0.95
CHECKPOINT = config.CHECKPOINTS_DIR / "progress_complement.json"


def codes_manquants() -> list[str]:
    """Codes présents dans la config mais absents de la table déjà chargée."""
    attendus = set(config.CRITICAL_MINERALS_HS6)
    if not config.DB_PATH.exists():
        return sorted(attendus)
    con = duckdb.connect(str(config.DB_PATH), read_only=True)
    try:
        tables = {r[0] for r in con.execute("SELECT table_name FROM information_schema.tables").fetchall()}
        if "trade_critical" not in tables:
            return sorted(attendus)
        presents = {r[0] for r in con.execute("SELECT DISTINCT cmdCode FROM trade_critical").fetchall()}
    finally:
        con.close()
    return sorted(attendus - presents)


def charger_checkpoint() -> dict:
    if not CHECKPOINT.exists():
        return {}
    with open(CHECKPOINT, encoding="utf-8") as f:
        return json.load(f)


def sauver_checkpoint(donnees: dict) -> None:
    tmp = CHECKPOINT.with_suffix(".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(donnees, f, ensure_ascii=False, indent=2)
    tmp.replace(CHECKPOINT)


def appeler(codes: list[str], annee: int, flux: str):
    """Un appel, tous déclarants. Renvoie (df, erreur)."""
    derniere = None
    for tentative in range(1, config.MAX_RETRIES + 1):
        buffer = io.StringIO()
        df = None
        try:
            with contextlib.redirect_stdout(buffer):
                df = comtradeapicall.getFinalData(
                    subscription_key=config.COMTRADE_API_KEY,
                    typeCode=config.TYPE_CODE,
                    freqCode=config.FREQ_CODE,
                    clCode=config.CL_CODE,
                    period=str(annee),
                    reporterCode=None,  # tous les déclarants en un appel
                    cmdCode=",".join(codes),
                    flowCode=flux,
                    partnerCode=None, partner2Code=None, customsCode=None, motCode=None,
                    maxRecords=PLAFOND, format_output="JSON",
                    aggregateBy=None, breakdownMode="classic", countOnly=None, includeDesc=True,
                )
        except Exception as e:  # noqa: BLE001
            derniere = f"{type(e).__name__}: {e}"

        if df is not None:
            return df, None
        message = buffer.getvalue().strip()
        derniere = message or derniere or "getFinalData a retourné None sans message"
        if tentative < config.MAX_RETRIES:
            attente = config.BACKOFF_BASE**tentative
            logging.warning("%s %s tentative %d/%d échouée (%s), nouvel essai dans %ds",
                            annee, flux, tentative, config.MAX_RETRIES, derniere, attente)
            time.sleep(attente)
    return None, derniere


def main() -> None:
    parser = argparse.ArgumentParser(description="Extraction complémentaire HS6 (codes ajoutés)")
    parser.add_argument("--dry-run", action="store_true", help="Affiche ce qui manque sans appeler l'API")
    args = parser.parse_args()

    config.verifier_cle_api()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s",
                        handlers=[logging.FileHandler(config.LOG_PATH, encoding="utf-8")])

    codes = codes_manquants()
    if not codes:
        print("Aucun code manquant : la table trade_critical couvre déjà toute la config.")
        return

    par_mineral = {}
    for c in codes:
        par_mineral.setdefault(config.CRITICAL_MINERALS_HS6[c]["mineral"], []).append(c)
    print(f"{len(codes)} codes HS6 manquants, sur {len(par_mineral)} minéraux :")
    for m, cs in sorted(par_mineral.items()):
        print(f"  {m:<28} {len(cs)} codes")

    annees = list(range(config.ANNEE_DEBUT, config.ANNEE_FIN + 1))
    taches = [(a, f) for a in annees for f in ("M", "X")]
    fait = charger_checkpoint()
    restants = [(a, f) for a, f in taches if f"{a}_{f}" not in fait]
    print(f"\n{len(taches)} appels prévus ({len(annees)} années x 2 flux), {len(restants)} restants.")

    if args.dry_run:
        print("\n--dry-run : aucun appel effectué.")
        return

    if input("Confirmer le lancement ? [y/N] ").strip().lower() != "y":
        print("Annulé.")
        return

    # Mêmes déclarants que l'extraction principale : sans ce filtre, les groupes
    # agrégés (UE, ASEAN...) entreraient dans le complément et fausseraient les
    # totaux par rapport aux minéraux déjà extraits.
    reporters_valides = set(reference_data.get_reporters()["reporterCode"].astype(str))
    config.RAW_CRITICAL_DIR.mkdir(parents=True, exist_ok=True)

    for annee, flux in tqdm(restants, desc="Complément"):
        df, erreur = appeler(codes, annee, flux)
        time.sleep(config.PAUSE_ENTRE_REQUETES)
        if df is None:
            logging.error("%s %s ECHEC : %s", annee, flux, erreur)
            raise SystemExit(f"\nÉchec sur {annee}/{flux} : {erreur}\nRelancez : la reprise est automatique.")

        if len(df) >= PLAFOND * SEUIL_ALERTE:
            raise SystemExit(
                f"\n{annee}/{flux} : {len(df):,} lignes, trop proche du plafond de {PLAFOND:,}.\n"
                "La réponse est probablement tronquée. Découpez davantage (par groupe de codes) "
                "avant de poursuivre, sinon des données manqueront sans que rien ne le signale."
            )

        if len(df):
            avant = len(df)
            df = df[df["reporterCode"].astype(str).isin(reporters_valides)]
            fichier = config.RAW_CRITICAL_DIR / f"complement_{annee}_{flux}.csv"
            df.to_csv(fichier, index=False)
            logging.info("%s %s OK (%d lignes, %d hors groupes)", annee, flux, avant, len(df))

        fait[f"{annee}_{flux}"] = {"lignes": int(len(df)), "timestamp": datetime.now().isoformat(timespec="seconds")}
        sauver_checkpoint(fait)

    total = sum(v["lignes"] for v in fait.values())
    print(f"\nTerminé : {total:,} lignes écrites dans {config.RAW_CRITICAL_DIR.name}/.")
    print("Suite : python scraper/load_to_db.py --critical, puis python clean/clean_export.py --critical")


if __name__ == "__main__":
    sys.exit(main())
