import { streamOpenAICompletions, type OpenAICompletionsOptions } from "@oh-my-pi/pi-ai";
import { extractOmniRouteModel, omniRouteConfigPath, resolvedRouteStatus, tryDiscoverModels, type OmniRouteModel } from "./shared.ts";

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

function createOmpRouteStream(api: OmpExtensionAPI, comboIds: Set<string>): typeof streamOpenAICompletions {
  let statusContext: OmpContext | undefined;

  api.on("message_update", (_event, context) => {
    statusContext = context;
  });
  api.on("session_start", (_event, context) => {
    statusContext = context;
  });

  return (model, context, options) => {
    const requestedCombo = comboIds.has(model.id) ? model.id : undefined;
    const callerFetch = options?.fetch ?? fetch;
    const updateStatus = (status: string) => {
      if (statusContext?.hasUI) statusContext.ui.setStatus("omniroute-route", status);
    };
    const wrappedOptions: OpenAICompletionsOptions = {
      ...options,
      fetch: requestedCombo
        ? async (input, init) => observeRouteResponse(await callerFetch(input, init), requestedCombo, updateStatus)
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
  api.registerProvider("omniroute", {
    name: "OmniRoute",
    baseUrl: `${config.baseUrl}/v1`,
    apiKey: config.apiKey,
    api: "omniroute-openai-completions",
    streamSimple: createOmpRouteStream(api, comboIds),
    models,
  });
}
