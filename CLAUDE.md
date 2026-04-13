# NanoClaw — Personalny Asystent AI

Fork: `https://github.com/mludoml/nanoclaw` | Upstream: `https://github.com/qwibitai/nanoclaw`

## Architektura

Pojedynczy proces Node.js odbierający wiadomości z kanałów (Telegram), który dla każdej grupy tworzy izolowany kontener Docker z agentem Claude Code SDK. Każdy kontener ma własny filesystem (`groups/<name>/`) i pamięć.

```
Telegram → NanoClaw (Node.js) → Docker container (claude-code agent)
                ↑                         ↓
         PostgreSQL (shared)      IPC files (data/ipc/)
```

## Kluczowe pliki

| Plik | Rola |
|------|------|
| `src/index.ts` | Orchestrator: pętla wiadomości, state, router |
| `src/channels/telegram.ts` | Telegram (grammy): odbieranie i wysyłanie |
| `src/channels/registry.ts` | Self-registration kanałów przy starcie |
| `src/container-runner.ts` | Spawning kontenera agenta z volume mountami |
| `src/config.ts` | Konfiguracja: ścieżki, timeouty, trigger |
| `src/group-queue.ts` | Kolejka per-group, limit MAX_CONCURRENT_CONTAINERS |
| `src/ipc.ts` | IPC watcher — polling pliku sentinel do odczytu odpowiedzi |
| `src/db.ts` | PostgreSQL (async): messages, groups, nodes |
| `src/task-scheduler.ts` | Zaplanowane zadania |
| `src/router.ts` | Formatowanie i routing outbound |
| `groups/{name}/CLAUDE.md` | Pamięć per-instancja (nie syncowana — .stignore) |
| `container/skills/` | Skille ładowane w kontenerze agenta |

## 4 instancje produkcyjne

| Instancja | NODE_ID | Bot | Lokalizacja | Uruchomienie |
|-----------|---------|-----|-------------|--------------|
| Mac main | `mac` | @oml_mac_bot (8521788264) | `~/nanoclaw/` | launchd `com.nanoclaw` |
| Mac trading | `mac-trading` | @oml_trading_mac_bot (8658531638) | `~/nanoclaw-trading/` | launchd `com.nanoclaw-trading` |
| Synology main | `synology` | @oml_nas_bot (8294348772) | `/volume1/docker/nanoclaw/` | Docker Compose |
| Synology trading | `synology-trading` | @oml_trading_nas_bot (8425703524) | `/volume1/docker/nanoclaw-trading/` | Docker Compose |

Wszystkie instancje obsługują chat `tg:5793614048` (Telegram user ID właściciela).

## Kluczowe customizacje vs upstream

### 1. SQLite → PostgreSQL

Baza PostgreSQL na Synology (Docker), port **5433**, shared między wszystkimi instancjami.
- Container: `nanoclaw-postgres`
- Credentials: `nanoclaw` / `nanoclaw` / `nanoclaw_secret`
- Tabela `messages` ma kolumnę `node_id` — izoluje wiadomości per instancja
- Tabela `registered_groups` jest współdzielona globalnie

### 2. Native credential proxy (zamiast OneCLI)

`CLAUDE_CODE_OAUTH_TOKEN` w `.env` każdej instancji — bez żadnego zewnętrznego narzędzia.
Każdy kontener agenta dostaje token przez credential proxy HTTP na hoście.
- Mac main: port **3001**
- Mac trading: port **3002**
- Synology main: port **3001**
- Synology trading: port **3002**

### 3. Docker-in-Docker path duality (Synology)

Na Synology NanoClaw działa w Dockerze (`process.cwd() = /app`), ale spawnnuje dziecięce kontenery przez host dockerd. Volume mounty muszą być ścieżkami **hosta**, nie kontenera.

Rozwiązanie w `src/config.ts`:
```ts
const PROCESS_ROOT = process.cwd();   // /app wewnątrz kontenera
export const PROJECT_ROOT =
  process.env.HOST_PROJECT_ROOT || process.cwd();  // /volume1/docker/nanoclaw
export const DATA_DIR = path.resolve(PROCESS_ROOT, 'data');  // I/O: /app/data
```

`HOST_PROJECT_ROOT` ustawiony w `.env` każdej instancji Synology.
`container-runner.ts` używa `toHost()` helpera do translacji ścieżek dla `-v` argumentów Docker.

### 4. Telegram message ID collision fix

Telegram numeruje wiadomości od 1 per chat. Przy wielu botach nasłuchujących tego samego chatu (`tg:5793614048`) identyfikatory kolidowały w bazie.

Fix: `src/channels/telegram.ts` prefiksuje ID botowym Telegram ID:
```ts
const botId = ctx.me?.id?.toString() || '';
const msgId = botId ? `${botId}_${ctx.message.message_id}` : ...;
```

### 5. Prefix kontenerów agentów

Kontenery agentów: `nanoclaw-agent-*` (nie `nanoclaw-*`), żeby nie zabijać `nanoclaw-postgres` przy cleanup.

### 6. iCloud mount per instancja (ICLOUD_PATH)

Każda instancja może mieć zamontowany katalog iCloud/Obsidian do kontenera agenta pod `/workspace/icloud`.
Ustawiany przez `ICLOUD_PATH` w `.env` — jeśli ścieżka istnieje, jest automatycznie mountowana (read-write).

| Instancja | ICLOUD_PATH | Zawartość |
|-----------|-------------|-----------|
| Mac main | `/Users/m.lud/Library/Mobile Documents` | pełne Mobile Documents (iCloud Drive + vault) |
| Mac trading | `/Users/m.lud/Library/Mobile Documents/iCloud~md~obsidian/Documents/main` | tylko vault Obsidian |
| NAS main | `/volume2/sync/obsidian` | vault Obsidian (Syncthing copy) |
| NAS trading | `/volume2/sync/obsidian` | vault Obsidian (Syncthing copy) |

**Uwaga Mac:** wymaga OrbStack z Full Disk Access. Colima nie ma stabilnego FDA dla sandboxowanych ścieżek iCloud.

**Uwaga NAS:** ścieżka `/volume2/sync` musi być zamontowana w docker-compose nanoclaw (żeby `fs.existsSync` działało wewnątrz kontenera).

Docelowo NAS main powinien dostać `/volume2/sync/icloud` (Syncthing copy pełnego iCloud Drive) gdy sync się zakończy.

## Synchronizacja grup (Syncthing)

Foldery `groups/` synchronizowane między Mac ↔ Synology przez Tailscale:
- `nanoclaw-main-groups`: `~/nanoclaw/groups/` ↔ `/volume1/docker/nanoclaw/groups/`
- `nanoclaw-trading-groups`: `~/nanoclaw-trading/groups/` ↔ `/volume1/docker/nanoclaw-trading/groups/`

`.stignore`:
```
!/global/CLAUDE.md
**/CLAUDE.md
```
- `global/CLAUDE.md` — **synchronizowany** (wspólna wiedza main↔main, trading↔trading)
- pozostałe `CLAUDE.md` — **nie synchronizowane** (pamięć per-instancja)

Dodatkowe foldery Syncthing:
- `obsidian`: `~/Library/Mobile Documents/iCloud~md~obsidian/Documents/main` → `/volume2/sync/obsidian` (Mac → NAS)
- `icloud`: `~/Library/Mobile Documents/com~apple~CloudDocs` → `/volume2/sync/icloud` (Mac → NAS, sync w toku)

API keys Syncthing:
- Mac: `cFYRuYNPzU9YmyPsmxjvgzUHHLqGAgen` (localhost:8384)
- Synology: `vrAExLFkvLW9u5LRfoLiLmcEVoWYX7Dn` (localhost:8384)

## Zarządzanie serwisami

### Mac (launchd)

**Runtime: OrbStack** (zastąpił Colimę — stabilne FDA dla iCloud/Mobile Documents)

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw          # restart main
launchctl kickstart -k gui/$(id -u)/com.nanoclaw-trading   # restart trading
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
```

Logi: `~/nanoclaw/logs/nanoclaw.log` / `~/nanoclaw-trading/logs/nanoclaw.log`

**Uwaga:** OrbStack musi działać (menu bar). Uruchamia się automatycznie przy starcie systemu.
Jeśli boty nie odpowiadają: sprawdź czy OrbStack działa, następnie `docker info`.

Po zmianie obrazu agenta (rebuild container/): `cd ~/nanoclaw && ./container/build.sh`

### Synology (Docker Compose)

```bash
ssh synology
cd /volume1/docker/nanoclaw
sudo /usr/local/bin/docker compose up -d                      # start
sudo /usr/local/bin/docker compose down                       # stop
sudo /usr/local/bin/docker compose logs -f                    # logi
sudo /usr/local/bin/docker compose up -d --force-recreate     # restart
```

## Development / update

### Mac

```bash
cd ~/nanoclaw
git pull
npm install && npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

Po zmianie kodu źródłowego należy skopiować do obu instancji produkcyjnych:
```bash
cp ~/Projects/nanoclaw/src/config.ts ~/nanoclaw/src/ ~/nanoclaw-trading/src/
cp ~/Projects/nanoclaw/src/container-runner.ts ~/nanoclaw/src/ ~/nanoclaw-trading/src/
cd ~/nanoclaw && npm run build && cd ~/nanoclaw-trading && npm run build
```

### Synology

```bash
ssh synology "cd /volume1/docker/nanoclaw && git pull"
ssh synology "sudo /usr/local/bin/docker run --rm -v /volume1/docker/nanoclaw:/app -w /app node:22 sh -c 'npm ci && npm run build'"
ssh synology "cd /volume1/docker/nanoclaw && sudo /usr/local/bin/docker compose up -d --force-recreate"
```

Rebuild agent image (jeśli zmiany w `container/`):
```bash
ssh synology "cd /volume1/docker/nanoclaw && sudo ./container/build.sh"
```

Container build cache: jeśli COPY steps są stale, prune builder: `docker buildx prune -f && ./container/build.sh`

Po zmianie kodu źródłowego na NAS (np. config.ts, container-runner.ts):
```bash
cat ~/Projects/nanoclaw/src/config.ts | ssh synology "cat > /volume1/docker/nanoclaw/src/config.ts && cat > /volume1/docker/nanoclaw-trading/src/config.ts"
```

## .env (Mac main)

```env
ASSISTANT_NAME=Andy
TELEGRAM_BOT_TOKEN=<token>
NODE_ID=mac
CREDENTIAL_PROXY_PORT=3001
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...
TZ=Europe/Warsaw
ICLOUD_PATH=/Users/m.lud/Library/Mobile Documents
```

## .env (Mac trading)

```env
ASSISTANT_NAME=Andy
TELEGRAM_BOT_TOKEN=<token>
NODE_ID=mac-trading
CREDENTIAL_PROXY_PORT=3002
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...
TZ=Europe/Warsaw
ICLOUD_PATH=/Users/m.lud/Library/Mobile Documents/iCloud~md~obsidian/Documents/main
```

## .env (Synology main)

```env
ASSISTANT_NAME=Andy
TELEGRAM_BOT_TOKEN=<token>
NODE_ID=synology
CREDENTIAL_PROXY_PORT=3001
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...
HOST_PROJECT_ROOT=/volume1/docker/nanoclaw
TZ=Europe/Warsaw
ICLOUD_PATH=/volume2/sync/obsidian
```

## .env (Synology trading)

```env
ASSISTANT_NAME=Andy
TELEGRAM_BOT_TOKEN=<token>
NODE_ID=synology-trading
CREDENTIAL_PROXY_PORT=3002
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...
HOST_PROJECT_ROOT=/volume1/docker/nanoclaw-trading
TZ=Europe/Warsaw
ICLOUD_PATH=/volume2/sync/obsidian
```

## Troubleshooting

**Boty nie odpowiadają:**
1. Sprawdź logi: `tail -f ~/nanoclaw/logs/nanoclaw.log` / `ssh synology "sudo /usr/local/bin/docker compose -f /volume1/docker/nanoclaw/docker-compose.yml logs -f"`
2. Synology ACL: `sudo chmod -R 777 /volume1/docker/nanoclaw/data /volume1/docker/nanoclaw/groups /volume1/docker/nanoclaw/store`
3. Mac: sprawdź czy OrbStack działa (`docker info`)

**Boty crashują z "No conversation found with session ID":**
Stare sesje po przebudowie obrazu. Wyczyść:
```bash
ssh synology "sudo /usr/local/bin/docker exec nanoclaw-postgres psql -U nanoclaw -d nanoclaw -c 'DELETE FROM sessions;'"
```
Następnie restart wszystkich instancji.

**iCloud nie widoczny w kontenerze (Mac):**
- Sprawdź czy OrbStack ma Full Disk Access (System Settings → Privacy & Security → Full Disk Access)
- Zweryfikuj: `docker run --rm -v "/Users/m.lud/Library/Mobile Documents:/test" alpine ls /test`

**iCloud nie widoczny w kontenerze (NAS):**
- Sprawdź czy `/volume2/sync` jest zamontowany w docker-compose (`volumes: - /volume2/sync:/volume2/sync`)
- Sprawdź czy ścieżka istnieje: `ls /volume2/sync/obsidian`

**Volume mount failed na Synology (`/app/groups/... does not exist`):**
Sprawdź `HOST_PROJECT_ROOT` w `.env` — musi wskazywać host path (`/volume1/docker/nanoclaw`).

**Telegram: wiadomości nie triggerują agenta:**
- Sprawdź czy chat jest registered: `SELECT * FROM registered_groups`
- Trigger: `@Andy` (domyślnie) — lub `no_trigger: true` w grupie

## Development

```bash
npm run dev          # hot reload
npm run build        # kompilacja TypeScript
./container/build.sh # rebuild agent container image
```
