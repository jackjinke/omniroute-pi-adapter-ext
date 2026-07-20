import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activatePi, type PiExtensionAPI } from "../src/pi.ts";
import { activateOmp, type OmpExtensionAPI } from "../src/omp.ts";
import { extractOmniRouteModel, normalizeCatalog, omniRouteConfigPath, readConfig } from "../src/shared.ts";

interface RegisteredProvider {
  baseUrl: string;
  apiKey: string;
  api: string;
  models: Array<{ id: string; name?: string }>;
  streamSimple?: (...args: any[]) => AsyncIterable<unknown>;
}

type FakeOmpHandler = (event: { payload?: unknown }, context: FakeContext) => unknown;

class FakeOmpHost implements OmpExtensionAPI {
  provider?: { name: string; config: RegisteredProvider };
  thinkingLevel?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  handlers = new Map<string, FakeOmpHandler[]>();

  registerProvider(name: string, config: RegisteredProvider): void {
    this.provider = { name, config };
  }

  getThinkingLevel(): "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | undefined {
    return this.thinkingLevel;
  }

  on(event: string, handler: FakeOmpHandler): void {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
  }

  emit(event: string, context: FakeContext): void {
    for (const handler of this.handlers.get(event) ?? []) handler({}, context);
  }
  async emitBeforeProviderRequest(payload: unknown, context: FakeContext): Promise<unknown> {
    let current = payload;
    for (const handler of this.handlers.get("before_provider_request") ?? []) {
      current = await handler({ payload: current }, context) ?? current;
    }
    return current;
  }

}


interface FakeContext {
  model?: { id: string; name: string };
  hasUI: boolean;
  statuses: Array<[string, string | undefined]>;
  ui: { setStatus(key: string, text: string | undefined): void };
}
function fakeContext(model?: { id: string; name: string }): FakeContext {
  const statuses: Array<[string, string | undefined]> = [];
  return { model, hasUI: true, statuses, ui: { setStatus: (key, text) => statuses.push([key, text]) } };
}

class FakePiHost implements PiExtensionAPI {
  provider?: { name: string; config: RegisteredProvider };
  handlers = new Map<string, Array<(event: unknown, context: FakeContext) => void | Promise<void>>>();

  registerProvider(name: string, config: RegisteredProvider): void {
    this.provider = { name, config };
  }

  on(event: string, handler: (event: unknown, context: FakeContext) => void | Promise<void>): void {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
  }
}

describe("shared catalog logic", () => {
  test("preserves combo metadata and configured effort levels", () => {
    const result = normalizeCatalog({
      data: [{
        id: "combo/coding",
        owned_by: "combo",
        context_length: 200000,
        max_output_tokens: 64000,
        capabilities: {
          reasoning: true,
          thinking: true,
          tool_calling: true,
          vision: true,
          effort_tiers: ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
        },
      }],
    }, {
      effortOverrides: { "combo/coding": ["low", "medium", "high", "max"] },
    });

    expect(result.comboIds.has("combo/coding")).toBeTrue();
    expect(result.models[0]).toMatchObject({
      id: "combo/coding",
      name: "combo/coding",
      reasoning: true,
      thinking: { mode: "effort", efforts: ["low", "medium", "high", "max"] },
      thinkingLevelMap: { low: "low", medium: "medium", high: "high", max: "max" },
      input: ["text", "image"],
      contextWindow: 200000,
      maxTokens: 64000,
      compat: { supportsReasoningEffort: true },
    });
  });

  test("excludes minimal from discovered and default effort levels", () => {
    const discovered = normalizeCatalog({
      data: [{ id: "combo/coding", capabilities: { reasoning: true, effort_tiers: ["minimal", "low", "high"] } }],
    }, { effortOverrides: {} });
    expect(discovered.models[0]?.thinking?.efforts).toEqual(["low", "high"]);
    expect(normalizeCatalog({
      data: [{ id: "default", capabilities: { reasoning: true } }],
    }, { effortOverrides: {} }).models[0]?.thinking?.efforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  test("applies exact, wildcard, catalog, then default effort precedence", () => {
    const payload = {
      data: [
        { id: "exact", capabilities: { reasoning: true, effort_tiers: ["low"] } },
        { id: "wildcard", capabilities: { reasoning: true, effort_tiers: ["medium"] } },
      ],
    };
    const overridden = normalizeCatalog(payload, {
      effortOverrides: { exact: ["max"], "*": ["high", "xhigh"] },
    });
    expect(overridden.models.map(model => model.thinking?.efforts)).toEqual([["max"], ["high", "xhigh"]]);

    const discovered = normalizeCatalog(payload, { effortOverrides: {} });
    expect(discovered.models.map(model => model.thinking?.efforts)).toEqual([["low"], ["medium"]]);
    expect(normalizeCatalog({
      data: [{ id: "default", capabilities: { reasoning: true } }],
    }, { effortOverrides: {} }).models[0]?.thinking?.efforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  test("reads per-model efforts from YAML in the host config folder", () => {
    const agentDir = mkdtempSync(join(tmpdir(), "omniroute-config-"));
    const configPath = join(agentDir, "omniroute.yml");
    writeFileSync(configPath, 'combo/custom: [low, max]\n"*": [low, medium, high, xhigh]\n');

    expect(omniRouteConfigPath("omp", { PI_CODING_AGENT_DIR: agentDir })).toBe(configPath);
    expect(readConfig({ OMNIROUTE_API_KEY: "secret" }, configPath).effortOverrides).toEqual({
      "combo/custom": ["low", "max"],
      "*": ["low", "medium", "high", "xhigh"],
    });
    expect(readConfig({ OMNIROUTE_API_KEY: "secret" }, join(agentDir, "missing.yml")).effortOverrides).toEqual({});
  });

  test("rejects invalid catalogs and YAML effort overrides", () => {
    expect(() => normalizeCatalog({}, { effortOverrides: {} })).toThrow("data[]");
    expect(() => normalizeCatalog({ data: [] }, { effortOverrides: {} })).toThrow("no usable models");
    const agentDir = mkdtempSync(join(tmpdir(), "omniroute-invalid-config-"));
    const configPath = join(agentDir, "omniroute.yml");
    writeFileSync(configPath, "combo/custom: [ultra]\n");
    expect(() => readConfig({ OMNIROUTE_API_KEY: "secret" }, configPath)).toThrow("Unsupported reasoning effort");
    writeFileSync(configPath, "combo/custom: [minimal]\n");
    expect(() => readConfig({ OMNIROUTE_API_KEY: "secret" }, configPath)).toThrow("Unsupported reasoning effort");
    writeFileSync(configPath, "[broken");
    expect(() => readConfig({ OMNIROUTE_API_KEY: "secret" }, configPath)).toThrow("Invalid OmniRoute config");
  });

  test("extracts the routed model from a live chunk or trailer", () => {
    expect(extractOmniRouteModel([
      'data: {"model":"vendor/live-model","choices":[]}',
    ])).toBe("vendor/live-model");
    expect(extractOmniRouteModel([
      ": x-omniroute-model=vendor/trailer-model",
      "data: [DONE]",
    ])).toBe("vendor/trailer-model");
    expect(extractOmniRouteModel(["data: [DONE]"])).toBeUndefined();
  });

});

describe("OMP adapter", () => {
  test("registers fetched models before activation resolves", async () => {
    const host = new FakeOmpHost();
    await activateOmp(
      host,
      { OMNIROUTE_API_KEY: "secret", OMNIROUTE_BASE_URL: "http://router.test" },
      async () => Response.json({
        data: [{ id: "combo/coding", owned_by: "combo", capabilities: { reasoning: true } }],
      }),
    );

    expect(host.provider?.name).toBe("omniroute");
    expect(host.provider?.config.baseUrl).toBe("http://router.test/v1");
    expect(host.provider?.config.apiKey).toBe("secret");
    expect(host.provider?.config.api).toBe("omniroute-openai-completions");
    expect(host.provider?.config.models.map(model => model.id)).toEqual(["combo/coding"]);
  });
  test("updates the native model segment without adding a floating status row", async () => {
    const host = new FakeOmpHost();
    await activateOmp(host, { OMNIROUTE_API_KEY: "secret" }, async () => Response.json({
      data: [{ id: "combo/custom", owned_by: "combo" }],
    }));
    const context = fakeContext({ id: "combo/custom", name: "combo/custom" });
    host.emit("session_start", context);

    const stream = host.provider?.config.streamSimple;
    const routedModel = { ...host.provider!.config.models[0], provider: "omniroute", api: "omniroute-openai-completions", baseUrl: "http://router.test/v1" } as never;
    const events = stream?.(
      routedModel,
      { messages: [] } as never,
      {
        apiKey: "secret",
        fetch: async () => new Response([
          'data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"vendor/model-id","choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":null}]}',
          "",
          ": x-omniroute-model=vendor/model-id",
          "",
          "data: [DONE]",
          "",
        ].join("\n"), { headers: { "Content-Type": "text/event-stream" } }),
      },
    );
    if (events) for await (const _event of events) { /* consume the provider stream */ }
    await Bun.sleep(20);
    expect(context.model?.name).toBe("combo/custom → vendor/model-id");
    expect(context.statuses.every(([, text]) => text === undefined)).toBeTrue();
    expect((routedModel as { name: string }).name).toBe("combo/custom");
  });

  test("sends the selected reasoning effort to OmniRoute", async () => {
    const host = new FakeOmpHost();
    await activateOmp(host, { OMNIROUTE_API_KEY: "secret" }, async () => Response.json({
      data: [{
        id: "combo/coding",
        owned_by: "combo",
        capabilities: { reasoning: true, effort_tiers: ["low", "medium", "high", "max"] },
      }],
    }));

    let requestBody: Record<string, unknown> | undefined;
    const stream = host.provider!.config.streamSimple!;
    const model = {
      ...host.provider!.config.models[0],
      provider: "omniroute",
      api: "omniroute-openai-completions",
      baseUrl: "http://router.test/v1",
    } as never;
    const events = stream(model, { messages: [{ role: "user", content: "hello", timestamp: Date.now() }] } as never, {
      apiKey: "secret",
      reasoning: "max",
      fetch: async (_input: string | URL | Request, init?: RequestInit) => {
        requestBody = JSON.parse(String(init?.body));
        return new Response("data: [DONE]\\n\\n", { headers: { "Content-Type": "text/event-stream" } });
      },
    });
    for await (const _event of events) { /* consume the provider stream */ }

    expect(requestBody?.reasoning_effort).toBe("max");
  });

  test("uses OMP's live thinking level when custom API options omit reasoning", async () => {
    const host = new FakeOmpHost();
    host.thinkingLevel = "high";
    await activateOmp(host, { OMNIROUTE_API_KEY: "secret" }, async () => Response.json({
      data: [{ id: "combo/coding", owned_by: "combo", capabilities: { reasoning: true } }],
    }));

    let requestBody: Record<string, unknown> | undefined;
    const model = {
      ...host.provider!.config.models[0],
      provider: "omniroute",
      api: "omniroute-openai-completions",
      baseUrl: "http://router.test/v1",
    } as never;
    const events = host.provider!.config.streamSimple!(model, {
      messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
    } as never, {
      apiKey: "secret",
      fetch: async (_input: string | URL | Request, init?: RequestInit) => {
        requestBody = JSON.parse(String(init?.body));
        return new Response("data: [DONE]\\n\\n", { headers: { "Content-Type": "text/event-stream" } });
      },
    });
    for await (const _event of events) { /* consume the provider stream */ }

    expect(requestBody?.reasoning_effort).toBe("high");
  });

  test("injects the live effort into combo payloads after provider shaping", async () => {
    const host = new FakeOmpHost();
    host.thinkingLevel = "xhigh";
    await activateOmp(host, { OMNIROUTE_API_KEY: "secret" }, async () => Response.json({
      data: [
        { id: "combo/coding", owned_by: "combo", capabilities: { reasoning: true } },
        { id: "direct/model", owned_by: "provider", capabilities: { reasoning: true } },
      ],
    }));
    const context = fakeContext({ id: "combo/coding", name: "combo/coding" });

    expect(await host.emitBeforeProviderRequest({ model: "combo/coding", messages: [] }, context)).toMatchObject({
      model: "combo/coding",
      reasoning_effort: "xhigh",
    });
    expect(await host.emitBeforeProviderRequest({ model: "direct/model", messages: [] }, context)).toEqual({
      model: "direct/model",
      messages: [],
    });
  });

  test("continues startup without registering when discovery fails", async () => {
    const host = new FakeOmpHost();
    await activateOmp(
      host,
      { OMNIROUTE_API_KEY: "secret" },
      async () => new Response("unavailable", { status: 503 }),
    );
    expect(host.provider).toBeUndefined();
  });
});

describe("Pi adapter", () => {
  test("registers the shared discovered catalog with Pi metadata", async () => {
    const host = new FakePiHost();
    await activatePi(
      host,
      { OMNIROUTE_API_KEY: "secret", OMNIROUTE_BASE_URL: "http://router.test" },
      async () => Response.json({
        data: [{
          id: "combo/coding",
          owned_by: "combo",
          capabilities: { reasoning: true, effort_tiers: ["low", "medium", "high", "max"] },
        }],
      }),
    );

    expect(host.provider?.config.api).toBe("openai-completions");
    expect(host.provider?.config.models[0]).toMatchObject({
      id: "combo/coding",
      thinkingLevelMap: { low: "low", medium: "medium", high: "high", max: "max" },
    });
  });
});
