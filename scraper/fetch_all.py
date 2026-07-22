"""
Extraction massive UN Comtrade : boucle sur (reporter, année), avec
checkpointing strict pour ne jamais gaspiller un appel API payant.

Usage :
    python scraper/fetch_all.py --test
    python scraper/fetch_all.py --reporters FRA,DEU --years 2020-2023
    python scraper/fetch_all.py --full
    python scraper/fetch_all.py --retry-failed
"""

import argparse
import contextlib
import io
import json
import logging
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime

import comtradeapicall
from tqdm import tqdm

import config
import reference_data


def maintenant():
    return datetime.now().isoformat(timespec="seconds")


def charger_json(chemin, defaut):
    if not chemin.exists():
        return defaut
    with open(chemin, "r", encoding="utf-8") as f:
        return json.load(f)


def sauvegarder_json(chemin, donnees):
    """Écriture atomique (fichier temporaire + remplacement) pour éviter un
    progress.json corrompu en cas de coupure pendant l'écriture."""
    tmp = chemin.with_suffix(chemin.suffix + ".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(donnees, f, ensure_ascii=False, indent=2)
    tmp.replace(chemin)


def enregistrer_echec(failed, code, annee, erreur):
    for f in failed:
        if str(f["reporter"]) == code and int(f["year"]) == annee:
            f["error"] = erreur
            f["attempts"] = f.get("attempts", 0) + 1
            f["last_attempt"] = maintenant()
            return
    failed.append(
        {
            "reporter": code,
            "year": annee,
            "error": erreur,
            "attempts": 1,
            "last_attempt": maintenant(),
        }
    )


def retirer_de_failed(failed, code, annee):
    failed[:] = [
        f for f in failed if not (str(f["reporter"]) == code and int(f["year"]) == annee)
    ]


def tenter_telechargement(cmd_codes, reporter_code, annee):
    """Appelle getFinalData avec retry + backoff exponentiel. Le package ne
    lève pas d'exception ni n'expose le code HTTP en cas d'erreur (429, 5xx) :
    il affiche le message via print() et retourne None. On capture ce print()
    pour avoir un message d'erreur exploitable dans failed.json."""
    derniere_erreur = None
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
                    reporterCode=reporter_code,
                    cmdCode=cmd_codes,
                    flowCode=config.FLOW_CODE,
                    partnerCode=None,
                    partner2Code=None,
                    customsCode=None,
                    motCode=None,
                    maxRecords=250000,
                    format_output="JSON",
                    aggregateBy=None,
                    breakdownMode="classic",
                    countOnly=None,
                    includeDesc=True,
                )
        except Exception as e:  # noqa: BLE001 — on veut capturer toute erreur pour le retry
            derniere_erreur = f"{type(e).__name__}: {e}"

        if df is not None:
            return df, None

        message_capture = buffer.getvalue().strip()
        if message_capture:
            derniere_erreur = message_capture
        elif derniere_erreur is None:
            derniere_erreur = "getFinalData a retourné None sans message d'erreur"

        if tentative < config.MAX_RETRIES:
            attente = config.BACKOFF_BASE**tentative
            logging.warning(
                "%s %s tentative %d/%d échouée (%s) — nouvel essai dans %ds",
                reporter_code,
                annee,
                tentative,
                config.MAX_RETRIES,
                derniere_erreur,
                attente,
            )
            time.sleep(attente)

    return None, derniere_erreur


def construire_paires(args, reporters_df):
    """Construit la liste des (reporter, année) à traiter selon les args CLI."""
    if args.retry_failed:
        failed = charger_json(config.FAILED_FILE, [])
        par_code = {str(r["reporterCode"]): r for r in reporters_df.to_dict("records")}
        paires = []
        for f in failed:
            code = str(f["reporter"])
            reporter = par_code.get(code, {"reporterCode": code})
            paires.append((reporter, int(f["year"])))
        return paires

    if args.test:
        reporters = reporters_df[reporters_df["reporterCodeIsoAlpha3"] == "FRA"]
        annees = [2023]
    else:
        if args.reporters:
            voulus = {c.strip().upper() for c in args.reporters.split(",")}
            reporters = reporters_df[reporters_df["reporterCodeIsoAlpha3"].isin(voulus)]
        else:
            reporters = reporters_df

        if args.years:
            debut, fin = args.years.split("-")
            annees = list(range(int(debut), int(fin) + 1))
        else:
            annees = list(range(config.ANNEE_DEBUT, config.ANNEE_FIN + 1))

    reporters = reporters.to_dict("records")
    return [(r, a) for r in reporters for a in annees]


def confirmer_lancement_complet(paires):
    n = len(paires)
    # ~20s de latence API observée en moyenne par appel, répartie sur N_WORKERS
    duree_estimee_h = n * (config.PAUSE_ENTRE_REQUETES + 20) / config.N_WORKERS / 3600
    print(f"Lancement complet : {n} appels prévus (reporters × années), {config.N_WORKERS} en parallèle.")
    print(f"Durée estimée : ~{duree_estimee_h:.1f} heures (estimation, hors retries).")
    reponse = input("Confirmer le lancement ? [y/N] ").strip().lower()
    if reponse != "y":
        print("Annulé.")
        sys.exit(0)


def configurer_logging():
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        handlers=[logging.FileHandler(config.LOG_PATH, encoding="utf-8")],
    )


def traiter_paire(reporter, annee, cmd_codes, progress, failed, verrou):
    """Traite une paire (reporter, année). Le verrou protège uniquement les
    accès aux dicts partagés progress/failed et l'écriture des checkpoints ;
    l'appel réseau (tenter_telechargement) reste hors verrou pour permettre
    le vrai parallélisme entre workers."""
    code = str(reporter["reporterCode"])
    cle = f"{code}_{annee}"
    fichier = config.RAW_DIR / f"{code}_{annee}.csv"

    with verrou:
        # Un fichier déjà présent et non vide n'est jamais re-téléchargé.
        if fichier.exists() and fichier.stat().st_size > 0:
            if cle not in progress:
                progress[cle] = {
                    "status": "ok",
                    "rows": None,
                    "file": fichier.name,
                    "note": "fichier pré-existant, non revérifié",
                    "timestamp": maintenant(),
                }
                sauvegarder_json(config.PROGRESS_FILE, progress)
            return

        if cle in progress and progress[cle].get("status") in ("ok", "empty"):
            return

    debut = time.time()
    df, erreur = tenter_telechargement(cmd_codes, code, annee)
    duree = time.time() - debut
    time.sleep(config.PAUSE_ENTRE_REQUETES)

    with verrou:
        if df is None:
            enregistrer_echec(failed, code, annee, erreur)
            sauvegarder_json(config.FAILED_FILE, failed)
            logging.error("%s %s ECHEC après %d tentatives : %s", code, annee, config.MAX_RETRIES, erreur)
            return

        if len(df) == 0:
            progress[cle] = {"status": "empty", "timestamp": maintenant()}
            sauvegarder_json(config.PROGRESS_FILE, progress)
            retirer_de_failed(failed, code, annee)
            sauvegarder_json(config.FAILED_FILE, failed)
            logging.info("%s %s VIDE (0 ligne) en %.1fs", code, annee, duree)
            return

        colonnes_manquantes = [c for c in config.COLONNES_ATTENDUES if c not in df.columns]
        if colonnes_manquantes:
            enregistrer_echec(failed, code, annee, f"colonnes manquantes : {colonnes_manquantes}")
            sauvegarder_json(config.FAILED_FILE, failed)
            logging.error("%s %s ECHEC : colonnes manquantes %s", code, annee, colonnes_manquantes)
            return

        df.to_csv(fichier, index=False)
        progress[cle] = {"status": "ok", "rows": len(df), "file": fichier.name, "timestamp": maintenant()}
        sauvegarder_json(config.PROGRESS_FILE, progress)
        retirer_de_failed(failed, code, annee)
        sauvegarder_json(config.FAILED_FILE, failed)
        logging.info("%s %s OK (%d lignes) en %.1fs", code, annee, len(df), duree)


def main():
    config.verifier_cle_api()
    config.RAW_DIR.mkdir(parents=True, exist_ok=True)
    config.CHECKPOINTS_DIR.mkdir(parents=True, exist_ok=True)
    configurer_logging()

    parser = argparse.ArgumentParser(description="Extraction massive UN Comtrade")
    parser.add_argument("--test", action="store_true", help="1 seul couple (France x 2023)")
    parser.add_argument("--reporters", type=str, default=None, help="Codes ISO3 séparés par virgule, ex: FRA,DEU")
    parser.add_argument("--years", type=str, default=None, help="Plage d'années, ex: 2020-2023")
    parser.add_argument("--full", action="store_true", help="Lancement complet (avec confirmation)")
    parser.add_argument("--retry-failed", action="store_true", help="Retenter les échecs de failed.json")
    args = parser.parse_args()

    reporters_df = reference_data.get_reporters()
    paires = construire_paires(args, reporters_df)

    if not paires:
        print("Rien à traiter (failed.json vide ou filtre sans résultat).")
        return

    if args.full:
        confirmer_lancement_complet(paires)

    cmd_codes = ",".join(reference_data.get_hs_codes())

    progress = charger_json(config.PROGRESS_FILE, {})
    failed = charger_json(config.FAILED_FILE, [])
    verrou = threading.Lock()

    try:
        with ThreadPoolExecutor(max_workers=config.N_WORKERS) as executor:
            futures = [
                executor.submit(traiter_paire, reporter, annee, cmd_codes, progress, failed, verrou)
                for reporter, annee in paires
            ]
            for future in tqdm(as_completed(futures), total=len(futures), desc="Extraction"):
                future.result()  # relance ici toute exception inattendue d'un worker
    except KeyboardInterrupt:
        logging.warning("Interruption manuelle (Ctrl+C).")
        print("\nInterrompu. progress.json/failed.json sont à jour (sauvegarde après chaque paire traitée) : relance plus tard pour reprendre.")
        sys.exit(130)


if __name__ == "__main__":
    main()
