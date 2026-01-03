import type { GenerateTextResult, ToolSet } from 'ai';

/**
 * Context passed to verifyCompletion.
 */
export interface VerifyCompletionContext<TOOLS extends ToolSet = {}> {
  /**
   * The result of the current iteration.
   */
  readonly result: GenerateTextResult<TOOLS, never>;

  /**
   * The current iteration number (1-indexed).
   */
  readonly iteration: number;

  /**
   * All results from all iterations so far.
   */
  readonly allResults: Array<GenerateTextResult<TOOLS, never>>;

  /**
   * The original prompt/task.
   */
  readonly originalPrompt: string;
}

/**
 * Result of verifyCompletion.
 */
export interface VerifyCompletionResult {
  /**
   * Whether the task is complete.
   */
  readonly complete: boolean;

  /**
   * Optional reason or feedback.
   * - If complete=true, this explains why the task is done.
   * - If complete=false, this is used as feedback for the next iteration.
   */
  readonly reason?: string;
}

/**
 * Function to verify if the task is complete.
 */
export type VerifyCompletionFunction<TOOLS extends ToolSet = {}> = (
  context: VerifyCompletionContext<TOOLS>,
) => VerifyCompletionResult | Promise<VerifyCompletionResult>;
