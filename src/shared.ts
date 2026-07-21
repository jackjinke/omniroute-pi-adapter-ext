import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";

export const DEFAULT_BASE_URL = "http://127.0.0.1:20128";
export const DEFAULT_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

export interface OmniRouteModel {
  id: string;
  name: string;
  reasoning: boolean;
  thinking?: { mode: "effort"; efforts: string[]; effortMap: Record<string, string> };
  thinkingLevelMap?: Record<string, string | null>;
  input: ("text" | "image")[];
  supportsTools?: boolean;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
  compat: {
    supportsReasoningParams: boolean;
    supportsReasoningEffort: boolean;
    /** Maps OmniRoute `structured_output` onto the host's strict-tools/grammar surface. */
    supportsStrictMode: boolean;
  };
}

export interface OmniRouteCatalog {
  models: OmniRouteModel[];
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

function readEffortOverrides(path: string): Record<string, string[]> {
  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return {};
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = parse(source);
  } catch (error) {
    throw new Error(`Invalid OmniRoute config at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (parsed == null) return {};
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`OmniRoute config at ${path} must be a YAML object keyed by model ID`);
  }
  return Object.fromEntries(
    Object.entries(parsed).map(([modelId, efforts]) => [modelId, parseEfforts(efforts, `${path}[${modelId}]`)]),
  );
}

export function omniRouteConfigPath(
  host: "pi" | "omp",
  environment: Record<string, string | undefined> = process.env,
): string {
  const agentDir = environment.PI_CODING_AGENT_DIR?.trim()
    || join(environment.HOME?.trim() || homedir(), host === "omp" ? ".omp" : ".pi", "agent");
  return join(agentDir, "omniroute.yml");
}

export function readConfig(
  environment: Record<string, string | undefined> = process.env,
  effortConfigPath?: string,
): OmniRouteConfig {
  const apiKey = environment.OMNIROUTE_API_KEY?.trim();
  if (!apiKey) throw new Error("Missing OmniRoute API key in OMNIROUTE_API_KEY");

  const effortOverrides = effortConfigPath ? readEffortOverrides(effortConfigPath) : {};
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


function readCatalogEfforts(capabilities: object): string[] | undefined {
  if (!("effort_tiers" in capabilities) || !Array.isArray(capabilities.effort_tiers)) return undefined;
  const supported: Record<string, true> = { minimal: true, low: true, medium: true, high: true, xhigh: true, max: true };
  const efforts = capabilities.effort_tiers
    .filter((effort): effort is string => typeof effort === "string")
    .map(effort => effort.trim().toLowerCase())
    .filter(effort => supported[effort] === true);
  return efforts.length > 0 ? [...new Set(efforts)] : undefined;
}

// The host Model type models only "text" | "image" input; richer OmniRoute
// modalities (audio, video, pdf) have no host representation and are dropped.
function readInputModalities(entry: object, capabilities: object): ("text" | "image")[] {
  const raw = "input_modalities" in entry && Array.isArray(entry.input_modalities)
    ? entry.input_modalities
    : undefined;
  const fromArray = raw?.some(m => typeof m === "string" && m.trim().toLowerCase() === "image") === true;
  const fromCaps = ("vision" in capabilities && capabilities.vision === true)
    || ("image_input" in capabilities && capabilities.image_input === true);
  return fromArray || fromCaps ? ["text", "image"] : ["text"];
}

function readStructuredOutput(capabilities: object): boolean {
  return ("structured_output" in capabilities && capabilities.structured_output === true)
    || ("structured_outputs" in capabilities && capabilities.structured_outputs === true)
    || ("json_mode" in capabilities && capabilities.json_mode === true)
    || ("json_schema" in capabilities && capabilities.json_schema === true);
}

export function normalizeCatalog(
  payload: unknown,
  config: Pick<OmniRouteConfig, "effortOverrides">,
): OmniRouteCatalog {
  if (!payload || typeof payload !== "object") throw new Error("OmniRoute /v1/models returned a non-object response");
  if (!("data" in payload) || !Array.isArray(payload.data)) {
    throw new Error("OmniRoute /v1/models response is missing data[]");
  }

  const models: OmniRouteModel[] = [];
  for (const entry of payload.data) {
    if (!entry || typeof entry !== "object") continue;
    if (!("id" in entry) || typeof entry.id !== "string" || !entry.id.trim()) continue;
    const id = entry.id.trim();
    const capabilities = "capabilities" in entry && entry.capabilities && typeof entry.capabilities === "object"
      ? entry.capabilities
      : {};
    const reasoning = !("reasoning" in capabilities && capabilities.reasoning === false)
      && !("thinking" in capabilities && capabilities.thinking === false);
    const structuredOutput = readStructuredOutput(capabilities);

    const model: OmniRouteModel = {
      id,
      name: id,
      reasoning,
      input: readInputModalities(entry, capabilities),
      supportsTools: !("tool_calling" in capabilities) || capabilities.tool_calling !== false,
      // OmniRoute's /v1/models exposes no pricing data; cost is intentionally zeroed.
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: positiveNumber(
        "context_length" in entry ? entry.context_length : "max_input_tokens" in entry ? entry.max_input_tokens : undefined,
        128_000,
      ),
      maxTokens: positiveNumber("max_output_tokens" in entry ? entry.max_output_tokens : undefined, 16_384),
      compat: {
        supportsReasoningParams: reasoning,
        supportsReasoningEffort: reasoning,
        supportsStrictMode: structuredOutput,
      },
    };

    if (reasoning) {
      const efforts = config.effortOverrides[id]
        ?? config.effortOverrides["*"]
        ?? readCatalogEfforts(capabilities)
        ?? [...DEFAULT_EFFORTS];
      const effortMap = Object.fromEntries(efforts.map(effort => [effort, effort]));
      model.thinking = { mode: "effort", efforts, effortMap };
      model.thinkingLevelMap = effortMap;
    }
    models.push(model);
  }

  if (models.length === 0) throw new Error("OmniRoute /v1/models returned no usable models");
  return { models };
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
  effortConfigPath?: string,
): Promise<{ config: OmniRouteConfig; catalog: OmniRouteCatalog } | undefined> {
  try {
    const config = readConfig(environment, effortConfigPath);
    return { config, catalog: await discoverModels(config, fetcher) };
  } catch {
    return undefined;
  }
}

export function resolvedRouteStatus(requestedModel: string, routedModel: string): string {
  return requestedModel === routedModel ? requestedModel : `${requestedModel} → ${routedModel}`;

}

export function extractOmniRouteModel(rawLines: readonly string[]): string | undefined {
  for (const line of rawLines) {
    const trailer = /^:\s*x-omniroute-model=(.+)$/i.exec(line.trim());
    if (trailer?.[1]) return trailer[1].trim();
    if (!line.startsWith("data:")) continue;
    try {
      const payload = JSON.parse(line.slice(5).trim());
      if (payload && typeof payload === "object" && typeof payload.model === "string") return payload.model.trim();
    } catch {}
  }
  return undefined;
}
