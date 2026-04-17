# TradingView MCP — Integracja z NanoClaw

Submoduł `projects/tradingview-mcp/` — serwer MCP sterujący TradingView Desktop przez Chrome DevTools Protocol (CDP).

Używany przez instancję **mac-trading** (`~/nanoclaw-trading/`).

---

## Architektura

```
Telegram → mac-trading (Node.js) → Docker container (agent)
                                           ↓ stdio
                                   /workspace/tradingview-mcp/src/server.js
                                           ↓ CDP_HOST=host.docker.internal:9222
                                   TradingView Desktop
```

Agent w kontenerze dostaje serwer MCP przez stdio — bezpośrednio, bez supergateway.

---

## Konfiguracja

| Zmienna | Wartość |
|---------|---------|
| `TRADINGVIEW_MCP_PATH` | ścieżka do submodułu (w `.env` mac-trading) |
| `CDP_HOST` | `host.docker.internal` (wewnątrz kontenera → host Mac) |
| `CDP_PORT` | `9222` (domyślny) |

TradingView Desktop musi być uruchomiony z CDP:
```bash
open -a "TradingView" --args --remote-debugging-port=9222
```

---

## Znane problemy i fixy (historia)

| Data | Problem | Status |
|------|---------|--------|
| 2026-04-15 | `draw_list`/`draw_get_properties`/`draw_remove_one`/`draw_clear` — "getChartApi is not defined" | ✅ Naprawione — bug importu z aliasem w `src/core/drawing.js` |
| 2026-04-16 | `draw_shape` rectangle — niewidoczny, `entity_id: null` | ✅ Naprawione — użyto `_createMultipointShape` + `setPoints` przez `evaluateAsync` |
| 2026-04-16 | `draw_clear` — `removeAllShapes()` niszczyło stan API | ✅ Naprawione — używa teraz `removeAllDrawingTools()` |
| 2026-04-16 | `ui_evaluate` nie awaits Promises | ✅ Naprawione — dodano parametr `await_promise: boolean` |
| 2026-04-16 | Kolory `#RRGGBBAA` odrzucane przez TV | ✅ Naprawione — auto-konwersja do `rgba()` w `drawShape` |

Pełne szczegóły + workaroundy: `projects/tradingview-mcp/CLAUDE_NOTES.md`.

---

## Aktualizacja submodułu

```bash
cd ~/Projects/nanoclaw/projects/tradingview-mcp
git pull origin main
cd ~/Projects/nanoclaw
git add projects/tradingview-mcp
git commit -m "chore: update tradingview-mcp submodule"
```

Po zmianie `src/` w submodule — skopiuj do instancji produkcyjnej:
```bash
rsync -av ~/Projects/nanoclaw/projects/tradingview-mcp/src/ ~/nanoclaw-trading/projects/tradingview-mcp/src/
```
