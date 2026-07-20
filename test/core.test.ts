import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activatePi, type PiExtensionAPI } from "../src/pi.ts";
import { activateOmp, type OmpExtensionAPI } from "../src/omp.ts";
import { extractOmniRouteModel, normalizeCatalog, omniRouteConfigPath, readConfig, resolvedRouteStatus } from "../src/shared.ts";

interface RegisteredProvider {
  baseUrl: string;
  apiKey: string;
  api: string;
  models: Array<{ id: string; name?: string }>;
  streamSimple?: (...args: any[]) => AsyncIterable<unknown>;
}

class FakeOmpHost implements OmpExtensionAPI {
  provider?: { name: string; config: RegisteredProvider };
  handlers = new Map<string, Array<(event: unknown, context: FakeContext) => void>>();

  registerProvider(name: string, config: RegisteredProvider): void {
    this.provider = { name, config };
  }

  on(event: string, handler: (event: unknown, context: FakeContext) => void): void {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
  }

  emit(event: string, context: FakeContext): void {
    for (const handler of this.handlers.get(event) ?? []) handler({}, context);
  }
}


interface FakeContext {
  hasUI: boolean;
  statuses: Array<[string, string | undefined]>;
  ui: { setStatus(key: string, text: string | undefined): void };
}

function fakeContext(): FakeContext {
  const statuses: Array<[string, string | undefined]> = [];
  return { hasUI: true, statuses, ui: { setStatus: (key, text) => statuses.push([key, text]) } };
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
          effort_tiers: ["none", "low", "medium", "high", "xhigh", "max", "ultra"],
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
    writeFileSync(configPath, "[broken");
    expect(() => readConfig({ OMNIROUTE_API_KEY: "secret" }, configPath)).toThrow("Invalid OmniRoute config");
  });

  test("extracts the concrete model from OmniRoute's SSE trailer", () => {
    expect(extractOmniRouteModel([
      ": x-omniroute-cache-hit=false",
      ": x-omniroute-model=gpt-5.6-sol",
      "data: [DONE]",
    ])).toBe("gpt-5.6-sol");
    expect(extractOmniRouteModel(["data: [DONE]"])).toBeUndefined();
  });

  test("formats resolved combos using raw IDs", () => {
    expect(resolvedRouteStatus("combo/my_combo", "vendor/model-id")).toBe("combo/my_combo → vendor/model-id");
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

  test("updates combo route status as soon as the SSE trailer arrives", async () => {
    const host = new FakeOmpHost();
    await activateOmp(host, { OMNIROUTE_API_KEY: "secret" }, async () => Response.json({
      data: [{ id: "combo/custom", owned_by: "combo" }],
    }));
    const context = fakeContext();
    host.emit("session_start", context);

    const stream = host.provider?.config.streamSimple;
    const events = stream?.(
      { ...host.provider!.config.models[0], provider: "omniroute", api: "omniroute-openai-completions", baseUrl: "http://router.test/v1" } as never,
      { messages: [] } as never,
      {
        apiKey: "secret",
        fetch: async () => new Response([
          'data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"combo/custom","choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":null}]}',
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

    expect(context.statuses).toContainEqual(["omniroute-route", "combo/custom → vendor/model-id"]);
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
