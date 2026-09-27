#!/bin/sh
# Pull the latest QSS-M, then rebuild the index, reference, and any FAQ answers whose
# evidence changed. The running server picks up the new files on its next request.
set -eu
cd "$(dirname "$0")/.."
QSSM_DIR="${QSSM_DIR:-../QSS-M}"
git -C "$QSSM_DIR" pull --ff-only --quiet
export KNOWLEDGE_SOURCE_QSSM="${KNOWLEDGE_SOURCE_QSSM:-$QSSM_DIR}"
npm run --silent refresh
