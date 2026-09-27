# QSS-M Guide

A living FAQ and console reference for the [QSS-M](https://github.com/timbergeron/QSS-M) Quake engine. Every page is rebuilt from the engine's current source, so the guide stays in sync with QSS-M automatically.

- **Search** across every console variable, command, and launch option, with instant results.
- **FAQ** of about 30 player questions, answered by DeepSeek V4.1 Flash via OpenRouter. Answers are grounded in the source and cite the lines they came from.
- **Ask**: a live answer box that streams an answer built from the same evidence the FAQ uses.
- **Console reference**: 536 variables and 324 commands, with defaults taken from the code, descriptions from the community commands sheet, and a link to the defining line.

## How it stays current

```
QSS-M commit
  → npm run index      full-text index over source, docs, cvar sheet, and git history
  → npm run extract    site/data/reference.json: every cvar/command/launch option in the code
  → npm run generate   site/data/faq.json: answers regenerated only when their evidence changed
```

The source code decides what exists and its default value. The [commands sheet](https://docs.google.com/spreadsheets/d/1ubOuromaXpZonfL-eJ-KA7q-xSRiBBuSvxahzF-uFOY) supplies only the descriptions. When the sheet and the code disagree (for example, the sheet says `crosshair` defaults to 1 but the code says 0), the code wins.

Every generated answer records a fingerprint of its question, prompt, model, and evidence. A refresh regenerates an answer only when that fingerprint changes, so most refreshes cost nothing. After each answer is written, the script checks every backticked name in it against the extracted reference. If the model made one up, the script asks it once to rewrite without the invented name. Anything still unknown after that is recorded as `unverified`.

The search engine in `src/knowledge/` comes from [Nullius](https://github.com/timbergeron/Nullius): C chunking by function, symbol extraction, SQLite FTS5 search, and ranking weighted by source authority.

## Run it locally

Requires Node.js 22.13 or newer (for `node:sqlite`) and a QSS-M checkout beside this repo at `../QSS-M`. You can put it elsewhere by setting `QSSM_DIR`.

```bash
cp .env.example .env        # add OPENROUTER_API_KEY
npm run refresh             # index + extract + generate
npm start                   # http://localhost:3012
```

Without an API key the site still works. Search and the console reference are fully functional, the FAQ shows a short note that answers aren't generated yet, and the Ask button becomes Search.

Useful flags:

```bash
npm run generate -- --only=crosshair,fov   # regenerate specific answers
npm run generate -- --force                # regenerate everything
npm run knowledge -- query qssm "what does r_skywind do?"
npm run knowledge -- test qssm             # retrieval regression suite
```

Questions live in [`faq/questions.json`](faq/questions.json). To add a question, add an entry with a few `hints` (cvar or command names you expect the answer to need), then run `npm run generate`.

## Deploy

### GitHub Pages (FAQ, reference, search)

`.github/workflows/refresh.yml` runs every three hours, on manual dispatch, and on a `qssm-updated` repository dispatch. Each run checks out QSS-M, refreshes the data, commits whatever changed, and publishes `site/` to Pages.

One-time setup:

```bash
gh secret set OPENROUTER_API_KEY --repo timbergeron/qssm-wiki
```

To refresh the moment QSS-M changes, add this step to a QSS-M workflow that runs on push. It needs a token with `repo` scope on qssm-wiki, stored as `QSSM_WIKI_TOKEN`:

```yaml
- run: gh api repos/timbergeron/qssm-wiki/dispatches -f event_type=qssm-updated
  env:
    GH_TOKEN: ${{ secrets.QSSM_WIKI_TOKEN }}
```

### VPS (adds live Ask)

Live answers need a server to hold the API key. `deploy/` mirrors the Nullius setup: a systemd service on port 3012, an nginx location at `/qssm-wiki/`, and a timer that pulls QSS-M and refreshes every 30 minutes. The server reloads the new data on its next request, with no restart needed.

```bash
sudo cp deploy/qssm-wiki.service deploy/qssm-wiki-refresh.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now qssm-wiki qssm-wiki-refresh.timer
```

To keep Pages as the front door and use the VPS only for Ask, set `askEndpoint` in [`site/config.js`](site/config.js) to the server's URL, and set `ALLOWED_ORIGIN` on the server to the Pages origin.

Live Ask has two spending guards: a per-IP rate limit (`ASK_PER_IP_PER_10_MIN`, default 8) and a daily spend ceiling (`ASK_DAILY_BUDGET_USD`, default $1) based on the cost OpenRouter reports for each answer. FAQ generation stops at `GENERATE_BUDGET_USD` per run.

## Layout

```
faq/questions.json         the questions the FAQ answers
knowledge-packs/qssm/      index manifest and retrieval evaluations (from Nullius)
scripts/extract.js         source → reference.json
scripts/generate.js        evidence + DeepSeek → faq.json
scripts/knowledge.js       index build/query/test CLI
src/evidence.js            shared retrieval + answer prompt
src/server.js              static site + streaming /api/ask
site/                      the guide (plain HTML/CSS/JS, no build step)
deploy/                    systemd, nginx, refresh script
```
