# QSS-M Guide

Live at **https://qssm.quakeone.com/wiki/**

A FAQ and console reference for the [QSS-M](https://github.com/timbergeron/QSS-M) Quake engine. The main wiki is maintained and rebuilt in this local Codex workspace. **OpenRouter/DeepSeek is used only for visitor search/Ask answers.**

- **Search** across console variables, commands, launch options, and FAQ content, with instant local results.
- **Ask** streams a source-grounded answer through OpenRouter/DeepSeek.
- **FAQ** answers are maintained here in `site/data/faq.json`, using QSS-M source evidence.
- **Console reference** lists variables, commands, and launch options extracted from source, with community descriptions and links to their definitions.

## Rebuild locally

Requires Node.js 22.13 or newer and a QSS-M checkout beside this repo at `../QSS-M`. Set `QSSM_DIR` and `KNOWLEDGE_SOURCE_QSSM` to use another checkout.

```bash
cp .env.example .env
npm run refresh             # index + extract; no LLM API calls
npm start                   # http://localhost:3012
```

`npm run refresh` rebuilds the source search index and `site/data/reference.json`. It preserves FAQ answers. Update FAQ answers, citations, and other wiki content here as part of a rebuild, then commit the prepared site files. `faq/questions.json` contains the question list and retrieval hints; adding a question does not automatically write an answer.

The source code decides what exists and its default value. The [commands sheet](https://docs.google.com/spreadsheets/d/1ubOuromaXpZonfL-eJ-KA7q-xSRiBBuSvxahzF-uFOY) supplies descriptions; source wins when they disagree.

Extraction reads the cited Git commit, including multiline declarations, macro defaults, and variable arrays. Platform-specific defaults are shown separately for Windows, Linux, and macOS; values set at startup are identified instead of guessed. To correct the reference without advancing a reviewed revision or refreshing community prose, run `QSSM_REF=<commit> REFERENCE_NOTES_FILE=site/data/reference.json npm run extract`. If the sheet is unavailable, extraction retains the prepared reference notes.

Source-checked corrections to reference prose live in `reference/overrides.json`. They override the sheet's summary and description during extraction, while names, defaults, and flags still come from the code. Record the reviewed commit and supporting source lines with each correction so it can be checked on the next content review.

The search engine in `src/knowledge/` comes from [Nullius](https://github.com/timbergeron/Nullius): C chunking by function, symbol extraction, SQLite FTS5 search, and ranking weighted by source authority.

```bash
npm run knowledge -- query qssm "what does r_skywind do?"
npm run knowledge -- test qssm
```

Set `OPENROUTER_API_KEY` only to enable live Ask. Without a key, the published FAQ, reference, and local search still work, and the Ask button becomes Search.

## Publish

`.github/workflows/refresh.yml` publishes the committed `site/` directory to GitHub Pages on a push to `main` or manual dispatch. It does not regenerate content, check out the engine, or use an OpenRouter secret.

Live Ask needs a server to hold the API key and a source search index. `deploy/` includes a systemd service on port 3012 and nginx configuration. Prepare and deploy the search index and matching reference data when updating the Ask server; configure its knowledge source paths for that host.

The production endpoint is `https://timbergeron.com/qssm-wiki`, hosted on the existing server at `woods@timbergeron.com`. Its environment file is `/home/woods/codedev/qssm-wiki/.env` (mode 600). It uses `deepseek/deepseek-v4.1-flash`, allows browser requests from `https://qssm.quakeone.com`, and listens on loopback behind nginx. Never put its API key in `site/` or Git.

Upload prepared files and the local index from this workspace:

```bash
ssh woods@timbergeron.com 'mkdir -p /home/woods/codedev/qssm-wiki/data/knowledge'
rsync -az src site deploy scripts test knowledge-packs reference faq package.json README.md AGENTS.md woods@timbergeron.com:/home/woods/codedev/qssm-wiki/
rsync -az data/knowledge/qssm.sqlite woods@timbergeron.com:/home/woods/codedev/qssm-wiki/data/knowledge/
ssh -t woods@timbergeron.com 'sudo bash /home/woods/codedev/qssm-wiki/deploy/install.sh'
```

The installer requires the server environment file to be configured first. It backs up and validates nginx configuration, installs/restarts the service, and disables an old wiki refresh timer if present. It does not rebuild content. For a later code/data update, upload the files and restart only this service:

```bash
ssh -t woods@timbergeron.com 'sudo systemctl restart qssm-wiki'
```

The repository no longer ships that timer. `deploy/refresh.sh` remains a manual local helper to pull QSS-M and rebuild the index/reference.

To use Pages as the front door and the server for Ask, set `askEndpoint` in `site/config.js` to the server URL and `ALLOWED_ORIGIN` to the Pages origin. Live Ask has a per-IP rate limit (`ASK_PER_IP_PER_10_MIN`, default 8) and a daily spend ceiling (`ASK_DAILY_BUDGET_USD`, default $1).

Ask stores spending in `data/ask-spend.sqlite` (`ASK_SPEND_PATH` can change the path). Keep that file across deployments and restarts; do not publish or overwrite it. Requests reserve a conservative amount before starting, atomically across processes, and refund unused budget when the provider reports actual cost. Interrupted requests with unknown cost retain their reservation. The daily window rolls over at midnight UTC; setting the daily budget to `0` disables paid requests. Provider routing enforces `ASK_MAX_PROMPT_PRICE_PER_MILLION` and `ASK_MAX_COMPLETION_PRICE_PER_MILLION` (defaults $1 and $2 per million tokens) and excludes per-request fees. These ceilings also determine each reservation; configure them when choosing a more expensive model.

The running server reloads evidence when the FAQ, reference, source index, or knowledge manifest changes. Streamed answers are accepted only after successful completion; interrupted or token-limited responses show a retry message.

`npm run check` checks every JavaScript file individually. `npm test` covers extraction, local search ranking, budget persistence/concurrency, evidence reloads, mocked answer streams, cross-origin API behavior, and source retrieval without making any OpenRouter requests. Verify the production `/api/status` endpoint before publishing a changed `askEndpoint`.

## Layout

```
faq/questions.json         FAQ questions and retrieval hints
reference/overrides.json   locally reviewed reference descriptions
knowledge-packs/qssm/      index manifest and retrieval evaluations
scripts/extract.js         source → reference.json
scripts/knowledge.js       index build/query/test CLI
src/evidence.js            live search retrieval + answer prompt
src/server.js              static site + streaming /api/ask
site/data/faq.json         FAQ answers maintained in this workspace
site/                     the guide (plain HTML/CSS/JS, no build step)
deploy/                   systemd, nginx, manual refresh helper
```
