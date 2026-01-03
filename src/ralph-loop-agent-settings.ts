import type {
  LanguageModel,
  ToolSet,
  GenerateTextResult,
  ToolChoice,
  StopCondition,
  PrepareStepFunction,
  ToolCallRepairFunction,
  TelemetrySettings,
  CallSettings,
} from 'ai';
import type { ProviderOptions, SystemModelMessage } from '@ai-sdk/provider-utils';
import type { VerifyCompletionFunction } from './ralph-loop-agent-evaluator';
import type { RalphStopCondition } from './ralph-stop-condition';

/**
 * Callback invoked at the start of each iteration.
 */
export type OnIterationStartCallback = (event: {
  /**
   * The iteration number (1-indexed).
   */
  readonly iteration: number;
}) => void | Promise<void>;

/**
 * Callback invoked at the end of each iteration.
 */
export type OnIterationEndCallback<TOOLS extends ToolSet = {}> = (event: {
  /**
   * The iteration number (1-indexed).
   */
  readonly iteration: number;

  /**
   * Duration of the iteration in milliseconds.
   */
  readonly duration: number;

  /**
   * The result of this iteration.
   */
  readonly result: GenerateTextResult<TOOLS, never>;
}) => void | Promise<void>;

/**
 * Configuration options for RalphLoopAgent.
 */
export type RalphLoopAgentSettings<TOOLS extends ToolSet = {}> = Omit<
  CallSettings,
  'abortSignal'
> & {
  /**
   * The id of the agent.
   */
  id?: string;

  /**
   * The instructions for the agent.
   * Can be a string, or a SystemModelMessage for provider-specific options.
   */
  instructions?: string | SystemModelMessage | Array<SystemModelMessage>;

  /**
   * The language model to use.
   */
  model: LanguageModel;

  /**
   * The tools that the model can call.
   */
  tools?: TOOLS;

  /**
   * The tool choice strategy. Default: 'auto'.
   */
  toolChoice?: ToolChoice<NoInfer<TOOLS>>;

  /**
   * When to stop the outer Ralph loop.
   *
   * Use helper functions like `iterationCountIs()`, `tokenCountIs()`, or `costIs()`.
   * Multiple conditions can be provided as an array (OR'd together).
   *
   * @default iterationCountIs(10)
   *
   * @example
   * ```ts
   * // Single condition
   * stopWhen: iterationCountIs(50)
   *
   * // Multiple conditions (stops when ANY is met)
   * stopWhen: [
   *   iterationCountIs(50),
   *   tokenCountIs(100_000),
   *   costIs(2.00),
   * ]
   * ```
   */
  stopWhen?: RalphStopCondition<NoInfer<TOOLS>> | Array<RalphStopCondition<NoInfer<TOOLS>>>;

  /**
   * When to stop the inner tool loop within each iteration.
   *
   * @default stepCountIs(20)
   */
  toolStopWhen?: StopCondition<NoInfer<TOOLS>> | Array<StopCondition<NoInfer<TOOLS>>>;

  /**
   * Function to verify if the task is complete.
   * Called after each iteration.
   */
  verifyCompletion?: VerifyCompletionFunction<NoInfer<TOOLS>>;

  /**
   * Optional telemetry configuration.
   */
  experimental_telemetry?: TelemetrySettings;

  /**
   * Limits the tools that are available for the model to call.
   */
  activeTools?: Array<keyof NoInfer<TOOLS>>;

  /**
   * Optional function to provide different settings for each step.
   */
  prepareStep?: PrepareStepFunction<NoInfer<TOOLS>>;

  /**
   * A function that attempts to repair a tool call that failed to parse.
   */
  experimental_repairToolCall?: ToolCallRepairFunction<NoInfer<TOOLS>>;

  /**
   * Called at the start of each iteration.
   */
  onIterationStart?: OnIterationStartCallback;

  /**
   * Called at the end of each iteration.
   */
  onIterationEnd?: OnIterationEndCallback<NoInfer<TOOLS>>;

  /**
   * Additional provider-specific options.
   */
  providerOptions?: ProviderOptions;

  /**
   * Context passed into tool calls.
   */
  experimental_context?: unknown;
};
