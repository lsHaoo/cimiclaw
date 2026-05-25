import { buildQualifiedChatModelValue } from "../chat-model-ref.ts";
import type { GatewayBrowserClient } from "../gateway.ts";
import { normalizeOptionalString } from "../string-coerce.ts";
import type { ConfigSnapshot } from "../types.ts";

const MARKETPLACE_API_KEYS_PATH = "/api/agi/chat/v1/marketplace/my-api-keys";
const MARKETPLACE_PROVIDER_PREFIX = "marketplace-";

export type MarketplaceApiKeyEntry = {
  modelName: string;
  modelCustomName: string;
  modelApiKey: string;
  createTime: string;
  endpoint: string;
  anthropicEndpoint: string;
  cloudId: string;
  contextLength: number | null;
  outputLength: number | null;
};

type MarketplaceApiKeysResponse = {
  data?: unknown;
};

type MarketplaceSyncState = {
  marketplaceToken: string | null;
  marketplaceApiKeysLoading: boolean;
  marketplaceApiKeysError: string | null;
  marketplaceApiKeysToken: string | null;
  marketplaceApiKeys: MarketplaceApiKeyEntry[] | null;
  marketplaceSyncInFlight: boolean;
  marketplaceSyncError: string | null;
  marketplaceSyncFingerprint: string | null;
  client: GatewayBrowserClient | null;
  connected: boolean;
  requestUpdate?: () => void;
};

type MarketplaceProviderBucket = {
  providerId: string;
  entries: MarketplaceApiKeyEntry[];
  endpoint: string;
  apiKey: string;
};

const marketplaceFetchVersions = new WeakMap<object, number>();

function nextMarketplaceFetchVersion(state: MarketplaceSyncState): number {
  const key = state as object;
  const next = (marketplaceFetchVersions.get(key) ?? 0) + 1;
  marketplaceFetchVersions.set(key, next);
  return next;
}

function isMarketplaceFetchCurrent(state: MarketplaceSyncState, version: number): boolean {
  return marketplaceFetchVersions.get(state as object) === version;
}

function updateMarketplaceState(state: MarketplaceSyncState) {
  state.requestUpdate?.();
}

function parseMarketplaceNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function parseMarketplaceEntry(value: unknown): MarketplaceApiKeyEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const row = value as Record<string, unknown>;
  const modelName = normalizeOptionalString(row.modelName);
  const endpoint = normalizeOptionalString(row.endpoint);
  const modelApiKey = normalizeOptionalString(row.modelApiKey);
  if (!modelName || !endpoint || !modelApiKey) {
    return null;
  }
  return {
    modelName,
    modelCustomName: normalizeOptionalString(row.modelCustomName) ?? modelName,
    modelApiKey,
    createTime: normalizeOptionalString(row.createTime) ?? "",
    endpoint,
    anthropicEndpoint: normalizeOptionalString(row.anthropicEndpoint) ?? "",
    cloudId: normalizeOptionalString(row.cloudId) ?? "marketplace",
    contextLength: parseMarketplaceNumber(row.contextLength),
    outputLength: parseMarketplaceNumber(row.outputLength),
  };
}

function normalizeMarketplaceEntries(data: unknown): MarketplaceApiKeyEntry[] {
  if (!Array.isArray(data)) {
    return [];
  }
  return data
    .map(parseMarketplaceEntry)
    .filter((entry): entry is MarketplaceApiKeyEntry => Boolean(entry));
}

function normalizeMarketplaceProviderSegment(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "default";
}

function createMarketplaceProviderSuffix(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0").slice(0, 8);
}

function buildMarketplaceProviderBuckets(
  entries: MarketplaceApiKeyEntry[],
): MarketplaceProviderBucket[] {
  const buckets = new Map<string, MarketplaceApiKeyEntry[]>();
  for (const entry of entries) {
    const key = `${entry.cloudId}\u0000${entry.endpoint}\u0000${entry.modelApiKey}`;
    const current = buckets.get(key) ?? [];
    current.push(entry);
    buckets.set(key, current);
  }
  return [...buckets.entries()]
    .map(([key, bucketEntries]) => {
      const [cloudId, endpoint, apiKey] = key.split("\u0000");
      const modelIds = bucketEntries
        .map((entry) => entry.modelName)
        .sort((a, b) => a.localeCompare(b));
      return {
        providerId: `${MARKETPLACE_PROVIDER_PREFIX}${normalizeMarketplaceProviderSegment(cloudId)}-${createMarketplaceProviderSuffix(`${endpoint}|${apiKey}|${modelIds.join(",")}`)}`,
        entries: [...bucketEntries].sort((a, b) => a.modelName.localeCompare(b.modelName)),
        endpoint,
        apiKey,
      };
    })
    .sort((a, b) => a.providerId.localeCompare(b.providerId));
}

function createMarketplaceFingerprint(entries: MarketplaceApiKeyEntry[]): string {
  return JSON.stringify(
    entries
      .map((entry) => ({
        modelName: entry.modelName,
        modelCustomName: entry.modelCustomName,
        modelApiKey: entry.modelApiKey,
        endpoint: entry.endpoint,
        cloudId: entry.cloudId,
        contextLength: entry.contextLength,
        outputLength: entry.outputLength,
      }))
      .sort((a, b) =>
        buildQualifiedChatModelValue(a.modelName, a.cloudId).localeCompare(
          buildQualifiedChatModelValue(b.modelName, b.cloudId),
        ),
      ),
  );
}

function resolveCurrentPrimaryModel(
  config: Record<string, unknown> | null | undefined,
): string | null {
  const defaults = (config?.agents as { defaults?: unknown } | undefined)?.defaults;
  if (!defaults || typeof defaults !== "object") {
    return null;
  }
  const model = (defaults as { model?: unknown }).model;
  if (typeof model === "string") {
    return normalizeOptionalString(model) ?? null;
  }
  if (model && typeof model === "object" && !Array.isArray(model)) {
    return normalizeOptionalString((model as { primary?: unknown }).primary) ?? null;
  }
  return null;
}

function isMarketplaceModelRef(value: string | null | undefined): boolean {
  return Boolean(value && value.trim().toLowerCase().startsWith(MARKETPLACE_PROVIDER_PREFIX));
}

function buildMarketplaceConfigPatch(
  config: Record<string, unknown> | null | undefined,
  entries: MarketplaceApiKeyEntry[],
) {
  const providerBuckets = buildMarketplaceProviderBuckets(entries);
  const nextModelRefs = providerBuckets.flatMap((bucket) =>
    bucket.entries.map((entry) => buildQualifiedChatModelValue(entry.modelName, bucket.providerId)),
  );

  const currentProviders =
    ((config?.models as { providers?: unknown } | undefined)?.providers as
      | Record<string, unknown>
      | undefined) ?? {};
  const currentAllowlist =
    ((config?.agents as { defaults?: { models?: unknown } } | undefined)?.defaults?.models as
      | Record<string, unknown>
      | undefined) ?? {};
  const currentPrimary = resolveCurrentPrimaryModel(config);
  const nextProviders = new Set(providerBuckets.map((bucket) => bucket.providerId));
  const providerPatch: Record<string, unknown> = {};
  const allowlistPatch: Record<string, unknown> = {};

  for (const providerId of Object.keys(currentProviders)) {
    if (providerId.startsWith(MARKETPLACE_PROVIDER_PREFIX) && !nextProviders.has(providerId)) {
      providerPatch[providerId] = null;
    }
  }

  for (const modelRef of Object.keys(currentAllowlist)) {
    if (isMarketplaceModelRef(modelRef) && !nextModelRefs.includes(modelRef)) {
      allowlistPatch[modelRef] = null;
    }
  }

  if (nextModelRefs.length === 0) {
    if (Object.keys(providerPatch).length === 0 && Object.keys(allowlistPatch).length === 0) {
      return null;
    }
    if (isMarketplaceModelRef(currentPrimary)) {
      return null;
    }
    return {
      models: { providers: providerPatch },
      agents: { defaults: { models: allowlistPatch } },
    };
  }

  for (const bucket of providerBuckets) {
    providerPatch[bucket.providerId] = {
      baseUrl: bucket.endpoint,
      api: "openai-completions",
      apiKey: bucket.apiKey,
      models: bucket.entries.map((entry) => ({
        id: entry.modelName,
        name: entry.modelCustomName || entry.modelName,
        reasoning: false,
        input: ["text"],
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
        },
        ...(entry.contextLength
          ? { contextWindow: entry.contextLength, contextTokens: entry.contextLength }
          : {}),
        ...(entry.outputLength ? { maxTokens: entry.outputLength } : {}),
      })),
    };
  }

  for (const modelRef of nextModelRefs) {
    allowlistPatch[modelRef] = currentAllowlist[modelRef] ?? {};
  }

  const primary =
    currentPrimary && nextModelRefs.includes(currentPrimary)
      ? currentPrimary
      : (nextModelRefs[0] ?? null);
  if (!primary) {
    return null;
  }

  return {
    models: { providers: providerPatch },
    agents: {
      defaults: {
        model: { primary },
        models: allowlistPatch,
      },
    },
  };
}

export async function loadMarketplaceApiKeys(state: MarketplaceSyncState) {
  const token = normalizeOptionalString(state.marketplaceToken);
  if (!token) {
    state.marketplaceApiKeysLoading = false;
    state.marketplaceApiKeysError = null;
    state.marketplaceApiKeysToken = null;
    state.marketplaceApiKeys = null;
    state.marketplaceSyncError = null;
    state.marketplaceSyncFingerprint = null;
    updateMarketplaceState(state);
    return;
  }
  if (typeof fetch !== "function") {
    return;
  }
  if (state.marketplaceApiKeysLoading && state.marketplaceApiKeysToken === token) {
    return;
  }
  if (
    state.marketplaceApiKeysToken === token &&
    state.marketplaceApiKeys &&
    !state.marketplaceApiKeysError
  ) {
    if (state.connected) {
      void syncMarketplaceModels(state);
    }
    return;
  }

  const version = nextMarketplaceFetchVersion(state);
  state.marketplaceApiKeysLoading = true;
  state.marketplaceApiKeysError = null;
  state.marketplaceApiKeysToken = token;
  state.marketplaceApiKeys = null;
  state.marketplaceSyncError = null;
  state.marketplaceSyncFingerprint = null;
  updateMarketplaceState(state);

  try {
    const response = await fetch(MARKETPLACE_API_KEYS_PATH, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "X-Access-Token": token,
      },
    });
    if (!response.ok) {
      throw new Error(`marketplace api keys request failed (${response.status})`);
    }
    const payload = (await response.json()) as MarketplaceApiKeysResponse;
    const entries = normalizeMarketplaceEntries(payload.data);
    if (!isMarketplaceFetchCurrent(state, version)) {
      return;
    }
    state.marketplaceApiKeys = entries;
    state.marketplaceApiKeysError = null;
    updateMarketplaceState(state);
    if (state.connected) {
      void syncMarketplaceModels(state);
    }
  } catch (error) {
    if (!isMarketplaceFetchCurrent(state, version)) {
      return;
    }
    state.marketplaceApiKeysError = error instanceof Error ? error.message : String(error);
    state.marketplaceApiKeys = null;
    updateMarketplaceState(state);
  } finally {
    if (isMarketplaceFetchCurrent(state, version)) {
      state.marketplaceApiKeysLoading = false;
      updateMarketplaceState(state);
    }
  }
}

export async function syncMarketplaceModels(state: MarketplaceSyncState) {
  if (!state.client || !state.connected || state.marketplaceSyncInFlight) {
    return false;
  }
  const entries = state.marketplaceApiKeys ?? [];
  if (entries.length === 0) {
    return false;
  }
  const fingerprint = createMarketplaceFingerprint(entries);
  if (state.marketplaceSyncFingerprint === fingerprint) {
    return false;
  }

  state.marketplaceSyncInFlight = true;
  state.marketplaceSyncError = null;
  updateMarketplaceState(state);
  try {
    const snapshot = await state.client.request<ConfigSnapshot>("config.get", {});
    const patch = buildMarketplaceConfigPatch(snapshot.config ?? null, entries);
    if (!patch || !snapshot.hash) {
      state.marketplaceSyncFingerprint = fingerprint;
      return false;
    }
    await state.client.request("config.patch", {
      raw: JSON.stringify(patch),
      baseHash: snapshot.hash,
    });
    state.marketplaceSyncFingerprint = fingerprint;
    return true;
  } catch (error) {
    state.marketplaceSyncError = error instanceof Error ? error.message : String(error);
    return false;
  } finally {
    state.marketplaceSyncInFlight = false;
    updateMarketplaceState(state);
  }
}
