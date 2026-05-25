import { describe, expect, it, vi } from "vitest";
import {
  loadMarketplaceApiKeys,
  syncMarketplaceModels,
  type MarketplaceApiKeyEntry,
} from "./marketplace-model-sync.ts";

function createState(
  overrides: Partial<{
    marketplaceToken: string | null;
    marketplaceApiKeysLoading: boolean;
    marketplaceApiKeysError: string | null;
    marketplaceApiKeysToken: string | null;
    marketplaceApiKeys: MarketplaceApiKeyEntry[] | null;
    marketplaceSyncInFlight: boolean;
    marketplaceSyncError: string | null;
    marketplaceSyncFingerprint: string | null;
    client: { request: ReturnType<typeof vi.fn> } | null;
    connected: boolean;
    requestUpdate: ReturnType<typeof vi.fn>;
  }> = {},
) {
  return {
    marketplaceToken: overrides.marketplaceToken ?? null,
    marketplaceApiKeysLoading: overrides.marketplaceApiKeysLoading ?? false,
    marketplaceApiKeysError: overrides.marketplaceApiKeysError ?? null,
    marketplaceApiKeysToken: overrides.marketplaceApiKeysToken ?? null,
    marketplaceApiKeys: overrides.marketplaceApiKeys ?? null,
    marketplaceSyncInFlight: overrides.marketplaceSyncInFlight ?? false,
    marketplaceSyncError: overrides.marketplaceSyncError ?? null,
    marketplaceSyncFingerprint: overrides.marketplaceSyncFingerprint ?? null,
    client: overrides.client ?? null,
    connected: overrides.connected ?? false,
    requestUpdate: overrides.requestUpdate ?? vi.fn(),
  };
}

describe("marketplace model sync", () => {
  it("loads marketplace api keys with X-Access-Token", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: [
          {
            modelName: "glm-5.1-cloud",
            modelCustomName: "GLM 5.1 Cloud",
            modelApiKey: "market-key",
            createTime: "2026-05-18T09:02:13",
            endpoint: "http://agi-gateway.cxmt.com/cloud/v1",
            anthropicEndpoint: "http://agi-gateway.cxmt.com/cloud/anthropic/v1",
            cloudId: "volcengine",
            contextLength: 200000,
            outputLength: 128000,
          },
        ],
      }),
    }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const state = createState({ marketplaceToken: "market-token" });

    await loadMarketplaceApiKeys(state);

    expect(fetchMock).toHaveBeenCalledWith("/api/agi/chat/v1/marketplace/my-api-keys", {
      method: "GET",
      headers: {
        Accept: "application/json",
        "X-Access-Token": "market-token",
      },
    });
    expect(state.marketplaceApiKeysToken).toBe("market-token");
    expect(state.marketplaceApiKeys).toEqual([
      expect.objectContaining({
        modelName: "glm-5.1-cloud",
        modelCustomName: "GLM 5.1 Cloud",
        cloudId: "volcengine",
      }),
    ]);
    expect(state.marketplaceApiKeysError).toBeNull();
  });

  it("patches marketplace providers and default model through config.patch", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "config.get") {
        return {
          hash: "cfg-hash",
          config: {
            models: {
              providers: {
                "marketplace-volcengine-old": {
                  baseUrl: "http://old.example/v1",
                  api: "openai-completions",
                  apiKey: "old-key",
                  models: [{ id: "glm-old" }],
                },
              },
            },
            agents: {
              defaults: {
                model: { primary: "openai/gpt-5" },
                models: {
                  "marketplace-volcengine-old/glm-old": {},
                  "openai/gpt-5": {},
                },
              },
            },
          },
        };
      }
      if (method === "config.patch") {
        return { ok: true };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const state = createState({
      connected: true,
      client: { request },
      marketplaceApiKeys: [
        {
          modelName: "glm-5.1-cloud",
          modelCustomName: "glm-5.1-cloud",
          modelApiKey: "market-key",
          createTime: "2026-05-18T09:02:13",
          endpoint: "http://agi-gateway.cxmt.com/cloud/v1",
          anthropicEndpoint: "http://agi-gateway.cxmt.com/cloud/anthropic/v1",
          cloudId: "volcengine",
          contextLength: 200000,
          outputLength: 128000,
        },
      ],
    });

    await syncMarketplaceModels(state);

    expect(request).toHaveBeenNthCalledWith(1, "config.get", {});
    expect(request).toHaveBeenNthCalledWith(
      2,
      "config.patch",
      expect.objectContaining({ baseHash: "cfg-hash" }),
    );
    const raw = request.mock.calls[1]?.[1]?.raw;
    expect(typeof raw).toBe("string");
    const patch = JSON.parse(raw as string) as Record<string, unknown>;
    const providers = (patch.models as { providers?: Record<string, unknown> }).providers ?? {};
    const nextProviderId = Object.keys(providers).find(
      (key) => key.startsWith("marketplace-volcengine-") && key !== "marketplace-volcengine-old",
    );
    expect(nextProviderId).toBeTruthy();
    expect(providers["marketplace-volcengine-old"]).toBeNull();
    expect(providers[nextProviderId!]).toEqual({
      baseUrl: "http://agi-gateway.cxmt.com/cloud/v1",
      api: "openai-completions",
      apiKey: "market-key",
      models: [
        {
          id: "glm-5.1-cloud",
          name: "glm-5.1-cloud",
          reasoning: false,
          input: ["text"],
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
          },
          contextWindow: 200000,
          contextTokens: 200000,
          maxTokens: 128000,
        },
      ],
    });

    const defaults = (
      patch.agents as {
        defaults?: { model?: { primary?: string }; models?: Record<string, unknown> };
      }
    ).defaults;
    expect(defaults?.model?.primary).toBe(`${nextProviderId}/glm-5.1-cloud`);
    expect(defaults?.models?.["marketplace-volcengine-old/glm-old"]).toBeNull();
    expect(defaults?.models?.[`${nextProviderId}/glm-5.1-cloud`]).toEqual({});
    expect(state.marketplaceSyncError).toBeNull();
    expect(state.marketplaceSyncFingerprint).toBeTruthy();
  });
});
