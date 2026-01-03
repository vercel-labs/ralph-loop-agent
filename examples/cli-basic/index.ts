#!/usr/bin/env npx tsx
/**
 * CLI Example: Math Problem Solver
 *
 * This example demonstrates using RalphLoopAgent to solve multi-step math problems.
 * The agent keeps iterating until it has verified the solution is correct.
 *
 * Usage:
 *   npx tsx index.ts
 *   npx tsx index.ts "What is the 15th fibonacci number?"
 *
 * Environment:
 *   ANTHROPIC_API_KEY - Your Anthropic API key
 */

import {
  RalphLoopAgent,
  iterationCountIs,
  type VerifyCompletionContext,
} from 'ralph-wiggum';
import { tool } from 'ai';
import { z } from 'zod';

type Tools = typeof tools;

// ANSI color codes for terminal output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  magenta: '\x1b[35m',
  blue: '\x1b[34m',
};

function log(message: string, color: keyof typeof colors = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function logSection(title: string) {
  console.log();
  log(`━━━ ${title} ━━━`, 'cyan');
}

// Define tools for the agent
const tools = {
  calculate: tool({
    description:
      'Perform a mathematical calculation. Supports basic arithmetic, powers, roots, etc.',
    inputSchema: z.object({
      expression: z.string().describe('A mathematical expression to evaluate, e.g. "2 + 2" or "Math.pow(2, 10)"'),
    }),
    execute: async ({ expression }) => {
      try {
        // Safe evaluation of mathematical expressions
        const sanitized = expression.replace(/[^0-9+\-*/().Math\s,powsqrtabsfloorceillogs]/gi, '');
        const result = eval(sanitized);
        return { success: true, result: Number(result) };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    },
  }),

  storeResult: tool({
    description: 'Store an intermediate result with a label for later reference',
    inputSchema: z.object({
      label: z.string().describe('A label for the stored value'),
      value: z.number().describe('The numeric value to store'),
    }),
    execute: async ({ label, value }) => {
      log(`  📦 Stored: ${label} = ${value}`, 'dim');
      return { stored: true, label, value };
    },
  }),

  verifyAnswer: tool({
    description: 'Verify that the final answer is correct by double-checking the calculation',
    inputSchema: z.object({
      problem: z.string().describe('The original problem'),
      answer: z.number().describe('The proposed answer'),
      verification: z.string().describe('Explanation of how the answer was verified'),
    }),
    execute: async ({ problem, answer, verification }) => {
      log(`  ✅ Verified: ${answer}`, 'green');
      return { verified: true, problem, answer, verification };
    },
  }),
};

async function main() {
  // Get the problem from command line args or use default
  const problem = process.argv[2] || 'Calculate the sum of the first 10 prime numbers';

  log('╔════════════════════════════════════════════════════════════╗', 'magenta');
  log('║         Ralph Wiggum Agent - Math Problem Solver           ║', 'magenta');
  log('╚════════════════════════════════════════════════════════════╝', 'magenta');

  logSection('Problem');
  log(problem, 'bright');

  // Track tool calls for verification
  let hasVerifiedAnswer = false;
  let finalAnswer: number | null = null;

  // Create the agent
  const agent = new RalphLoopAgent({
    model: 'anthropic/claude-sonnet-4-20250514' as any,
    instructions: `You are a precise mathematical problem solver.

Your task is to solve math problems step by step:
1. Break down the problem into smaller steps
2. Use the calculate tool to perform arithmetic
3. Use storeResult to keep track of intermediate values
4. When you have the final answer, use verifyAnswer to confirm it
5. After verification, state the final answer clearly

Always verify your answer before finishing. Say "VERIFIED" when you've confirmed the answer.`,

    tools,

    // Maximum 5 iterations before giving up
    stopWhen: iterationCountIs(5),

    // Verify completion when the answer has been verified
    verifyCompletion: async ({ result }: VerifyCompletionContext<Tools>) => {
      // Check if the model has verified its answer
      const text = result.text.toLowerCase();
      const isVerified = text.includes('verified') || hasVerifiedAnswer;

      if (isVerified && finalAnswer !== null) {
        return {
          complete: true,
          reason: `Answer verified: ${finalAnswer}`,
        };
      }

      return {
        complete: false,
        reason: 'Please verify your answer using the verifyAnswer tool before completing.',
      };
    },

    // Log iteration progress
    onIterationStart: ({ iteration }: { iteration: number }) => {
      logSection(`Iteration ${iteration}`);
    },

    onIterationEnd: ({ iteration, duration, result }: { iteration: number; duration: number; result: any }) => {
      log(`  ⏱️  Duration: ${duration}ms`, 'dim');

      // Track verification
      for (const step of result.steps) {
        for (const toolResult of step.toolResults) {
          if (
            toolResult.toolName === 'verifyAnswer' &&
            typeof toolResult.output === 'object' &&
            toolResult.output !== null &&
            'verified' in toolResult.output
          ) {
            hasVerifiedAnswer = (toolResult.output as { verified: boolean }).verified;
            finalAnswer = (toolResult.output as { answer: number }).answer;
          }
        }
      }

      // Show a snippet of the response
      if (result.text) {
        const preview = result.text.slice(0, 200) + (result.text.length > 200 ? '...' : '');
        log(`  💭 ${preview}`, 'dim');
      }
    },
  });

  logSection('Starting Agent');
  log('The agent will iterate until the answer is verified...', 'dim');

  try {
    const startTime = Date.now();
    const result = await agent.loop({ prompt: problem });
    const totalDuration = Date.now() - startTime;

    logSection('Result');
    log(`Completion: ${result.completionReason}`, 'green');
    log(`Iterations: ${result.iterations}`, 'blue');
    log(`Total time: ${totalDuration}ms`, 'blue');

    if (result.reason) {
      log(`Reason: ${result.reason}`, 'yellow');
    }

    logSection('Final Answer');
    console.log(result.text);

    // Summary of tool usage
    logSection('Tool Usage Summary');
    let totalToolCalls = 0;
    for (const iterResult of result.allResults) {
      for (const step of iterResult.steps) {
        totalToolCalls += step.toolCalls.length;
      }
    }
    log(`Total tool calls: ${totalToolCalls}`, 'cyan');
  } catch (error) {
    logSection('Error');
    console.error(error);
    process.exit(1);
  }
}

main();
