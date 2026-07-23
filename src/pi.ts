import { omniRouteConfigPath, tryDiscoverModels, type OmniRouteApiFormat, type OmniRouteModel } from "./shared.ts";

export interface PiExtensionAPI {
  registerProvider(name: string, config: PiProviderConfig): void;
  on(event: string, handler: (event: any, context: any) => void | Promise<void>): void;
}


interface PiProviderConfig {
  name: string;
  baseUrl: string;
  apiKey: string;
  api: "openai-completions" | "openai-responses";
  models: PiProviderModel[];
}

interface PiProviderModel extends Omit<OmniRouteModel, "thinking"> {}


const PI_API_FORMATS: Record<OmniRouteApiFormat, PiProviderConfig["api"]> = {
  chat_completions: "openai-completions",
  responses: "openai-responses",
};

export async function activatePi(
  api: PiExtensionAPI,
  environment: Record<string, string | undefined> = process.env,
  fetcher: (input: string | URL | Request, init?: RequestInit) => Promise<Response> = fetch,
): Promise<void> {
  const discovery = await tryDiscoverModels(environment, fetcher, omniRouteConfigPath("pi", environment));
  if (!discovery) return;
  const { config, catalog: { models } } = discovery;
  const piModels = models.map(({ thinking: _thinking, ...model }) => model);
  api.registerProvider("omniroute", {
    name: "OmniRoute",
    baseUrl: `${config.baseUrl}/v1`,
    apiKey: config.apiKey,
    api: PI_API_FORMATS[config.format],
    models: piModels,
  });
}
