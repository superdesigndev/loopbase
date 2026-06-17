// Model price catalog + token→USD math. Pure + dependency-free so it unit-tests
// without touching SQLite. Modeled on ax's cost math (github.com/Necmttn/ax →
// apps/axctl/src/ingest/model-pricing.ts) but written fresh for loopbase.
//
// Convention (matches the adapters + DB): token `prompt` counts are INCLUSIVE of
// cache; estimateCost subtracts cache to recover fresh input, so cache is never
// double-charged. (docs/cost-plan.md → Critical correctness notes.)

import { readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { storageDir } from "./constants.ts";

// Stamp identifying the built-in rate table. Stored on priced rows; a change
// here (or a newer cache) is what `lb cost --refresh` reprices against.
export const BUILTIN_CATALOG_VERSION = "builtin_2026-06-17";

// Marks a cost computed at read time (fallback) vs. memoized at index.
export const ESTIMATED_PRICING_PREFIX = "estimated:";

export interface ModelPricing {
  provider: string;
  inputPerMillionUsd: number | null;
  outputPerMillionUsd: number | null;
  cacheCreationPerMillionUsd: number | null;
  cacheReadPerMillionUsd: number | null;
  // Optional 200k-context tier rates (LiteLLM/models.dev provide these).
  inputAbove200kPerMillionUsd?: number | null;
  outputAbove200kPerMillionUsd?: number | null;
  cacheCreationAbove200kPerMillionUsd?: number | null;
  cacheReadAbove200kPerMillionUsd?: number | null;
  fastMultiplier: number;
  pricingSource: string;
}

export interface CostEstimate {
  inputUsd: number | null;
  outputUsd: number | null;
  cacheCreationUsd: number | null;
  cacheReadUsd: number | null;
  totalUsd: number | null;
  pricingSource: string | null;
}

// Default cache rates when a row omits them: creation ≈ 1.25× input, read ≈ 0.1×.
function withCacheDefaults(p: ModelPricing): ModelPricing {
  return {
    ...p,
    cacheCreationPerMillionUsd:
      p.cacheCreationPerMillionUsd ?? (p.inputPerMillionUsd === null ? null : p.inputPerMillionUsd * 1.25),
    cacheReadPerMillionUsd:
      p.cacheReadPerMillionUsd ?? (p.inputPerMillionUsd === null ? null : p.inputPerMillionUsd * 0.1),
  };
}

const V = BUILTIN_CATALOG_VERSION;

// Per-million USD rates. Values mirror ax's catalog (which tracks provider list
// prices); refresh from upstream with refreshCatalog().
export const BUILTIN_CATALOG: Readonly<Record<string, ModelPricing>> = {
  // OpenAI / Codex
  "gpt-5": { provider: "openai", inputPerMillionUsd: 1.25, outputPerMillionUsd: 10, cacheCreationPerMillionUsd: null, cacheReadPerMillionUsd: 0.125, fastMultiplier: 1, pricingSource: V },
  "gpt-5-codex": { provider: "openai", inputPerMillionUsd: 1.75, outputPerMillionUsd: 14, cacheCreationPerMillionUsd: 1.75, cacheReadPerMillionUsd: 0.175, fastMultiplier: 1, pricingSource: V },
  "gpt-5.1-codex": { provider: "openai", inputPerMillionUsd: 1.25, outputPerMillionUsd: 10, cacheCreationPerMillionUsd: 1.25, cacheReadPerMillionUsd: 0.125, fastMultiplier: 1, pricingSource: V },
  "gpt-5.2-codex": { provider: "openai", inputPerMillionUsd: 1.75, outputPerMillionUsd: 14, cacheCreationPerMillionUsd: 1.75, cacheReadPerMillionUsd: 0.175, fastMultiplier: 1, pricingSource: V },
  "gpt-5.3-codex": { provider: "openai", inputPerMillionUsd: 1.75, outputPerMillionUsd: 14, cacheCreationPerMillionUsd: 1.75, cacheReadPerMillionUsd: 0.175, fastMultiplier: 2, pricingSource: V },
  "gpt-5.4": { provider: "openai", inputPerMillionUsd: 2.5, outputPerMillionUsd: 15, cacheCreationPerMillionUsd: 2.5, cacheReadPerMillionUsd: 0.25, fastMultiplier: 2, pricingSource: V },
  "gpt-5.5": { provider: "openai", inputPerMillionUsd: 5, outputPerMillionUsd: 30, cacheCreationPerMillionUsd: 5, cacheReadPerMillionUsd: 0.5, fastMultiplier: 2.5, pricingSource: V },
  "gpt-5-mini": { provider: "openai", inputPerMillionUsd: 0.25, outputPerMillionUsd: 2, cacheCreationPerMillionUsd: null, cacheReadPerMillionUsd: 0.025, fastMultiplier: 1, pricingSource: V },
  "gpt-4.1": { provider: "openai", inputPerMillionUsd: 2, outputPerMillionUsd: 8, cacheCreationPerMillionUsd: null, cacheReadPerMillionUsd: 0.5, fastMultiplier: 1, pricingSource: V },
  // Anthropic / Claude
  "claude-opus-4": { provider: "anthropic", inputPerMillionUsd: 15, outputPerMillionUsd: 75, cacheCreationPerMillionUsd: 18.75, cacheReadPerMillionUsd: 1.5, fastMultiplier: 1, pricingSource: V },
  "claude-opus-4-5": { provider: "anthropic", inputPerMillionUsd: 5, outputPerMillionUsd: 25, cacheCreationPerMillionUsd: 6.25, cacheReadPerMillionUsd: 0.5, fastMultiplier: 1, pricingSource: V },
  "claude-opus-4-8": { provider: "anthropic", inputPerMillionUsd: 5, outputPerMillionUsd: 25, cacheCreationPerMillionUsd: 6.25, cacheReadPerMillionUsd: 0.5, fastMultiplier: 1, pricingSource: V },
  "claude-sonnet-4": { provider: "anthropic", inputPerMillionUsd: 3, outputPerMillionUsd: 15, cacheCreationPerMillionUsd: 3.75, cacheReadPerMillionUsd: 0.3, fastMultiplier: 1, pricingSource: V },
  "claude-haiku-4-5": { provider: "anthropic", inputPerMillionUsd: 1, outputPerMillionUsd: 5, cacheCreationPerMillionUsd: 1.25, cacheReadPerMillionUsd: 0.1, fastMultiplier: 1, pricingSource: V },
  "claude-fable-5": { provider: "anthropic", inputPerMillionUsd: 10, outputPerMillionUsd: 50, cacheCreationPerMillionUsd: 12.5, cacheReadPerMillionUsd: 1, fastMultiplier: 1, pricingSource: V },
};

export type Catalog = ReadonlyMap<string, ModelPricing>;

export function builtinCatalog(): Map<string, ModelPricing> {
  const m = new Map<string, ModelPricing>();
  for (const [k, v] of Object.entries(BUILTIN_CATALOG)) m.set(k, withCacheDefaults(v));
  return m;
}

// Lowercase/trim a raw model string to a catalog key. Bare provider names and
// the synthetic sentinel are not real models → null (unknown, not free).
export function normalizeModelName(model: string | null | undefined): string | null {
  const trimmed = model?.trim();
  if (!trimmed || trimmed === "<synthetic>") return null;
  const key = trimmed.toLowerCase();
  if (["openai", "anthropic", "google", "deepseek", "qwen"].includes(key)) return null;
  return key;
}

export function inferModelProvider(modelKey: string): string {
  if (modelKey.startsWith("claude-")) return "anthropic";
  if (modelKey.startsWith("gpt-") || modelKey.startsWith("o")) return "openai";
  if (modelKey.includes("gemini")) return "google";
  return "unknown";
}

// Resolve a model key to pricing: exact hit, then version-family fallbacks so an
// unseen point release (e.g. claude-opus-4-9) still prices off its family.
export function pricingForModel(modelKey: string | null, catalog: Catalog = builtinCatalog()): ModelPricing | null {
  if (!modelKey) return null;
  const exact = catalog.get(modelKey);
  if (exact) return exact;
  if (/^gpt-5(?:[.-]\d+)?$/.test(modelKey)) return catalog.get("gpt-5") ?? null;
  if (modelKey.includes("codex")) return catalog.get("gpt-5-codex") ?? null;
  if (modelKey.startsWith("claude-fable-5")) return catalog.get("claude-fable-5") ?? null;
  if (modelKey.startsWith("claude-haiku-4")) return catalog.get("claude-haiku-4-5") ?? null;
  if (modelKey.startsWith("claude-opus-4")) return catalog.get("claude-opus-4-5") ?? null;
  if (modelKey.startsWith("claude-sonnet-4")) return catalog.get("claude-sonnet-4") ?? null;
  return null;
}

// Cost of one component, applying the above-200k tier when the row defines it.
function componentCost(tokens: number, base: number | null, above200k?: number | null): number | null {
  if (base === null) return null;
  if (!above200k || tokens <= 200_000) return (tokens * base) / 1_000_000;
  return (200_000 * base + (tokens - 200_000) * above200k) / 1_000_000;
}

export interface EstimateInput {
  modelKey: string | null;
  promptTokens?: number | null; // INCLUSIVE of cache
  completionTokens?: number | null;
  cacheCreationInputTokens?: number | null;
  cacheReadInputTokens?: number | null;
  estimatedTokens?: number; // byte-estimate count; used when promptTokens is absent
}

// Token counts → USD. Returns all-null when the model is unpriced (unknown ≠ $0).
export function estimateCost(input: EstimateInput, catalog: Catalog = builtinCatalog()): CostEstimate {
  const pricing = pricingForModel(input.modelKey, catalog);
  if (!pricing) {
    return { inputUsd: null, outputUsd: null, cacheCreationUsd: null, cacheReadUsd: null, totalUsd: null, pricingSource: null };
  }
  const prompt = input.promptTokens ?? input.estimatedTokens ?? 0;
  const cacheCreation = input.cacheCreationInputTokens ?? 0;
  const cacheRead = input.cacheReadInputTokens ?? 0;
  const freshInput = Math.max(0, prompt - cacheCreation - cacheRead);

  const inputUsd = componentCost(freshInput, pricing.inputPerMillionUsd, pricing.inputAbove200kPerMillionUsd);
  const outputUsd =
    input.completionTokens === null || input.completionTokens === undefined
      ? null
      : componentCost(input.completionTokens, pricing.outputPerMillionUsd, pricing.outputAbove200kPerMillionUsd);
  const cacheCreationUsd = componentCost(cacheCreation, pricing.cacheCreationPerMillionUsd, pricing.cacheCreationAbove200kPerMillionUsd);
  const cacheReadUsd = componentCost(cacheRead, pricing.cacheReadPerMillionUsd, pricing.cacheReadAbove200kPerMillionUsd);

  const parts = [inputUsd, outputUsd, cacheCreationUsd, cacheReadUsd].filter((v): v is number => v !== null);
  const totalUsd = parts.length === 0 ? null : parts.reduce((s, v) => s + v, 0) * pricing.fastMultiplier;
  return { inputUsd, outputUsd, cacheCreationUsd, cacheReadUsd, totalUsd, pricingSource: pricing.pricingSource };
}

// --- live refresh (built-in + cache) ----------------------------------------

// LiteLLM is the comprehensive community price feed; it is the refresh source.
// (models.dev can be added as a secondary later — different nested schema.)
const LITELLM_URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

function cachePath(): string {
  return join(storageDir(), "pricing-cache.json");
}

function perMillion(dollarsPerToken: unknown): number | null {
  const n = typeof dollarsPerToken === "number" ? dollarsPerToken : Number(dollarsPerToken);
  return Number.isFinite(n) ? n * 1_000_000 : null;
}

// Parse the LiteLLM price feed into catalog rows (keys lowercased).
export function parseLiteLlm(input: unknown): Map<string, ModelPricing> {
  const out = new Map<string, ModelPricing>();
  if (!input || typeof input !== "object") return out;
  for (const [rawKey, rawVal] of Object.entries(input as Record<string, unknown>)) {
    const key = normalizeModelName(rawKey);
    const row = rawVal as Record<string, unknown> | null;
    if (!key || !row || typeof row !== "object") continue;
    const inputPerMillionUsd = perMillion(row.input_cost_per_token);
    const outputPerMillionUsd = perMillion(row.output_cost_per_token);
    if (inputPerMillionUsd === null && outputPerMillionUsd === null) continue;
    out.set(
      key,
      withCacheDefaults({
        provider: typeof row.litellm_provider === "string" ? row.litellm_provider : inferModelProvider(key),
        inputPerMillionUsd,
        outputPerMillionUsd,
        cacheCreationPerMillionUsd: perMillion(row.cache_creation_input_token_cost),
        cacheReadPerMillionUsd: perMillion(row.cache_read_input_token_cost),
        inputAbove200kPerMillionUsd: perMillion(row.input_cost_per_token_above_200k_tokens),
        outputAbove200kPerMillionUsd: perMillion(row.output_cost_per_token_above_200k_tokens),
        fastMultiplier: 1,
        pricingSource: "litellm",
      }),
    );
  }
  return out;
}

interface PricingCacheFile {
  fetchedAt: number;
  version: string;
  models: Record<string, ModelPricing>;
}

// Fetch upstream prices and write the cache. Network is the ONLY place that can
// fail here; on any error we leave the existing cache untouched and rethrow so
// the caller (lb cost --refresh) can report it. Reads never need this.
export async function refreshCatalog(): Promise<{ count: number; version: string }> {
  const merged = builtinCatalog();
  try {
    const res = await fetch(LITELLM_URL);
    if (res.ok) for (const [k, v] of parseLiteLlm(await res.json())) merged.set(k, v);
  } catch {
    // models.dev is a best-effort secondary; ignore network failure of either.
  }
  const version = `refresh_${Date.now()}`;
  const file: PricingCacheFile = { fetchedAt: Date.now(), version, models: Object.fromEntries(merged) };
  writeFileSync(cachePath(), JSON.stringify(file));
  return { count: merged.size, version };
}

// Load the active catalog (built-in, overlaid by the refresh cache if present).
// Synchronous so index-time pricing stays sync. Returns the catalog + a version
// stamp used to memoize/guard reprices.
export function loadCatalog(): { catalog: Map<string, ModelPricing>; version: string } {
  const merged = builtinCatalog();
  let version = BUILTIN_CATALOG_VERSION;
  try {
    const file = JSON.parse(readFileSync(cachePath(), "utf8")) as PricingCacheFile;
    if (file && file.models) {
      for (const [k, v] of Object.entries(file.models)) merged.set(k, v);
      version = file.version ?? version;
    }
  } catch {
    // no cache yet → built-in only
  }
  return { catalog: merged, version };
}

// Days since the refresh cache was written (Infinity if none) — lets callers
// decide whether to auto-refresh.
export function cacheAgeDays(): number {
  try {
    const ms = Date.now() - statSync(cachePath()).mtimeMs;
    return ms / 86_400_000;
  } catch {
    return Infinity;
  }
}
