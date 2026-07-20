# omniroute-pi-adapter-ext

OmniRoute adapter for Pi 0.80.10+ and OMP 17.0.5+.

## Supported

- Loads `/v1/models` before startup model resolution. Combos can be the default without hardcoding models in `models.json` or `models.yml`.
- Uses each model's `capabilities.effort_tiers` when OmniRoute supplies it.
- Otherwise exposes `low`, `medium`, `high`, and `xhigh`; override with `OMNIROUTE_REASONING_EFFORTS`.
- Preserves `max` when OmniRoute advertises it or you configure it. It is never rewritten to `xhigh`.
- Shows `combo/coding → gpt-5.6-sol` in the status line:
  - OMP reads OmniRoute's streaming route trailer directly.
  - Pi can query call logs when `OMNIROUTE_MANAGEMENT_TOKEN` is set.
- Fails startup rather than registering an empty provider when discovery fails.

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

Choose a discovered combo normally:

```bash
pi -e ./src/pi-entry.ts --model omniroute/combo/coding
omp -e ./src/index.ts --model omniroute/combo/coding
```

For persistent configuration, set the default to `omniroute/combo/coding` in the host's normal model settings. Do not add a hardcoded OmniRoute model list.

## Optional settings

```bash
# Fallback efforts when a catalog entry has no effort_tiers:
export OMNIROUTE_REASONING_EFFORTS='low,medium,high,xhigh,max'
export OMNIROUTE_STARTUP_TIMEOUT_MS='15000'
export OMNIROUTE_PROVIDER_NAME='omniroute'

# Pi only: enables resolved-combo status through management call logs:
export OMNIROUTE_MANAGEMENT_TOKEN='...'
```

## Development

```bash
bun install
bun test
bun run check
```
