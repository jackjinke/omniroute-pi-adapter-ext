import { streamOpenAICompletions, type OpenAICompletionsOptions } from "@oh-my-pi/pi-ai";
import { extractOmniRouteModel, omniRouteConfigPath, tryDiscoverModels, type OmniRouteModel } from "./shared.ts";

export interface OmpExtensionAPI {
  registerProvider(name: string, config: OmpProviderConfig): void;
  on(event: "message_update", handler: (event: unknown, context: OmpContext) => void): void;
  on(event: "session_start", handler: (event: unknown, context: OmpContext) => void): void;
}

interface OmpContext {
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

function createOmpRouteStream(api: OmpExtensionAPI, comboIds: Set<string>): typeof streamOpenAICompletions {
  let resolvedRoute: { combo: string; model: string } | undefined;
  let lastStatus: string | undefined;

  const streamWithRouteStatus: typeof streamOpenAICompletions = (model, context, options) => {
    const requestedCombo = comboIds.has(model.id) ? model.id : undefined;
    const callerObserver = options?.onSseEvent;
    const wrappedOptions: OpenAICompletionsOptions = {
      ...options,
      onSseEvent(event, responseModel) {
        callerObserver?.(event, responseModel);
        if (!requestedCombo) return;
        const routedModel = extractOmniRouteModel(event.raw);
        if (routedModel) resolvedRoute = { combo: requestedCombo, model: routedModel };
      },
    };
    return streamOpenAICompletions(
      { ...model, api: "openai-completions", compat: { ...model.compat } },
      context,
      wrappedOptions,
    );
  };

  api.on("message_update", (_event, context) => {
    if (!resolvedRoute) return;
    lastStatus = `${resolvedRoute.combo} → ${resolvedRoute.model}`;
    resolvedRoute = undefined;
    if (context.hasUI) context.ui.setStatus("omniroute-route", lastStatus);
  });
  api.on("session_start", (_event, context) => {
    if (lastStatus && context.hasUI) context.ui.setStatus("omniroute-route", lastStatus);
  });

  return streamWithRouteStatus;
}

export async function activateOmp(
  api: OmpExtensionAPI,
  environment: Record<string, string | undefined> = process.env,
  fetcher: (input: string | URL | Request, init?: RequestInit) => Promise<Response> = fetch,
): Promise<void> {
  const discovery = await tryDiscoverModels(environment, fetcher, omniRouteConfigPath("omp", environment));
  if (!discovery) return;
  const { config, catalog: { models, comboIds } } = discovery;
  api.registerProvider("omniroute", {
    name: "OmniRoute",
    baseUrl: `${config.baseUrl}/v1`,
    apiKey: config.apiKey,
    api: "omniroute-openai-completions",
    streamSimple: createOmpRouteStream(api, comboIds),
    models,
  });
}
