"""
Prépare l'archive des fichiers volumineux à publier en asset de release GitHub :
les Parquet (data/parquet/) et le moteur DuckDB-WASM (binaire + extension
parquet). Ces fichiers sont exclus de git ; c'est deploy/build.sh qui les
récupère au moment du build Vercel.

Les chemins dans l'archive sont relatifs à webapp/, pour que le build puisse
faire simplement `tar -xzf - -C webapp`.

Usage :
    python deploy/package_assets.py
    # puis publier l'archive (le tag doit correspondre à ASSETS_TAG dans build.sh)
    gh release create donnees-v1 dist/webapp-assets.tar.gz --notes "Parquet + DuckDB-WASM"
"""

import sys
import tarfile
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
DIST_DIR = BASE_DIR / "dist"
ARCHIVE = DIST_DIR / "webapp-assets.tar.gz"

# (source sur disque, chemin dans l'archive = relatif à webapp/)
CONTENU = [
    (BASE_DIR / "data" / "parquet", "data/parquet"),
    (BASE_DIR / "webapp" / "vendor" / "duckdb-wasm" / "duckdb-eh.wasm", "vendor/duckdb-wasm/duckdb-eh.wasm"),
    (BASE_DIR / "webapp" / "vendor" / "duckdb-wasm" / "extensions", "vendor/duckdb-wasm/extensions"),
]


def verifier_sources() -> None:
    manquants = [str(src) for src, _ in CONTENU if not src.exists()]
    if manquants:
        raise SystemExit(
            "Sources manquantes :\n  "
            + "\n  ".join(manquants)
            + "\n\nLance d'abord clean/clean_export.py (Parquet) et récupère le .wasm "
            "(voir webapp/vendor/duckdb-wasm/README.md)."
        )


def taille_dossier(chemin: Path) -> int:
    if chemin.is_file():
        return chemin.stat().st_size
    return sum(f.stat().st_size for f in chemin.rglob("*") if f.is_file())


def main() -> None:
    verifier_sources()
    DIST_DIR.mkdir(exist_ok=True)

    # Compression niveau 1 : les Parquet sont déjà compressés en ZSTD, gzip n'y
    # gagne rien. Le seul gain réel est sur le .wasm, et le niveau 1 le capture
    # sans faire payer plusieurs minutes de CPU sur les 260 Mo de Parquet.
    with tarfile.open(ARCHIVE, "w:gz", compresslevel=1) as tar:
        for source, destination in CONTENU:
            print(f"  + {destination}  ({taille_dossier(source) / 1e6:.1f} Mo)")
            tar.add(source, arcname=destination)

    taille = ARCHIVE.stat().st_size / 1e6
    print(f"\nArchive écrite : {ARCHIVE.relative_to(BASE_DIR)}  ({taille:.1f} Mo)")
    print("\nPublier avec :")
    print(f"  gh release create donnees-v1 {ARCHIVE.relative_to(BASE_DIR).as_posix()} \\")
    print('    --notes "Parquet Comtrade + moteur DuckDB-WASM"')
    print("\nSi le tag existe déjà, remplacer l'asset :")
    print(f"  gh release upload donnees-v1 {ARCHIVE.relative_to(BASE_DIR).as_posix()} --clobber")


if __name__ == "__main__":
    sys.exit(main())
