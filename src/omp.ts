import { streamOpenAICompletions, type OpenAICompletionsOptions } from "@oh-my-pi/pi-ai";
import { extractOmniRouteModel, omniRouteConfigPath, resolvedRouteStatus, tryDiscoverModels, type OmniRouteModel } from "./shared.ts";

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

interface OmpProviderConfig {
  name: string;
  baseUrl: string;
  apiKey: string;
  api: "omniroute-openai-completions";
  streamSimple: typeof streamOpenAICompletions;
  models: OmniRouteModel[];
}

function observeRouteResponse(
  response: Response,
  requestedCombo: string,
  updateModelName: (name: string) => void,
): Response {
  if (!response.body) return response;
  const decoder = new TextDecoder();
  let pending = "";
  const inspect = (text: string) => {
    pending += text;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    for (const line of lines) {
      const routedModel = extractOmniRouteModel([line]);
      if (routedModel) updateModelName(resolvedRouteStatus(requestedCombo, routedModel));
    }
  };
  const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      inspect(decoder.decode(chunk, { stream: true }));
      controller.enqueue(chunk);
    },
    flush() {
      inspect(decoder.decode() + "\n");
    },
  }));
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

function withComboReasoningEffort(
  payload: unknown,
  comboIds: Set<string>,
  reasoning: ReasoningEffort | undefined,
): unknown {
  if (!reasoning || !payload || typeof payload !== "object") return payload;
  const body = payload as Record<string, unknown>;
  if (typeof body.model !== "string" || !comboIds.has(body.model)) return payload;
  if (body.reasoning_effort !== undefined || body.reasoning !== undefined) return payload;
  body.reasoning_effort = reasoning;
  return payload;
}

function createOmpRouteStream(api: OmpExtensionAPI, comboIds: Set<string>): typeof streamOpenAICompletions {
  const routeNames = new Map<string, string>();
  let statusContext: OmpContext | undefined;

  api.on("session_start", (_event, context) => {
    statusContext = context;
    const model = context.model;
    if (!model || !comboIds.has(model.id)) return;
    const comboId = model.id;
    Object.defineProperty(model, "name", {
      configurable: true,
      enumerable: true,
      get: () => routeNames.get(comboId) ?? comboId,
      set: () => {},
    });
  });

  return (model, context, options) => {
    const requestedCombo = comboIds.has(model.id) ? model.id : undefined;
    const callerFetch = options?.fetch ?? fetch;
    if (requestedCombo) routeNames.delete(requestedCombo);
    const updateRoute = (status: string) => {
      if (!requestedCombo) return;
      routeNames.set(requestedCombo, status);
      statusContext?.ui.setStatus("omniroute-route", undefined);
    };
    const simpleOptions = options as OpenAICompletionsOptions & { reasoning?: ReasoningEffort };
    const wrappedOptions: OpenAICompletionsOptions = {
      ...simpleOptions,
      reasoning: simpleOptions.reasoning ?? api.getThinkingLevel(),
      fetch: requestedCombo
        ? async (input, init) => observeRouteResponse(await callerFetch(input, init), requestedCombo, updateRoute)
        : callerFetch,
    };
    return streamOpenAICompletions(
      { ...model, api: "openai-completions", compat: { ...model.compat } },
      context,
      wrappedOptions,
    );
  };
}

export async function activateOmp(
  api: OmpExtensionAPI,
  environment: Record<string, string | undefined> = process.env,
  fetcher: (input: string | URL | Request, init?: RequestInit) => Promise<Response> = fetch,
): Promise<void> {
  const discovery = await tryDiscoverModels(environment, fetcher, omniRouteConfigPath("omp", environment));
  if (!discovery) return;
  const { config, catalog: { models, comboIds } } = discovery;
  api.on("before_provider_request", event => withComboReasoningEffort(
    event.payload,
    comboIds,
    api.getThinkingLevel(),
  ));
  api.registerProvider("omniroute", {
    name: "OmniRoute",
    baseUrl: `${config.baseUrl}/v1`,
    apiKey: config.apiKey,
    api: "omniroute-openai-completions",
    streamSimple: createOmpRouteStream(api, comboIds),
    models,
  });
}
