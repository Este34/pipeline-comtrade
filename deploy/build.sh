#!/usr/bin/env bash
# Build Vercel : récupère les Parquet et le moteur DuckDB-WASM depuis les assets
# d'une release GitHub, puis les dépose dans webapp/ (= outputDirectory).
#
# Ces fichiers pèsent ~290 Mo et sont exclus de git. Les faire arriver en SORTIE
# de build (et non en source) est ce qui permet de tenir dans le plafond Vercel
# de 100 Mo d'upload de sources sur le plan Hobby.
set -euo pipefail

TAG="${ASSETS_TAG:-donnees-v1}"
ARCHIVE="webapp-assets.tar.gz"
URL="https://github.com/Este34/pipeline-comtrade/releases/download/${TAG}/${ARCHIVE}"

echo "Téléchargement des données (release ${TAG}) : ${URL}"
curl -fsSL --retry 3 --retry-delay 2 "${URL}" | tar -xzf - -C webapp

# Vérification explicite : sans ce garde-fou, un build qui réussit avec une
# archive incomplète produirait un site cassé seulement à l'exécution, avec des
# erreurs DuckDB dans la console du navigateur et aucune trace côté build.
REQUIS=(
  "webapp/vendor/duckdb-wasm/duckdb-eh.wasm"
  "webapp/vendor/duckdb-wasm/extensions/v1.1.1/wasm_eh/parquet.duckdb_extension.wasm"
  "webapp/data/parquet/aggregat/data.parquet"
  "webapp/data/parquet/reference/reporters.parquet"
)
for fichier in "${REQUIS[@]}"; do
  if [ ! -s "${fichier}" ]; then
    echo "ERREUR : ${fichier} absent ou vide après extraction de l'archive." >&2
    echo "Vérifie que la release ${TAG} contient bien ${ARCHIVE} à jour." >&2
    exit 1
  fi
done

NB_PARQUET=$(find webapp/data/parquet -name '*.parquet' | wc -l)
echo "OK : ${NB_PARQUET} fichiers Parquet et le moteur DuckDB-WASM sont en place."
