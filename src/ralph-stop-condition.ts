import type { GenerateTextResult, ToolSet } from 'ai';
import type { LanguageModelUsage } from 'ai';

/**
 * Context passed to stop condition functions.
 */
export type RalphStopConditionContext<TOOLS extends ToolSet = {}> = {
  /**
   * Current iteration number (1-indexed).
   */
  iteration: number;

  /**
   * All results from completed iterations.
   */
  allResults: Array<GenerateTextResult<TOOLS, never>>;

  /**
   * Aggregated token usage across all iterations.
   */
  totalUsage: LanguageModelUsage;

  /**
   * The model identifier (e.g., 'anthropic/claude-opus-4.5').
   */
  model: string;
};

/**
 * A function that determines when to stop the Ralph loop.
 * Return true to stop, false to continue.
 */
export type RalphStopCondition<TOOLS extends ToolSet = {}> = (
  context: RalphStopConditionContext<TOOLS>
) => PromiseLike<boolean> | boolean;

/**
 * Cost rates per million tokens.
 */
export type CostRates = {
  inputCostPerMillionTokens: number;
  outputCostPerMillionTokens: number;
};

/**
 * Pricing for common models (cost per million tokens in USD).
 */
const MODEL_PRICING: Record<string, CostRates> = {
  // Anthropic
  'anthropic/claude-opus-4.5': { inputCostPerMillionTokens: 5.0, outputCostPerMillionTokens: 25.0 },
  'anthropic/claude-sonnet-4': { inputCostPerMillionTokens: 3.0, outputCostPerMillionTokens: 15.0 },
  'anthropic/claude-haiku': { inputCostPerMillionTokens: 0.25, outputCostPerMillionTokens: 1.25 },
  // OpenAI
  'openai/gpt-4o': { inputCostPerMillionTokens: 2.5, outputCostPerMillionTokens: 10.0 },
  'openai/gpt-4o-mini': { inputCostPerMillionTokens: 0.15, outputCostPerMillionTokens: 0.6 },
  'openai/gpt-4-turbo': { inputCostPerMillionTokens: 10.0, outputCostPerMillionTokens: 30.0 },
  'openai/o1': { inputCostPerMillionTokens: 15.0, outputCostPerMillionTokens: 60.0 },
  'openai/o1-mini': { inputCostPerMillionTokens: 1.1, outputCostPerMillionTokens: 4.4 },
  'openai/o3-mini': { inputCostPerMillionTokens: 1.1, outputCostPerMillionTokens: 4.4 },
  // Google
  'google/gemini-2.5-pro': { inputCostPerMillionTokens: 1.25, outputCostPerMillionTokens: 10.0 },
  'google/gemini-2.5-flash': { inputCostPerMillionTokens: 0.15, outputCostPerMillionTokens: 0.6 },
  'google/gemini-2.0-flash': { inputCostPerMillionTokens: 0.1, outputCostPerMillionTokens: 0.4 },
  // xAI
  'xai/grok-3': { inputCostPerMillionTokens: 3.0, outputCostPerMillionTokens: 15.0 },
  'xai/grok-3-mini': { inputCostPerMillionTokens: 0.3, outputCostPerMillionTokens: 0.5 },
  // DeepSeek
  'deepseek/deepseek-chat': { inputCostPerMillionTokens: 0.14, outputCostPerMillionTokens: 0.28 },
  'deepseek/deepseek-reasoner': { inputCostPerMillionTokens: 0.55, outputCostPerMillionTokens: 2.19 },
};

/**
 * Get pricing for a model.
 */
export function getModelPricing(model: string): CostRates | undefined {
  return MODEL_PRICING[model];
}

/**
 * Helper to add two token counts (handles undefined).
 */
function addTokenCounts(
  a: number | undefined,
  b: number | undefined
): number | undefined {
  if (a == null && b == null) return undefined;
  return (a ?? 0) + (b ?? 0);
}

/**
 * Add two usage objects together.
 */
export function addLanguageModelUsage(
  usage1: LanguageModelUsage,
  usage2: LanguageModelUsage
): LanguageModelUsage {
  return {
    inputTokens: addTokenCounts(usage1.inputTokens, usage2.inputTokens),
    inputTokenDetails: {
      noCacheTokens: addTokenCounts(
        usage1.inputTokenDetails?.noCacheTokens,
        usage2.inputTokenDetails?.noCacheTokens
      ),
      cacheReadTokens: addTokenCounts(
        usage1.inputTokenDetails?.cacheReadTokens,
        usage2.inputTokenDetails?.cacheReadTokens
      ),
      cacheWriteTokens: addTokenCounts(
        usage1.inputTokenDetails?.cacheWriteTokens,
        usage2.inputTokenDetails?.cacheWriteTokens
      ),
    },
    outputTokens: addTokenCounts(usage1.outputTokens, usage2.outputTokens),
    outputTokenDetails: {
      textTokens: addTokenCounts(
        usage1.outputTokenDetails?.textTokens,
        usage2.outputTokenDetails?.textTokens
      ),
      reasoningTokens: addTokenCounts(
        usage1.outputTokenDetails?.reasoningTokens,
        usage2.outputTokenDetails?.reasoningTokens
      ),
    },
    totalTokens: addTokenCounts(usage1.totalTokens, usage2.totalTokens),
  };
}

/**
 * Calculate cost from usage and rates.
 */
export function calculateCost(usage: LanguageModelUsage, rates: CostRates): number {
  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  return (
    (inputTokens / 1_000_000) * rates.inputCostPerMillionTokens +
    (outputTokens / 1_000_000) * rates.outputCostPerMillionTokens
  );
}

/**
 * Stop when iteration count reaches the specified number.
 *
 * @example
 * ```ts
 * stopWhen: iterationCountIs(50)
 * ```
 */
export function iterationCountIs(count: number): RalphStopCondition<any> {
  return ({ iteration }) => iteration >= count;
}

/**
 * Stop when total token count reaches the specified number.
 *
 * @example
 * ```ts
 * stopWhen: tokenCountIs(100_000)
 * ```
 */
export function tokenCountIs(maxTokens: number): RalphStopCondition<any> {
  return ({ totalUsage }) => (totalUsage.totalTokens ?? 0) >= maxTokens;
}

/**
 * Stop when input token count reaches the specified number.
 *
 * @example
 * ```ts
 * stopWhen: inputTokenCountIs(50_000)
 * ```
 */
export function inputTokenCountIs(maxTokens: number): RalphStopCondition<any> {
  return ({ totalUsage }) => (totalUsage.inputTokens ?? 0) >= maxTokens;
}

/**
 * Stop when output token count reaches the specified number.
 *
 * @example
 * ```ts
 * stopWhen: outputTokenCountIs(50_000)
 * ```
 */
export function outputTokenCountIs(maxTokens: number): RalphStopCondition<any> {
  return ({ totalUsage }) => (totalUsage.outputTokens ?? 0) >= maxTokens;
}

/**
 * Stop when cost reaches the specified amount in USD.
 *
 * Can infer pricing from the model, use an explicit model, or provide custom rates.
 *
 * @example
 * ```ts
 * // Infer from agent's model
 * stopWhen: costIs(2.00)
 *
 * // Explicit model
 * stopWhen: costIs(2.00, 'anthropic/claude-sonnet-4')
 *
 * // Custom rates
 * stopWhen: costIs(2.00, {
 *   inputCostPerMillionTokens: 3.00,
 *   outputCostPerMillionTokens: 15.00
 * })
 * ```
 */
export function costIs(
  maxCostDollars: number,
  ratesOrModel?: CostRates | string
): RalphStopCondition<any> {
  return ({ totalUsage, model }) => {
    let rates: CostRates;

    if (typeof ratesOrModel === 'object') {
      // Explicit rates provided
      rates = ratesOrModel;
    } else {
      // Look up model pricing
      const modelToUse = typeof ratesOrModel === 'string' ? ratesOrModel : model;
      const pricing = getModelPricing(modelToUse);

      if (!pricing) {
        throw new Error(
          `Unknown model "${modelToUse}". Provide explicit rates:\n` +
            `costIs(${maxCostDollars}, { inputCostPerMillionTokens: X, outputCostPerMillionTokens: Y })`
        );
      }

      rates = pricing;
    }

    const currentCost = calculateCost(totalUsage, rates);
    return currentCost >= maxCostDollars;
  };
}

/**
 * Check if any stop condition is met.
 */
export async function isRalphStopConditionMet<TOOLS extends ToolSet>({
  stopConditions,
  context,
}: {
  stopConditions: Array<RalphStopCondition<TOOLS>>;
  context: RalphStopConditionContext<TOOLS>;
}): Promise<boolean> {
  const results = await Promise.all(
    stopConditions.map((condition) => condition(context))
  );
  return results.some((result) => result);
}

