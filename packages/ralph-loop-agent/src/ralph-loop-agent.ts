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
  aggregateStepUsage,
  type RalphStopCondition,
  type RalphStopConditionContext,
} from './ralph-stop-condition';
import {
  RalphContextManager,
  estimateMessageTokens,
} from './ralph-context-manager';

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

  /**
   * If true, preserve context from previous loop() calls instead of clearing.
   * Useful for resuming after an abort.
   */
  preserveContext?: boolean;

  /**
   * Starting iteration number (for resuming). Defaults to 0.
   */
  startIteration?: number;
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

  /**
   * Aggregated token usage across all iterations.
   */
  readonly totalUsage: LanguageModelUsage;
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
  private readonly contextManager: RalphContextManager | null;

  constructor(settings: RalphLoopAgentSettings<TOOLS>) {
    this.settings = settings;
    
    // Initialize context manager if configured
    this.contextManager = settings.contextManagement
      ? new RalphContextManager(settings.contextManagement)
      : null;
  }

  /**
   * Get the context manager (if enabled).
   */
  getContextManager(): RalphContextManager | null {
    return this.contextManager;
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
   * Check if the current model is an Anthropic model (for prompt caching).
   */
  private isAnthropicModel(): boolean {
    const model = this.settings.model;
    if (typeof model === 'string') {
      return model.includes('anthropic') || model.includes('claude');
    }
    return (
      model.provider === 'anthropic' ||
      model.provider?.includes('anthropic') ||
      model.modelId?.includes('anthropic') ||
      model.modelId?.includes('claude')
    );
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
    preserveContext = false,
    startIteration = 0,
  }: RalphLoopAgentCallParameters): Promise<RalphLoopAgentResult<TOOLS>> {
    const allResults: Array<GenerateTextResult<TOOLS, never>> = [];
    let currentMessages: Array<ModelMessage> = [];
    let iteration = startIteration;
    let totalUsage: LanguageModelUsage = this.createEmptyUsage();
    let completionReason: RalphLoopAgentResult<TOOLS>['completionReason'] = 'max-iterations';
    let reason: string | undefined;

    const stopConditions = this.getStopConditions();
    const modelId = this.getModelId();
    const model = this.settings.model;

    // Reset context manager for new loop (unless preserving context for resume)
    if (!preserveContext) {
      this.contextManager?.clear();
    }

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

      // Prepare messages with context management
      let messagesToSend: Array<ModelMessage>;
      let summarized = false;

      if (this.contextManager) {
        // Use context manager to prepare messages
        const prepared = await this.contextManager.prepareMessagesForIteration(
          currentMessages,
          iteration,
          model,
          allResults[allResults.length - 1]
        );
        
        messagesToSend = [
          ...systemMessages,
          initialUserMessage,
          ...prepared.messages,
        ];
        summarized = prepared.summarized;

        // If we summarized, notify
        if (summarized && this.settings.onContextSummarized) {
          const budget = this.contextManager.getTokenBudget();
          await this.settings.onContextSummarized({
            iteration,
            summarizedIterations: iteration - (this.settings.contextManagement?.recentIterationsToKeep ?? 2),
            tokensSaved: budget.available,
          });
        }

        // Add context injection (summaries, change log)
        const contextInjection = this.contextManager.buildContextInjection();
        if (contextInjection) {
          // Append to last system message or create new one
          if (systemMessages.length > 0) {
            const lastSystem = messagesToSend.find(m => m.role === 'system');
            if (lastSystem && typeof lastSystem.content === 'string') {
              lastSystem.content += contextInjection;
            }
          } else {
            messagesToSend.unshift({
              role: 'system',
              content: contextInjection,
            });
          }
        }
      } else {
        // No context management - use messages as-is
        messagesToSend = [
          ...systemMessages,
          initialUserMessage,
          ...currentMessages,
        ];
      }

      // If not the first iteration, add continuation prompt
      if (iteration > 1) {
        messagesToSend.push({
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Continue working on the task. The previous attempt was not complete.',
            },
          ],
        });
      }

      // Estimate tokens before sending (for debugging/monitoring)
      if (this.contextManager) {
        const estimatedTokens = messagesToSend.reduce(
          (sum, m) => sum + estimateMessageTokens(m),
          0
        );
        const budget = this.contextManager.getTokenBudget();
        
        // Log warning if approaching limit
        if (estimatedTokens > budget.total * 0.9) {
          console.warn(
            `[RalphLoopAgent] Warning: Estimated ${estimatedTokens} tokens, approaching limit of ${budget.total}`
          );
        }
      }

      // Create prepareStep that adds cache control for Anthropic models
      const isAnthropic = this.isAnthropicModel();
      const userPrepareStep = this.settings.prepareStep;
      
      // Helper to add cache control to last message
      const addCacheControlToMessages = (messages: ModelMessage[]): ModelMessage[] => {
        if (messages.length === 0) return messages;
        
        return messages.map((message: ModelMessage, index: number) => {
          if (index === messages.length - 1) {
            return {
              ...message,
              providerOptions: {
                ...message.providerOptions,
                anthropic: {
                  ...(message.providerOptions?.anthropic as Record<string, unknown> ?? {}),
                  cacheControl: { type: 'ephemeral' },
                },
              },
            };
          }
          return message;
        });
      };
      
      const prepareStepWithCaching: typeof userPrepareStep = isAnthropic
        ? async (stepInfo) => {
            // First apply user's prepareStep if provided
            const userResult = userPrepareStep ? await userPrepareStep(stepInfo) : {};
            const messages = userResult?.messages ?? stepInfo.messages;
            
            // Add cache control to the last message for Anthropic
            const cacheControlMessages = addCacheControlToMessages(messages);
            return { ...userResult, messages: cacheControlMessages };
          }
        : userPrepareStep;

      // Run the inner tool loop
      const result = (await generateText({
        model: this.settings.model,
        messages: messagesToSend,
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
        prepareStep: prepareStepWithCaching,
        experimental_repairToolCall: this.settings.experimental_repairToolCall,
        providerOptions: this.settings.providerOptions,
        experimental_context: this.settings.experimental_context,
        abortSignal,
      })) as GenerateTextResult<TOOLS, never>;

      allResults.push(result);

      // Update total usage - aggregate from steps for more accurate counts
      const iterationUsage = aggregateStepUsage(result);
      totalUsage = addLanguageModelUsage(totalUsage, iterationUsage);

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

          // Track feedback in context manager
          this.contextManager?.addChangeLogEntry({
            type: 'observation',
            summary: 'Verification feedback received',
            details: verification.reason.slice(0, 200),
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
      totalUsage,
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
      const iterationUsage = aggregateStepUsage(result);
      totalUsage = addLanguageModelUsage(totalUsage, iterationUsage);
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
   * Streams ALL iterations of the agent loop.
   *
   * Unlike stream() which only streams the final iteration, streamAll() yields
   * a stream for EVERY iteration, enabling real-time UI updates as the agent
   * works through multiple iterations.
   *
   * @example
   * ```typescript
   * const generator = agent.streamAll({ prompt: 'Do the task' });
   *
   * for await (const { iteration, stream, isLast } of generator) {
   *   console.log(`Streaming iteration ${iteration}`);
   *   for await (const chunk of stream) {
   *     // Process chunks from this iteration
   *   }
   * }
   *
   * const result = await generator.return?.value;
   * ```
   */
  async *streamAll({
    prompt,
    abortSignal,
  }: RalphLoopAgentCallParameters): AsyncGenerator<
    {
      iteration: number;
      stream: StreamTextResult<TOOLS, never>;
      isLast: boolean;
    },
    RalphLoopAgentResult<TOOLS>
  > {
    const allResults: Array<GenerateTextResult<TOOLS, never>> = [];
    let currentMessages: Array<ModelMessage> = [];
    let iteration = 0;
    let totalUsage: LanguageModelUsage = this.createEmptyUsage();
    let completionReason: RalphLoopAgentResult<TOOLS>['completionReason'] = 'max-iterations';
    let reason: string | undefined;

    const stopConditions = this.getStopConditions();
    const modelId = this.getModelId();

    const initialUserMessage: ModelMessage = {
      role: 'user',
      content: [{ type: 'text', text: prompt }],
    };

    const systemMessages = this.buildSystemMessages();

    // Reset context manager
    this.contextManager?.clear();

    while (true) {
      if (abortSignal?.aborted) {
        completionReason = 'aborted';
        break;
      }

      iteration++;
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

      // Check if NEXT iteration would hit stop condition
      const nextStopContext: RalphStopConditionContext<TOOLS> = {
        iteration: iteration + 1,
        allResults,
        totalUsage,
        model: modelId,
      };
      const wouldStopNext = await isRalphStopConditionMet({ stopConditions, context: nextStopContext });

      // Stream THIS iteration
      const streamResult = streamText({
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
      }) as StreamTextResult<TOOLS, never>;

      // Yield the stream to the caller
      yield {
        iteration,
        stream: streamResult,
        isLast: wouldStopNext,
      };

      // After caller consumes the stream, collect the final result
      // We need to wait for the stream to complete
      const text = await streamResult.text;
      const usage = await streamResult.usage;
      const response = await streamResult.response;

      // Extract tool calls from response messages for verification
      const steps: Array<{ toolCalls?: Array<{ toolName: string; args: unknown }> }> = [];
      for (const msg of response.messages) {
        if (msg.role === 'assistant' && Array.isArray(msg.content)) {
          const toolCalls: Array<{ toolName: string; args: unknown }> = [];
          for (const part of msg.content) {
            if (part.type === 'tool-call') {
              toolCalls.push({
                toolName: part.toolName,
                args: (part as unknown as { toolName: string; args: unknown }).args,
              });
            }
          }
          if (toolCalls.length > 0) {
            steps.push({ toolCalls });
          }
        }
      }

      // Convert stream result to a GenerateTextResult-like structure for storage
      // We only need the fields that verifyCompletion uses
      const iterationResult = {
        text,
        usage,
        response,
        steps,
      } as unknown as GenerateTextResult<TOOLS, never>;

      allResults.push(iterationResult);
      totalUsage = addLanguageModelUsage(totalUsage, usage);
      currentMessages = [...currentMessages, ...response.messages];

      const duration = Date.now() - startTime;
      await this.settings.onIterationEnd?.({ iteration, duration, result: iterationResult });

      // Check stop conditions
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
          result: iterationResult,
          iteration,
          allResults,
          originalPrompt: prompt,
        });

        if (verification.complete) {
          completionReason = 'verified';
          reason = verification.reason;
          break;
        }

        if (verification.reason) {
          currentMessages.push({
            role: 'user',
            content: [{ type: 'text', text: `Feedback: ${verification.reason}` }],
          });

          this.contextManager?.addChangeLogEntry({
            type: 'observation',
            summary: 'Verification feedback received',
            details: verification.reason.slice(0, 200),
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
      totalUsage,
    };
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
