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
  type OmniRouteModel,
} from "./shared.ts";

type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface OmpExtensionAPI {
  registerProvider(name: string, config: OmpProviderConfig): void;
  getThinkingLevel(): ReasoningEffort | undefined;
  on(event: string, handler: (event: { payload?: unknown }, context: OmpContext) => unknown): void;
}

interface OmpContext {
  model?: { id: string; name: string };
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
  format: OmniRouteApiFormat,
): typeof streamOpenAICompletions {
  const routeNames = new Map<string, string>();
  let statusContext: OmpContext | undefined;

  api.on("session_start", (_event, context) => {
    statusContext = context;
    const model = context.model;
    if (!model || !modelIds.has(model.id)) return;
    const modelId = model.id;
    Object.defineProperty(model, "name", {
      configurable: true,
      enumerable: true,
      get: () => routeNames.get(modelId) ?? modelId,
      set: () => {},
    });
  });

  return (model, context, options) => {
    const requestedModel = modelIds.has(model.id) ? model.id : undefined;
    const callerFetch = options?.fetch ?? fetch;
    if (requestedModel && !requestedModel.startsWith("combo/")) {
      routeNames.delete(requestedModel);
      if (statusContext?.model?.id === requestedModel) statusContext.ui.setStatus("omniroute-route", undefined);
    }
    const simpleOptions = options as OpenAICompletionsOptions & { reasoning?: ReasoningEffort };
    const wrappedOptions: OpenAICompletionsOptions = {
      ...simpleOptions,
      // Only supply the host's live thinking level when the caller left it unset:
      // an explicit per-request effort (side requests pick their own) always wins.
      reasoning: simpleOptions.reasoning ?? api.getThinkingLevel(),
      fetch: async (input, init) => stripKeepaliveFrames(await callerFetch(input, init), lines => {
        if (!requestedModel) return;
        const routedModel = extractOmniRouteModel(lines);
        if (!routedModel) return;
        const status = resolvedRouteStatus(requestedModel, routedModel);
        routeNames.set(requestedModel, status);
        // Current OMP footer renders model.id, while older hosts used model.name.
        // Publish through extension status API for current OMP; keep the getter
        // above for older hosts. Match active model id so title/auto side requests
        // cannot overwrite main session route status.
        if (statusContext?.model?.id === requestedModel) {
          statusContext.ui.setStatus("omniroute-route", status);
        }
      }),
    };
    const providerModel = { ...model, api: PROVIDER_API_BY_FORMAT[format], compat: { ...model.compat } };
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
  if (body.reasoning_effort !== undefined || body.reasoning !== undefined) return payload;
  if (format === "responses") {
    body.reasoning = { effort: reasoning };
  } else {
    body.reasoning_effort = reasoning;
  }
  return payload;
}


export async function activateOmp(
  api: OmpExtensionAPI,
  environment: Record<string, string | undefined> = process.env,
  fetcher: (input: string | URL | Request, init?: RequestInit) => Promise<Response> = fetch,
): Promise<void> {
  const discovery = await tryDiscoverModels(environment, fetcher, omniRouteConfigPath("omp", environment));
  if (!discovery) return;
  const { config, catalog: { models } } = discovery;
  const modelIds = new Set(models.map(model => model.id));
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
    streamSimple: createOmpRouteStream(api, modelIds, config.format),
    models,
  });
}
