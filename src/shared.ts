export const DEFAULT_BASE_URL = "http://127.0.0.1:20128";
export const DEFAULT_EFFORTS = ["low", "medium", "high", "xhigh"] as const;

export interface OmniRouteModel {
  id: string;
  name: string;
  reasoning: boolean;
  thinking?: { mode: "effort"; efforts: string[] };
  thinkingLevelMap?: Record<string, string | null>;
  input: ("text" | "image")[];
  supportsTools?: boolean;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
  compat: {
    supportsReasoningEffort: boolean;
  };
}

export interface OmniRouteCatalog {
  models: OmniRouteModel[];
  comboIds: Set<string>;
}

export interface OmniRouteConfig {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  effortOverrides: Record<string, string[]>;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`OMNIROUTE_STARTUP_TIMEOUT_MS must be a positive integer, got ${value}`);
  }
  return parsed;
}

function parseEfforts(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array of reasoning efforts`);
  const supported: Record<string, true> = { minimal: true, low: true, medium: true, high: true, xhigh: true, max: true };
  const efforts = value
    .filter((effort): effort is string => typeof effort === "string")
    .map(effort => effort.trim().toLowerCase())
    .filter(Boolean);
  if (efforts.length === 0) throw new Error(`${label} must contain at least one reasoning effort`);
  for (const effort of efforts) {
    if (!supported[effort]) throw new Error(`Unsupported reasoning effort in ${label}: ${effort}`);
  }
  return [...new Set(efforts)];
}

function readEffortOverrides(raw: string | undefined): Record<string, string[]> {
  if (!raw?.trim()) return {};
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return { "*": parseEfforts(trimmed.split(","), "OMNIROUTE_REASONING_EFFORTS") };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(`OMNIROUTE_REASONING_EFFORTS must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("OMNIROUTE_REASONING_EFFORTS must be a JSON object keyed by model ID");
  }
  return Object.fromEntries(
    Object.entries(parsed).map(([modelId, efforts]) => [modelId, parseEfforts(efforts, `OMNIROUTE_REASONING_EFFORTS[${modelId}]`)]),
  );
}

export function readConfig(environment: Record<string, string | undefined> = process.env): OmniRouteConfig {
  const apiKey = environment.OMNIROUTE_API_KEY?.trim();
  if (!apiKey) throw new Error("Missing OmniRoute API key in OMNIROUTE_API_KEY");

  const effortOverrides = readEffortOverrides(environment.OMNIROUTE_REASONING_EFFORTS);
  return {
    baseUrl: (environment.OMNIROUTE_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, ""),
    apiKey,
    timeoutMs: positiveInteger(environment.OMNIROUTE_STARTUP_TIMEOUT_MS, 15_000),
    effortOverrides,
  };
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function displayName(id: string): string {
  return id
    .split("/")
    .map(part => part.replace(/[-_]+/g, " ").replace(/\b\w/g, letter => letter.toUpperCase()))
    .join(" / ");
}

function readCatalogEfforts(capabilities: object): string[] | undefined {
  if (!("effort_tiers" in capabilities) || !Array.isArray(capabilities.effort_tiers)) return undefined;
  const supported: Record<string, true> = { minimal: true, low: true, medium: true, high: true, xhigh: true, max: true };
  const efforts = capabilities.effort_tiers
    .filter((effort): effort is string => typeof effort === "string")
    .map(effort => effort.trim().toLowerCase())
    .filter(effort => supported[effort] === true);
  return efforts.length > 0 ? [...new Set(efforts)] : undefined;
}

export function normalizeCatalog(
  payload: unknown,
  config: Pick<OmniRouteConfig, "effortOverrides">,
): OmniRouteCatalog {
  if (!payload || typeof payload !== "object") throw new Error("OmniRoute /v1/models returned a non-object response");
  if (!("data" in payload) || !Array.isArray(payload.data)) {
    throw new Error("OmniRoute /v1/models response is missing data[]");
  }

  const comboIds = new Set<string>();
  const models: OmniRouteModel[] = [];
  for (const entry of payload.data) {
    if (!entry || typeof entry !== "object") continue;
    if (!("id" in entry) || typeof entry.id !== "string" || !entry.id.trim()) continue;
    const id = entry.id.trim();
    const capabilities = "capabilities" in entry && entry.capabilities && typeof entry.capabilities === "object"
      ? entry.capabilities
      : {};
    const reasoning = ("reasoning" in capabilities && capabilities.reasoning === true)
      || ("thinking" in capabilities && capabilities.thinking === true);
    if ("owned_by" in entry && entry.owned_by === "combo") comboIds.add(id);

    const model: OmniRouteModel = {
      id,
      name: displayName(id),
      reasoning,
      input: ("vision" in capabilities && capabilities.vision === true)
        || ("image_input" in capabilities && capabilities.image_input === true)
        ? ["text", "image"]
        : ["text"],
      supportsTools: !("tool_calling" in capabilities) || capabilities.tool_calling !== false,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: positiveNumber(
        "context_length" in entry ? entry.context_length : "max_input_tokens" in entry ? entry.max_input_tokens : undefined,
        128_000,
      ),
      maxTokens: positiveNumber("max_output_tokens" in entry ? entry.max_output_tokens : undefined, 16_384),
      compat: { supportsReasoningEffort: reasoning },
    };

    if (reasoning) {
      const efforts = config.effortOverrides[id]
        ?? config.effortOverrides["*"]
        ?? readCatalogEfforts(capabilities)
        ?? [...DEFAULT_EFFORTS];
      model.thinking = { mode: "effort", efforts };
      model.thinkingLevelMap = Object.fromEntries(efforts.map(effort => [effort, effort]));
    }
    models.push(model);
  }

  if (models.length === 0) throw new Error("OmniRoute /v1/models returned no usable models");
  return { models, comboIds };
}

export async function discoverModels(
  config: OmniRouteConfig,
  fetcher: (input: string | URL | Request, init?: RequestInit) => Promise<Response> = fetch,
): Promise<OmniRouteCatalog> {
  let response: Response;
  try {
    response = await fetcher(`${config.baseUrl}/v1/models`, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
      signal: AbortSignal.timeout(config.timeoutMs),
    });
  } catch (error) {
    throw new Error(`OmniRoute model discovery failed: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(`OmniRoute model discovery failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
  }
  return normalizeCatalog(await response.json(), config);
}

export async function tryDiscoverModels(
  environment: Record<string, string | undefined> = process.env,
  fetcher: (input: string | URL | Request, init?: RequestInit) => Promise<Response> = fetch,
): Promise<{ config: OmniRouteConfig; catalog: OmniRouteCatalog } | undefined> {
  try {
    const config = readConfig(environment);
    return { config, catalog: await discoverModels(config, fetcher) };
  } catch (error) {
    console.warn(`[omniroute] Startup model discovery skipped: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

export function extractOmniRouteModel(rawLines: readonly string[]): string | undefined {
  for (const line of rawLines) {
    const match = /^:\s*x-omniroute-model=(.+)$/i.exec(line.trim());
    if (match?.[1]) return match[1].trim();
  }
  return undefined;
}
