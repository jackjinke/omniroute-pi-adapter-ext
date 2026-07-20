# omniroute-pi-adapter-ext

OmniRoute adapter for Pi 0.80.10+ and OMP 17.0.5+.

## Supported

- Loads `/v1/models` before startup model resolution. Combos can be the default without hardcoding models in `models.json` or `models.yml`.
- Uses each model's `capabilities.effort_tiers` when OmniRoute supplies it.
- Otherwise exposes `low`, `medium`, `high`, `xhigh`, and `max`; override per model or combo in `omniroute.yml`.
- OMP shows the requested combo and concrete routed model in its extension status line.
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

Choose any combo returned by your OmniRoute instance:

```bash
pi --model omniroute/<your-combo-id>
omp --model omniroute/<your-combo-id>
```

For persistent configuration, set your discovered `omniroute/<your-combo-id>` in the host's normal model settings. Do not add a hardcoded OmniRoute model list.

## Optional settings

Environment settings can be exported in your shell or placed in the host agent directory's `.env` file: `~/.pi/agent/.env` for Pi and `~/.omp/agent/.env` for OMP (or the corresponding custom/profile agent directory).

```bash
OMNIROUTE_STARTUP_TIMEOUT_MS='15000'
```

Reasoning-effort overrides live in `omniroute.yml` in that same agent directory—not in an environment variable:

```yaml
<model-or-combo-id>: [low, medium, high, max]
"*": [low, medium, high, xhigh]
```

The exact model/combo entry takes precedence over `*`, then OmniRoute's `effort_tiers`, then the built-in `low,medium,high,xhigh,max` default.

## Development

```bash
bun install
bun test
bun run check
```
