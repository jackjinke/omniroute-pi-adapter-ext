# omniroute-pi-adapter-ext

OmniRoute adapter for Pi 0.80.10+ and OMP 17.0.5+.

## Supported

- Loads every `/v1/models` entry before startup model resolution without classifying entries by owner or ID convention.
- Uses each entry's `capabilities.effort_tiers` when OmniRoute supplies it.
- Otherwise exposes `low`, `medium`, `high`, `xhigh`, and `max`; override per entry in `omniroute.yml`.
- OMP shows the requested and routed model IDs only when they differ, in both API formats.
- With OMP's `responses` format, enables V2 remote compaction after a combo resolves to a cataloged Codex route, pins compaction to that exact direct route, and disables it again after an unsupported reroute or session switch so OMP's configured fallback handles compaction.
- Drops OmniRoute's synthetic slow-start keepalive frames so they never surface as thinking text or as a routed model named `omniroute`. The keepalive still does its job: the early HTTP commit that keeps the connection alive is untouched.
- Logs a warning and lets the host continue when startup discovery fails.

Shared OmniRoute logic lives in `src/shared.ts`. Host-specific behavior lives in `src/pi.ts` and `src/omp.ts`.

## Install

### Pi

```bash
pi install git:github.com/jackjinke/omniroute-pi-adapter-ext
```

### OMP

```bash
omp install git:github.com/jackjinke/omniroute-pi-adapter-ext
```

Restart Pi or OMP after installation. The package manifest selects the correct host adapter automatically.

For local development instead:

```bash
pi -e /absolute/path/to/omniroute-pi-adapter-ext/src/pi-entry.ts
omp -e /absolute/path/to/omniroute-pi-adapter-ext/src/index.ts
```

## Use

```bash
export OMNIROUTE_API_KEY='...'
# Only needed when OmniRoute is not local:
export OMNIROUTE_BASE_URL='http://your-omniroute-host:20128'
```

Choose any entry returned by your OmniRoute instance:

```bash
pi --model omniroute/<model-id>
omp --model omniroute/<model-id>
```

For persistent configuration, set the discovered `omniroute/<model-id>` in the host's normal model settings. Do not add a hardcoded OmniRoute model list.

## Optional settings

Environment settings can be exported in your shell or placed in the host agent directory's `.env` file: `~/.pi/agent/.env` for Pi and `~/.omp/agent/.env` for OMP (or the corresponding custom/profile agent directory).

```bash
OMNIROUTE_STARTUP_TIMEOUT_MS='15000'
```

API format and reasoning-effort overrides live in `omniroute.yml` in that same agent directory—not in environment variables:

```yaml
format: responses # chat_completions (default) or responses
<model-id>: [low, medium, high, max]
"*": [low, medium, high, xhigh]
```

`responses` uses OpenAI's native Responses API at `/v1/responses` in both Pi and OMP. Omitting `format` keeps Chat Completions behavior.

Dynamic combo remote compaction requires `format: responses`. Until a Codex route is observed—and whenever routing changes to a non-Codex model—the combo advertises no remote compaction capability, leaving OMP's normal compaction model and strategy unchanged.

The exact effort entry takes precedence over `*`, then OmniRoute's `effort_tiers`, then the built-in `low,medium,high,xhigh,max` default.

## Development

```bash
bun install
bun test
bun run check
```
