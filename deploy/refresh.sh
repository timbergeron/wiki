#!/bin/sh
# Run manually in the local workspace to pull QSS-M and rebuild the index and reference.
# FAQ content is maintained here separately; this does not call OpenRouter.
set -eu
cd "$(dirname "$0")/.."
QSSM_DIR="${QSSM_DIR:-../QSS-M}"
git -C "$QSSM_DIR" pull --ff-only --quiet
export KNOWLEDGE_SOURCE_QSSM="${KNOWLEDGE_SOURCE_QSSM:-$QSSM_DIR}"
npm run --silent refresh
