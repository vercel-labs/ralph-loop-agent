/**
 * Claude Code Provider for Ralph Loop Agent
 *
 * This provider allows using your Claude Max subscription instead of API keys
 * by spawning Claude Code as a subprocess via the official Claude Agent SDK.
 *
 * Prerequisites:
 * - Claude Code CLI installed and authenticated (`claude auth login`)
 * - @anthropic-ai/claude-agent-sdk package installed
 *
 * @example
 * ```typescript
 * import { runWithClaudeCode } from 'ralph-loop-agent/providers/claude-code';
 *
 * const result = await runWithClaudeCode({
 *   prompt: 'Fix all TypeScript errors in the project',
 *   maxTurns: 10,
 *   tools: { readFile, writeFile },
 *   verifyCompletion: async ({ text }) => ({
 *     complete: text.includes('All errors fixed'),
 *   }),
 * });
 * ```
 */

import { query, type SDKMessage, type SDKResultMessage, type Options as SDKOptions } from '@anthropic-ai/claude-agent-sdk';

/**
 * Options for running with Claude Code subscription
 */
export interface ClaudeCodeOptions {
  /**
   * The prompt/task to complete
   */
  prompt: string;

  /**
   * Maximum number of turns (iterations) before stopping
   * @default 10
   */
  maxTurns?: number;

  /**
   * Model to use. If omitted, uses Claude Code's default.
   */
  model?: string;

  /**
   * Working directory for the agent
   * @default process.cwd()
   */
  cwd?: string;

  /**
   * Permission mode for tool usage
   * - 'default': Prompts for dangerous operations
   * - 'acceptEdits': Auto-accept file edits
   * - 'bypassPermissions': Skip all permission checks (dangerous)
   * @default 'acceptEdits'
   */
  permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions';

  /**
   * System prompt to append to Claude Code's default
   */
  systemPromptAppend?: string;

  /**
   * Verification function called after each turn
   */
  verifyCompletion?: (params: {
    text: string;
    turn: number;
    allMessages: SDKMessage[];
  }) => Promise<VerifyResult> | VerifyResult;

  /**
   * Callback at start of each turn
   */
  onTurnStart?: (params: { turn: number }) => void | Promise<void>;

  /**
   * Callback at end of each turn
   */
  onTurnEnd?: (params: { turn: number; message: SDKMessage }) => void | Promise<void>;

  /**
   * Additional SDK options passed to the Claude Agent SDK
   */
  sdkOptions?: Partial<SDKOptions>;
}

export interface VerifyResult {
  complete: boolean;
  reason?: string;
}

export interface ClaudeCodeResult {
  /**
   * The final text output
   */
  text: string;

  /**
   * Number of turns executed
   */
  turns: number;

  /**
   * Why the loop stopped
   */
  completionReason: 'verified' | 'max-turns' | 'error';

  /**
   * Reason message from verification
   */
  reason?: string;

  /**
   * Total cost in USD (from Claude subscription, not billed separately)
   */
  cost?: number;

  /**
   * All SDK messages from the execution
   */
  allMessages: SDKMessage[];
}

/**
 * Run a task using Claude Code subscription (no API key required)
 *
 * This function spawns Claude Code as a subprocess, using your authenticated
 * Claude account. All usage is covered by your Claude Max subscription.
 *
 * @example
 * ```typescript
 * const result = await runWithClaudeCode({
 *   prompt: 'Create a new React component',
 *   maxTurns: 5,
 *   verifyCompletion: ({ text }) => ({
 *     complete: text.includes('Component created'),
 *   }),
 * });
 * ```
 */
export async function runWithClaudeCode(options: ClaudeCodeOptions): Promise<ClaudeCodeResult> {
  const {
    prompt,
    maxTurns = 10,
    model,
    cwd = process.cwd(),
    permissionMode = 'acceptEdits',
    systemPromptAppend,
    verifyCompletion,
    onTurnStart,
    onTurnEnd,
    sdkOptions = {},
  } = options;

  const allMessages: SDKMessage[] = [];
  let turn = 0;
  let lastText = '';
  let completionReason: ClaudeCodeResult['completionReason'] = 'max-turns';
  let reason: string | undefined;
  let cost: number | undefined;

  // Build system prompt
  const systemPrompt = systemPromptAppend
    ? {
        type: 'preset' as const,
        preset: 'claude_code' as const,
        append: systemPromptAppend,
      }
    : undefined;

  try {
    const queryGenerator = query({
      prompt,
      options: {
        maxTurns,
        model,
        cwd,
        permissionMode,
        systemPrompt,
        ...sdkOptions,
      },
    });

    for await (const message of queryGenerator) {
      allMessages.push(message);

      // Track turns via assistant messages
      if (message.type === 'assistant') {
        turn++;
        await onTurnStart?.({ turn });

        // Extract text from assistant message
        const content = (message as any).message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text' && block.text) {
              lastText = block.text;
            }
          }
        }

        await onTurnEnd?.({ turn, message });

        // Check verification
        if (verifyCompletion) {
          const verification = await verifyCompletion({
            text: lastText,
            turn,
            allMessages,
          });

          if (verification.complete) {
            completionReason = 'verified';
            reason = verification.reason;
            await queryGenerator.interrupt();
            break;
          }

          // Feedback is handled by continuing the loop
        }
      }

      // Handle final result
      if (message.type === 'result') {
        const resultMsg = message as SDKResultMessage;

        if (resultMsg.subtype === 'success') {
          lastText = resultMsg.result;
          cost = resultMsg.total_cost_usd;
          if (completionReason !== 'verified') {
            completionReason = 'verified';
          }
        } else if (resultMsg.subtype === 'error_max_turns') {
          completionReason = 'max-turns';
          cost = resultMsg.total_cost_usd;
        } else {
          completionReason = 'error';
          reason = resultMsg.errors?.join(', ');
          cost = resultMsg.total_cost_usd;
        }
      }
    }
  } catch (error: any) {
    return {
      text: lastText,
      turns: turn,
      completionReason: 'error',
      reason: error.message,
      allMessages,
    };
  }

  return {
    text: lastText,
    turns: turn,
    completionReason,
    reason,
    cost,
    allMessages,
  };
}

/**
 * Check if Claude Code is available (authenticated)
 */
export async function isClaudeCodeAvailable(): Promise<boolean> {
  try {
    // Try to import the SDK - if it fails, not installed
    await import('@anthropic-ai/claude-agent-sdk');
    return true;
  } catch {
    return false;
  }
}
