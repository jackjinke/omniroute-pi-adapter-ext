import { describe, expect, test } from "bun:test";
import { activatePi, type PiExtensionAPI } from "../src/pi.ts";
import { activateOmp, type OmpExtensionAPI } from "../src/omp.ts";
import { extractOmniRouteModel, normalizeCatalog, readConfig } from "../src/shared.ts";

interface RegisteredProvider {
  baseUrl: string;
  apiKey: string;
  api: string;
  models: Array<{ id: string }>;
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
}

interface FakeContext {
  hasUI: boolean;
  ui: { setStatus(key: string, text: string | undefined): void };
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
    }, { effortOverrides: {} }).models[0]?.thinking?.efforts).toEqual(["low", "medium", "high", "xhigh"]);
  });

  test("reads per-model and global effort overrides", () => {
    const perModel = readConfig({
      OMNIROUTE_API_KEY: "secret",
      OMNIROUTE_REASONING_EFFORTS: '{"combo/custom":["low","max"]}',
    });
    expect(perModel.effortOverrides).toEqual({ "combo/custom": ["low", "max"] });
    expect(readConfig({
      OMNIROUTE_API_KEY: "secret",
      OMNIROUTE_REASONING_EFFORTS: "low, medium, high, xhigh",
    }).effortOverrides).toEqual({ "*": ["low", "medium", "high", "xhigh"] });
    expect(readConfig({ OMNIROUTE_API_KEY: "secret" }).effortOverrides).toEqual({});
  });

  test("rejects invalid catalogs and effort overrides", () => {
    expect(() => normalizeCatalog({}, { effortOverrides: {} })).toThrow("data[]");
    expect(() => normalizeCatalog({ data: [] }, { effortOverrides: {} })).toThrow("no usable models");
    expect(() => readConfig({
      OMNIROUTE_API_KEY: "secret",
      OMNIROUTE_REASONING_EFFORTS: '{"combo/custom":["ultra"]}',
    })).toThrow("Unsupported reasoning effort");
    expect(() => readConfig({
      OMNIROUTE_API_KEY: "secret",
      OMNIROUTE_REASONING_EFFORTS: "{broken",
    })).toThrow("valid JSON");
  });

  test("extracts the concrete model from OmniRoute's SSE trailer", () => {
    expect(extractOmniRouteModel([
      ": x-omniroute-cache-hit=false",
      ": x-omniroute-model=gpt-5.6-sol",
      "data: [DONE]",
    ])).toBe("gpt-5.6-sol");
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
