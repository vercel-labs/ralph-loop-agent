import {
  generateText,
  streamText,
  stepCountIs,
  type GenerateTextResult,
  type StreamTextResult,
  type ToolSet,
  type LanguageModel,
  type LanguageModelUsage,
  type StopCondition,
} from 'ai';
import type { ModelMessage } from '@ai-sdk/provider-utils';
import type { RalphLoopAgentSettings } from './ralph-loop-agent-settings';
import type { VerifyCompletionResult } from './ralph-loop-agent-evaluator';
import {
  iterationCountIs,
  isRalphStopConditionMet,
  addLanguageModelUsage,
  type RalphStopCondition,
  type RalphStopConditionContext,
} from './ralph-stop-condition';

/**
 * Parameters for calling a RalphLoopAgent.
 */
export type RalphLoopAgentCallParameters = {
  /**
   * The prompt/task to complete.
   */
  prompt: string;

  /**
   * Abort signal for cancellation.
   */
  abortSignal?: AbortSignal;
};

/**
 * Result of a RalphLoopAgent execution.
 */
export interface RalphLoopAgentResult<TOOLS extends ToolSet = {}> {
  /**
   * The final text output.
   */
  readonly text: string;

  /**
   * The number of iterations that were executed.
   */
  readonly iterations: number;

  /**
   * Why the loop stopped.
   */
  readonly completionReason: 'verified' | 'max-iterations' | 'aborted';

  /**
   * The reason message from verifyCompletion (if provided).
   */
  readonly reason?: string;

  /**
   * The full result from the last iteration.
   */
  readonly result: GenerateTextResult<TOOLS, never>;

  /**
   * All results from each iteration.
   */
  readonly allResults: Array<GenerateTextResult<TOOLS, never>>;
}

// Re-export stop condition helpers
export { iterationCountIs } from './ralph-stop-condition';
export type { RalphStopCondition, RalphStopConditionContext } from './ralph-stop-condition';

/**
 * A Ralph Loop Agent implements the "Ralph Wiggum" technique - an iterative
 * approach that continuously runs until a task is completed.
 *
 * The agent has two nested loops:
 * 1. **Outer loop (Ralph loop)**: Runs iterations until verifyCompletion returns true
 * 2. **Inner loop (Tool loop)**: Executes tools and LLM calls within each iteration
 *
 * @example
 * ```typescript
 * const agent = new RalphLoopAgent({
 *   model: 'anthropic/claude-opus-4.5',
 *   instructions: 'You are a helpful assistant.',
 *   tools: { readFile, writeFile },
 *   stopWhen: iterationCountIs(10),
 *   verifyCompletion: async ({ result }) => ({
 *     complete: result.text.includes('DONE'),
 *     reason: 'Task completed',
 *   }),
 * });
 *
 * const result = await agent.loop({ prompt: 'Do the task' });
 * ```
 */
export class RalphLoopAgent<TOOLS extends ToolSet = {}> {
  readonly version = 'ralph-agent-v1';

  private readonly settings: RalphLoopAgentSettings<TOOLS>;

  constructor(settings: RalphLoopAgentSettings<TOOLS>) {
    this.settings = settings;
  }

  /**
   * The id of the agent.
   */
  get id(): string | undefined {
    return this.settings.id;
  }

  /**
   * The tools that the agent can use.
   */
  get tools(): TOOLS {
    return this.settings.tools as TOOLS;
  }

  /**
   * Get the model identifier string.
   */
  private getModelId(): string {
    const model = this.settings.model;
    // Handle both string models (gateway format) and LanguageModel objects
    if (typeof model === 'string') {
      return model;
    }
    return model.modelId ?? 'unknown';
  }

  /**
   * Get the stop conditions as an array.
   */
  private getStopConditions(): Array<RalphStopCondition<TOOLS>> {
    const stopWhen = this.settings.stopWhen;
    if (!stopWhen) {
      return [iterationCountIs(10)]; // default
    }
    return Array.isArray(stopWhen) ? stopWhen : [stopWhen];
  }

  /**
   * Create an empty usage object.
   */
  private createEmptyUsage(): LanguageModelUsage {
    return {
      inputTokens: 0,
      inputTokenDetails: {
        noCacheTokens: undefined,
        cacheReadTokens: undefined,
        cacheWriteTokens: undefined,
      },
      outputTokens: 0,
      outputTokenDetails: {
        textTokens: undefined,
        reasoningTokens: undefined,
      },
      totalTokens: 0,
    };
  }

  /**
   * Runs the agent loop until completion or stop condition is met.
   */
  async loop({
    prompt,
    abortSignal,
  }: RalphLoopAgentCallParameters): Promise<RalphLoopAgentResult<TOOLS>> {
    const allResults: Array<GenerateTextResult<TOOLS, never>> = [];
    let currentMessages: Array<ModelMessage> = [];
    let iteration = 0;
    let totalUsage: LanguageModelUsage = this.createEmptyUsage();
    let completionReason: RalphLoopAgentResult<TOOLS>['completionReason'] = 'max-iterations';
    let reason: string | undefined;

    const stopConditions = this.getStopConditions();
    const modelId = this.getModelId();

    // Build the initial user message
    const initialUserMessage: ModelMessage = {
      role: 'user',
      content: [{ type: 'text', text: prompt }],
    };

    // Add instructions as system message if provided
    const systemMessages = this.buildSystemMessages();

    // Loop until stop condition is met
    while (true) {
      // Check for abort
      if (abortSignal?.aborted) {
        completionReason = 'aborted';
        break;
      }

      iteration++;
      const startTime = Date.now();

      // Call onIterationStart
      await this.settings.onIterationStart?.({ iteration });

      // Build messages for this iteration
      const messages: Array<ModelMessage> = [
        ...systemMessages,
        initialUserMessage,
        ...currentMessages,
      ];

      // If not the first iteration, add continuation prompt
      if (iteration > 1) {
        messages.push({
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Continue working on the task. The previous attempt was not complete.',
            },
          ],
        });
      }

      // Run the inner tool loop
      const result = (await generateText({
        model: this.settings.model,
        messages,
        tools: this.settings.tools,
        toolChoice: this.settings.toolChoice,
        stopWhen: this.settings.toolStopWhen ?? stepCountIs(20),
        maxOutputTokens: this.settings.maxOutputTokens,
        temperature: this.settings.temperature,
        topP: this.settings.topP,
        topK: this.settings.topK,
        presencePenalty: this.settings.presencePenalty,
        frequencyPenalty: this.settings.frequencyPenalty,
        stopSequences: this.settings.stopSequences,
        seed: this.settings.seed,
        experimental_telemetry: this.settings.experimental_telemetry,
        activeTools: this.settings.activeTools,
        prepareStep: this.settings.prepareStep,
        experimental_repairToolCall: this.settings.experimental_repairToolCall,
        providerOptions: this.settings.providerOptions,
        experimental_context: this.settings.experimental_context,
        abortSignal,
      })) as GenerateTextResult<TOOLS, never>;

      allResults.push(result);

      // Update total usage
      totalUsage = addLanguageModelUsage(totalUsage, result.usage);

      // Add the response messages to conversation history
      currentMessages = [...currentMessages, ...result.response.messages];

      const duration = Date.now() - startTime;

      // Call onIterationEnd
      await this.settings.onIterationEnd?.({
        iteration,
        duration,
        result,
      });

      // Check stop conditions AFTER running iteration
      const stopContext: RalphStopConditionContext<TOOLS> = {
        iteration,
        allResults,
        totalUsage,
        model: modelId,
      };

      if (await isRalphStopConditionMet({ stopConditions, context: stopContext })) {
        completionReason = 'max-iterations';
        break;
      }

      // Verify completion
      if (this.settings.verifyCompletion) {
        const verification = await this.settings.verifyCompletion({
          result,
          iteration,
          allResults,
          originalPrompt: prompt,
        });

        if (verification.complete) {
          completionReason = 'verified';
          reason = verification.reason;
          break;
        }

        // If verification provides feedback, add it
        if (verification.reason && !verification.complete) {
          currentMessages.push({
            role: 'user',
            content: [
              {
                type: 'text',
                text: `Feedback: ${verification.reason}`,
              },
            ],
          });
        }
      }
    }

    const finalResult = allResults[allResults.length - 1]!;

    return {
      text: finalResult.text,
      iterations: iteration,
      completionReason,
      reason,
      result: finalResult,
      allResults,
    };
  }

  /**
   * Streams the agent loop. Streams only the final iteration.
   * For full control, use loop() with callbacks instead.
   */
  async stream({
    prompt,
    abortSignal,
  }: RalphLoopAgentCallParameters): Promise<StreamTextResult<TOOLS, never>> {
    const allResults: Array<GenerateTextResult<TOOLS, never>> = [];
    let currentMessages: Array<ModelMessage> = [];
    let iteration = 0;
    let totalUsage: LanguageModelUsage = this.createEmptyUsage();

    const stopConditions = this.getStopConditions();
    const modelId = this.getModelId();

    const initialUserMessage: ModelMessage = {
      role: 'user',
      content: [{ type: 'text', text: prompt }],
    };

    const systemMessages = this.buildSystemMessages();

    // Run non-streaming iterations until we should stream the final one
    while (true) {
      if (abortSignal?.aborted) {
        break;
      }

      iteration++;

      // Check if THIS iteration would be the last (next would hit stop condition)
      const nextStopContext: RalphStopConditionContext<TOOLS> = {
        iteration: iteration + 1,
        allResults,
        totalUsage,
        model: modelId,
      };

      // If next iteration would stop, stream this one instead
      if (await isRalphStopConditionMet({ stopConditions, context: nextStopContext })) {
        break;
      }

      const startTime = Date.now();

      await this.settings.onIterationStart?.({ iteration });

      const messages: Array<ModelMessage> = [
        ...systemMessages,
        initialUserMessage,
        ...currentMessages,
      ];

      if (iteration > 1) {
        messages.push({
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Continue working on the task. The previous attempt was not complete.',
            },
          ],
        });
      }

      const result = (await generateText({
        model: this.settings.model,
        messages,
        tools: this.settings.tools,
        toolChoice: this.settings.toolChoice,
        stopWhen: this.settings.toolStopWhen ?? stepCountIs(20),
        maxOutputTokens: this.settings.maxOutputTokens,
        temperature: this.settings.temperature,
        topP: this.settings.topP,
        topK: this.settings.topK,
        presencePenalty: this.settings.presencePenalty,
        frequencyPenalty: this.settings.frequencyPenalty,
        stopSequences: this.settings.stopSequences,
        seed: this.settings.seed,
        experimental_telemetry: this.settings.experimental_telemetry,
        activeTools: this.settings.activeTools,
        prepareStep: this.settings.prepareStep,
        experimental_repairToolCall: this.settings.experimental_repairToolCall,
        providerOptions: this.settings.providerOptions,
        experimental_context: this.settings.experimental_context,
        abortSignal,
      })) as GenerateTextResult<TOOLS, never>;

      allResults.push(result);
      totalUsage = addLanguageModelUsage(totalUsage, result.usage);
      currentMessages = [...currentMessages, ...result.response.messages];

      const duration = Date.now() - startTime;
      await this.settings.onIterationEnd?.({ iteration, duration, result });

      if (this.settings.verifyCompletion) {
        const verification = await this.settings.verifyCompletion({
          result,
          iteration,
          allResults,
          originalPrompt: prompt,
        });

        if (verification.complete) {
          // Complete early - return a stream for the final message
          return streamText({
            model: this.settings.model,
            messages: [...systemMessages, initialUserMessage, ...currentMessages],
            tools: this.settings.tools,
            toolChoice: this.settings.toolChoice,
            stopWhen: this.settings.toolStopWhen ?? stepCountIs(20),
            maxOutputTokens: this.settings.maxOutputTokens,
            temperature: this.settings.temperature,
            abortSignal,
          }) as StreamTextResult<TOOLS, never>;
        }

        if (verification.reason) {
          currentMessages.push({
            role: 'user',
            content: [{ type: 'text', text: `Feedback: ${verification.reason}` }],
          });
        }
      }
    }

    // Stream the final iteration
    iteration++;
    const finalMessages: Array<ModelMessage> = [
      ...systemMessages,
      initialUserMessage,
      ...currentMessages,
    ];

    if (iteration > 1) {
      finalMessages.push({
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Continue working on the task. The previous attempt was not complete.',
          },
        ],
      });
    }

    return streamText({
      model: this.settings.model,
      messages: finalMessages,
      tools: this.settings.tools,
      toolChoice: this.settings.toolChoice,
      stopWhen: this.settings.toolStopWhen ?? stepCountIs(20),
      maxOutputTokens: this.settings.maxOutputTokens,
      temperature: this.settings.temperature,
      topP: this.settings.topP,
      topK: this.settings.topK,
      presencePenalty: this.settings.presencePenalty,
      frequencyPenalty: this.settings.frequencyPenalty,
      stopSequences: this.settings.stopSequences,
      seed: this.settings.seed,
      experimental_telemetry: this.settings.experimental_telemetry,
      activeTools: this.settings.activeTools,
      prepareStep: this.settings.prepareStep,
      experimental_repairToolCall: this.settings.experimental_repairToolCall,
      providerOptions: this.settings.providerOptions,
      experimental_context: this.settings.experimental_context,
      abortSignal,
    }) as StreamTextResult<TOOLS, never>;
  }

  /**
   * Build system messages from instructions.
   */
  private buildSystemMessages(): Array<ModelMessage> {
    const { instructions } = this.settings;

    if (!instructions) {
      return [];
    }

    if (typeof instructions === 'string') {
      return [{ role: 'system', content: instructions }];
    }

    if (Array.isArray(instructions)) {
      return instructions;
    }

    return [instructions];
  }
}
