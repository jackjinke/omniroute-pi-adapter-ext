import {
  streamOpenAICompletions,
  streamOpenAIResponses,
  type OpenAICompletionsOptions,
} from "@oh-my-pi/pi-ai";
import {
  extractOmniRouteModel,
  omniRouteConfigPath,
  resolvedRouteStatus,
  stripKeepaliveFrames,
  tryDiscoverModels,
  type OmniRouteApiFormat,
  type OmniRouteDiscovery,
  type OmniRouteModel,
} from "./shared.ts";

type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface OmpExtensionAPI {
  registerProvider(name: string, config: OmpProviderConfig): void;
  getThinkingLevel(): ReasoningEffort | undefined;
  on(event: string, handler: (event: { payload?: unknown }, context: OmpContext) => unknown): void;
}


interface OmpRoutableModel {
  id: string;
  name: string;
  compat?: Record<string, unknown>;
}

interface OmpContext {
  model?: OmpRoutableModel;
  hasUI: boolean;
  ui: {
    setStatus(key: string, text: string | undefined): void;
  };
}

/**
 * Both formats register under an OmniRoute-specific API id so the host dispatches
 * through our `streamSimple`; the built-in id is restored before delegating, since
 * that is what pi-ai's provider reads. Registering a built-in id directly is
 * rejected by pi-ai's custom-API registry and would forfeit the hook entirely.
 */
const HOST_API_BY_FORMAT = {
  chat_completions: "omniroute-openai-completions",
  responses: "omniroute-openai-responses",
} as const satisfies Record<OmniRouteApiFormat, string>;

const PROVIDER_API_BY_FORMAT = {
  chat_completions: "openai-completions",
  responses: "openai-responses",
} as const satisfies Record<OmniRouteApiFormat, string>;


interface OmpProviderConfig {
  name: string;
  baseUrl: string;
  apiKey: string;
  api: (typeof HOST_API_BY_FORMAT)[OmniRouteApiFormat];
  streamSimple?: typeof streamOpenAICompletions;
  models: OmniRouteModel[];
}

/**
 * Route status is keyed by the requested model id, never by a single shared slot:
 * side requests (title generation, auto thinking-level probes) stream a different
 * model concurrently, and their resolution must not retitle the session's model.
 */
function createOmpRouteStream(
  api: OmpExtensionAPI,
  modelIds: Set<string>,
  comboIds: Set<string>,
  format: OmniRouteApiFormat,
): typeof streamOpenAICompletions {
  const routeNames = new Map<string, string>();
  const bindRouteName = (model: OmpRoutableModel | undefined): string | undefined => {
    if (!model || !modelIds.has(model.id)) return undefined;
    // pi-catalog cannot resolve compatibility defaults for extension-defined API
    // identifiers, while provider paths still require an object.
    model.compat ??= {};
    const modelId = model.id;
    Object.defineProperty(model, "name", {
      configurable: true,
      enumerable: true,
      get: () => routeNames.get(modelId) ?? modelId,
      set: () => {},
    });
    return modelId;
  };
  const resetRouteState = (_event: { payload?: unknown }, context: OmpContext) => {
    routeNames.clear();
    bindRouteName(context.model);
  };

  api.on("session_start", resetRouteState);
  api.on("session_switch", resetRouteState);

  return (model, context, options) => {
    const routableModel = model as unknown as OmpRoutableModel;
    const requestedModel = bindRouteName(routableModel);
    const callerFetch = options?.fetch ?? fetch;
    if (requestedModel && !comboIds.has(requestedModel)) routeNames.delete(requestedModel);
    const updateRouteName = (routedModel: string) => {
      routeNames.set(requestedModel!, resolvedRouteStatus(requestedModel!, routedModel));
    };
    const simpleOptions = options as OpenAICompletionsOptions & {
      reasoning?: ReasoningEffort;
      reasoningSummary?: "auto" | "detailed" | "concise" | null;
      hideThinkingSummary?: boolean;
    };
    const wrappedOptions = {
      ...simpleOptions,
      // Only supply the host's live thinking level when the caller left it unset:
      // an explicit per-request effort (side requests pick their own) always wins.
      reasoning: simpleOptions.reasoning ?? api.getThinkingLevel(),
      // OpenAI Responses emits reasoning summary events only when requested.
      // Preserve explicit host preference; otherwise mirror normal thinking
      // visibility and request auto summaries by default.
      reasoningSummary: format === "responses"
        ? simpleOptions.reasoningSummary !== undefined
          ? simpleOptions.reasoningSummary
          : simpleOptions.hideThinkingSummary
            ? null
            : "auto"
        : simpleOptions.reasoningSummary,
      fetch: async (input: string | URL | Request, init?: RequestInit) => {
        const response = await callerFetch(input, init);
        if (requestedModel) {
          const routedModel = response.headers.get("x-omniroute-model")?.trim();
          if (routedModel) updateRouteName(routedModel);
        }
        return stripKeepaliveFrames(response, lines => {
          if (!requestedModel) return;
          const routedModel = extractOmniRouteModel(lines);
          if (routedModel) updateRouteName(routedModel);
        });
      },
    };
    const providerModel = {
      ...model,
      id: requestedModel ?? model.id,
      api: PROVIDER_API_BY_FORMAT[format],
      compat: { ...model.compat },
    };
    return format === "responses"
      ? streamOpenAIResponses(providerModel as never, context, wrappedOptions as never)
      : streamOpenAICompletions(providerModel as never, context, wrappedOptions);
  };
}

function withReasoningEffort(
  payload: unknown,
  modelIds: Set<string>,
  reasoning: ReasoningEffort | undefined,
  format: OmniRouteApiFormat,
): unknown {
  if (!reasoning || !payload || typeof payload !== "object") return payload;
  const body = payload as Record<string, unknown>;
  if (typeof body.model !== "string" || !modelIds.has(body.model)) return payload;
  if (format === "responses") {
    if (body.reasoning_effort !== undefined) return payload;
    if (body.reasoning === undefined) {
      body.reasoning = { effort: reasoning };
      return payload;
    }
    if (!body.reasoning || typeof body.reasoning !== "object" || Array.isArray(body.reasoning)) return payload;
    const reasoningConfig = body.reasoning as Record<string, unknown>;
    if (reasoningConfig.effort === undefined) reasoningConfig.effort = reasoning;
  } else if (body.reasoning_effort === undefined && body.reasoning === undefined) {
    body.reasoning_effort = reasoning;
  }
  return payload;
}


// OMP reloads extensions for each subagent and replaces source-scoped provider
// registrations. Keep the last successful process-local discovery so a transient
// child failure cannot replace the parent's authenticated provider with nothing.
const OMP_DISCOVERY_CACHE_KEY = Symbol.for("omniroute-pi-adapter-ext.omp-discovery");
const globalState = globalThis as Record<PropertyKey, unknown>;
const ompDiscoveryCache = globalState[OMP_DISCOVERY_CACHE_KEY] instanceof Map
  ? globalState[OMP_DISCOVERY_CACHE_KEY] as Map<string, OmniRouteDiscovery>
  : new Map<string, OmniRouteDiscovery>();
globalState[OMP_DISCOVERY_CACHE_KEY] = ompDiscoveryCache;

async function discoverOmpModels(
  environment: Record<string, string | undefined>,
  fetcher: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
): Promise<OmniRouteDiscovery | undefined> {
  const configPath = omniRouteConfigPath("omp", environment);
  const cacheKey = JSON.stringify([
    configPath,
    environment.OMNIROUTE_BASE_URL?.trim() ?? "",
    environment.OMNIROUTE_API_KEY?.trim() ?? "",
  ]);
  const discovery = await tryDiscoverModels(environment, fetcher, configPath);
  if (discovery) {
    ompDiscoveryCache.set(cacheKey, discovery);
    return discovery;
  }
  return ompDiscoveryCache.get(cacheKey);
}

export async function activateOmp(
  api: OmpExtensionAPI,
  environment: Record<string, string | undefined> = process.env,
  fetcher: (input: string | URL | Request, init?: RequestInit) => Promise<Response> = fetch,
): Promise<void> {
  const discovery = await discoverOmpModels(environment, fetcher);
  if (!discovery) return;
  const { config, catalog: { models } } = discovery;
  const modelIds = new Set(models.map(model => model.id));
  const comboIds = new Set(models.filter(model => model.isCombo).map(model => model.id));
  const ompModels = models.map(model => ({ ...model }));
  api.on("before_provider_request", event => withReasoningEffort(
    event.payload,
    modelIds,
    api.getThinkingLevel(),
    config.format,
  ));
  api.registerProvider("omniroute", {
    name: "OmniRoute",
    baseUrl: `${config.baseUrl}/v1`,
    apiKey: config.apiKey,
    api: HOST_API_BY_FORMAT[config.format],
    streamSimple: createOmpRouteStream(api, modelIds, comboIds, config.format),
    models: ompModels,
  });
}
