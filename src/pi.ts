import { omniRouteConfigPath, resolvedRouteStatus, tryDiscoverModels, type OmniRouteModel } from "./shared.ts";

export interface PiExtensionAPI {
  registerProvider(name: string, config: PiProviderConfig): void;
  on(event: string, handler: (event: any, context: any) => void | Promise<void>): void;
}

interface PiContext {
  hasUI: boolean;
  model?: { id: string };
  ui: {
    setStatus(key: string, text: string | undefined): void;
  };
}

interface PiMessageEndEvent {
  message: { role: string };
}

interface PiProviderConfig {
  name: string;
  baseUrl: string;
  apiKey: string;
  api: "openai-completions";
  models: PiProviderModel[];
}

interface PiProviderModel extends Omit<OmniRouteModel, "thinking"> {}

interface CallLogRow {
  requestedModel?: unknown;
  model?: unknown;
}

function callLogRows(payload: unknown): CallLogRow[] {
  if (Array.isArray(payload)) return payload.filter((row): row is CallLogRow => Boolean(row) && typeof row === "object");
  if (!payload || typeof payload !== "object") return [];
  for (const key of ["data", "logs", "rows"]) {
    if (!(key in payload)) continue;
    const rows = Reflect.get(payload, key);
    if (Array.isArray(rows)) {
      return rows.filter((row): row is CallLogRow => Boolean(row) && typeof row === "object");
    }
  }
  return [];
}

function installPiRouteStatus(
  api: PiExtensionAPI,
  baseUrl: string,
  managementToken: string | undefined,
  comboIds: Set<string>,
  fetcher: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
): void {
  if (!managementToken) return;

  api.on("message_end", async (event, context) => {
    if (event.message.role !== "assistant") return;
    const combo = context.model?.id;
    if (!combo || !comboIds.has(combo)) return;

    const url = new URL(`${baseUrl}/api/usage/call-logs`);
    url.searchParams.set("limit", "10");
    url.searchParams.set("search", combo);
    const response = await fetcher(url, {
      headers: { Authorization: `Bearer ${managementToken}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return;
    const row = callLogRows(await response.json()).find(candidate => candidate.requestedModel === combo);
    if (typeof row?.model !== "string" || row.model === combo) return;
    if (context.hasUI) context.ui.setStatus("omniroute-route", resolvedRouteStatus(combo, row.model));
  });
}

export async function activatePi(
  api: PiExtensionAPI,
  environment: Record<string, string | undefined> = process.env,
  fetcher: (input: string | URL | Request, init?: RequestInit) => Promise<Response> = fetch,
): Promise<void> {
  const discovery = await tryDiscoverModels(environment, fetcher, omniRouteConfigPath("pi", environment));
  if (!discovery) return;
  const { config, catalog: { models, comboIds } } = discovery;
  const piModels = models.map(({ thinking: _thinking, ...model }) => model);
  api.registerProvider("omniroute", {
    name: "OmniRoute",
    baseUrl: `${config.baseUrl}/v1`,
    apiKey: config.apiKey,
    api: "openai-completions",
    models: piModels,
  });
  installPiRouteStatus(api, config.baseUrl, environment.OMNIROUTE_MANAGEMENT_TOKEN?.trim(), comboIds, fetcher);
}
