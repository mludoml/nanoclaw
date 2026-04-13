# Setup — stan instalacji

## Wszystko zrobione ✓

### 1. Syncthing — Mac ↔ Synology

4 foldery zsynchronizowane przez Tailscale:
- `nanoclaw-main-groups`: `~/nanoclaw/groups/` ↔ `/volume1/docker/nanoclaw/groups/`
- `nanoclaw-trading-groups`: `~/nanoclaw-trading/groups/` ↔ `/volume1/docker/nanoclaw-trading/groups/`
- `.stignore`: `**/CLAUDE.md` (pamięć per-instancja nie jest syncowana)
- Połączenie: Tailscale `tcp://100.97.165.6:22000` (direct 192.168.0.240)
- Synology Syncthing compose: `/volume2/docker/syncthing/docker-compose.yml`
- Syncthing ma mount `/volume1/docker:/volume1/docker`

Syncthing API keys:
- Mac: `cFYRuYNPzU9YmyPsmxjvgzUHHLqGAgen` (localhost:8384)
- Synology: `vrAExLFkvLW9u5LRfoLiLmcEVoWYX7Dn` (localhost:8384)

### 2. PostgreSQL na Synology (Docker)

- Container: `nanoclaw-postgres`, port: **5433**
- Credentials: db/user/pass = `nanoclaw` / `nanoclaw` / `nanoclaw_secret`
- restart policy: `unless-stopped`
- Tabela `messages` izoluje dane przez kolumnę `node_id`
- Tabela `registered_groups` jest współdzielona globalnie

### 3. Fork NanoClaw

Repo: `https://github.com/mludoml/nanoclaw`

Customizacje vs upstream:
- SQLite → PostgreSQL, async db, tabela `nodes`
- Telegram (grammy) zmergowany
- native-credential-proxy (zastąpił OneCLI) — `CLAUDE_CODE_OAUTH_TOKEN` w `.env`
- `CREDENTIAL_PROXY_PORT` czytany z `.env`
- Prefix kontenerów agentów = `nanoclaw-agent-` (nie `nanoclaw-` — żeby nie zabijać nanoclaw-postgres)
- `HOST_PROJECT_ROOT` w `.env` dla Docker-in-Docker na Synology
- Telegram message ID prefiksowany bot ID (fix kolizji przy wielu botach)

### 4. Mac main (`~/nanoclaw/`)

- Bot: `@oml_mac_bot` (Telegram ID: 8521788264)
- NODE_ID: `mac`, credential proxy port: **3001**
- Czat: `tg:5793614048` (telegram_main, isMain, no-trigger)
- Serwis: launchd `com.nanoclaw`
- Log: `~/Library/Logs/nanoclaw.log`

### 5. Mac Trading (`~/nanoclaw-trading/`)

- Bot: `@oml_trading_mac_bot` (Telegram ID: 8658531638)
- NODE_ID: `mac-trading`, credential proxy port: **3002**
- Czat: `tg:5793614048` (telegram_main, isMain, no-trigger)
- Serwis: launchd `com.nanoclaw-trading`
- Log: `~/Library/Logs/nanoclaw-trading.log`

### 6. Synology main (`/volume1/docker/nanoclaw/`)

- Bot: `@oml_nas_bot` (Telegram ID: 8294348772)
- NODE_ID: `synology`, credential proxy port: **3001**
- Docker image: `nanoclaw-main:latest` (node:22-slim + docker-ce-cli)
- docker-compose: `/volume1/docker/nanoclaw/docker-compose.yml`, `network_mode: host`
- Agent image: `nanoclaw-agent:latest`
- `.env` wymaga: `HOST_PROJECT_ROOT=/volume1/docker/nanoclaw`

### 7. Synology Trading (`/volume1/docker/nanoclaw-trading/`)

- Bot: `@oml_trading_nas_bot` (Telegram ID: 8425703524)
- NODE_ID: `synology-trading`, credential proxy port: **3002**
- Docker image: `nanoclaw-main:latest` (ten sam obraz co main)
- `.env` wymaga: `HOST_PROJECT_ROOT=/volume1/docker/nanoclaw-trading`

### 8. CLAUDE.md per instancja

| Instancja | Plik | Profil |
|-----------|------|--------|
| Mac main | `~/nanoclaw/groups/telegram_main/CLAUDE.md` | Andy, ogólny, node: mac |
| Mac trading | `~/nanoclaw-trading/groups/telegram_main/CLAUDE.md` | Andy, trading, node: mac-trading |
| Synology main | `/volume1/docker/nanoclaw/groups/telegram_main/CLAUDE.md` | Andy, ogólny, node: synology |
| Synology trading | `/volume1/docker/nanoclaw-trading/groups/telegram_main/CLAUDE.md` | Andy, trading, node: synology-trading |

`groups/main/CLAUDE.md` jest tracked w git (szablon); na Synology `assume-unchanged`.

## Lokalna kopia repo (development)

- `~/Projects/nanoclaw/` — klon forka, do PR i development
- Produkcja: `~/nanoclaw/` (Mac) i `/volume1/docker/nanoclaw` (Synology)
- Po zmianie kodu produkcyjnego: `git pull` + build + restart serwisu

## Dodatkowe uwagi

- Credential: `CLAUDE_CODE_OAUTH_TOKEN` w każdym `.env` (OAuth token z `claude setup-token`)
- Ollama Cloud: odkomentować `ANTHROPIC_BASE_URL=https://ollama.com` + `ANTHROPIC_AUTH_TOKEN` w `.env`
- Mac wymaga Colima: `colima start` przed startem NanoClaw
- Stale Colima fix: `rm -rf ~/.colima/_lima/colima ~/.colima/_store/colima.json ~/.colima/default/docker.sock && colima start`
- Synology ACL po restarcie: `sudo chmod -R 777 /volume1/docker/nanoclaw/data /volume1/docker/nanoclaw/groups /volume1/docker/nanoclaw/store`
