#!/usr/bin/env npx tsx
/**
 * Ralph Wiggum CLI Example - Autonomous Coding Agent
 *
 * A general-purpose agent for long-running autonomous coding tasks like:
 * - Code migrations (Jest → Vitest, CJS → ESM, etc.)
 * - Dependency upgrades
 * - Refactoring across large codebases
 * - Creating new features from specifications
 * - Fixing bugs across multiple files
 *
 * All code runs in a secure Vercel Sandbox - NO access to your local filesystem.
 *
 * Usage:
 *   npx tsx index.ts /path/to/repo                    # Interactive mode or uses PROMPT.md
 *   npx tsx index.ts /path/to/repo "Your task"        # Uses provided prompt
 *   npx tsx index.ts /path/to/repo ./task.md          # Uses prompt from file
 *
 * Environment:
 *   ANTHROPIC_API_KEY - Your Anthropic API key
 *   SANDBOX_VERCEL_TOKEN - Vercel API token for sandbox
 *   SANDBOX_VERCEL_TEAM_ID - Vercel team ID
 *   SANDBOX_VERCEL_PROJECT_ID - Vercel project ID
 */

// Load environment variables from .env file
import 'dotenv/config';

import { RalphLoopAgent, iterationCountIs, type VerifyCompletionContext } from 'ralph-wiggum';
import * as fs from 'fs/promises';
import * as path from 'path';
import prompts from 'prompts';

import { log, logSection } from './lib/logger.js';
import { MAX_FILE_CHARS } from './lib/constants.js';
import { initializeSandbox, closeSandbox, readFromSandbox, getSandboxDomain } from './lib/sandbox.js';
import { getTaskPrompt } from './lib/interview.js';
import { createCodingAgentTools, type CodingTools } from './lib/tools/coding.js';
import { runJudge } from './lib/judge.js';

// Get CLI arguments
const targetDir = process.argv[2];
const promptArg = process.argv[3];

if (!targetDir) {
  console.error('Usage: npx tsx index.ts <target-directory> [prompt or prompt-file]');
  console.error('');
  console.error('Examples:');
  console.error('  npx tsx index.ts ~/Developer/myproject                     # Interactive mode');
  console.error('  npx tsx index.ts ~/Developer/myproject "Add TypeScript"    # Uses provided prompt');
  console.error('  npx tsx index.ts ~/Developer/myproject ./task.md           # Uses prompt from file');
  process.exit(1);
}

const resolvedDir = path.resolve(targetDir.replace('~', process.env.HOME || ''));

// Check required env vars
const requiredEnvVars = ['SANDBOX_VERCEL_TOKEN', 'SANDBOX_VERCEL_TEAM_ID', 'SANDBOX_VERCEL_PROJECT_ID'];
for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.error(`Error: ${envVar} environment variable is required`);
    console.error('');
    console.error('Required environment variables:');
    console.error('  SANDBOX_VERCEL_TOKEN     - Your Vercel API token');
    console.error('  SANDBOX_VERCEL_TEAM_ID   - Your Vercel team ID');
    console.error('  SANDBOX_VERCEL_PROJECT_ID - Your Vercel project ID');
    process.exit(1);
  }
}

// Track completion state
let taskSummary = '';
let pendingJudgeReview = false;
let lastFilesModified: string[] = [];

async function main() {
  log('╔════════════════════════════════════════════════════════════╗', 'magenta');
  log('║      Ralph Wiggum CLI Example - Autonomous Coding Agent    ║', 'magenta');
  log('║                  🔒 Secure Sandbox Mode 🔒                  ║', 'magenta');
  log('╚════════════════════════════════════════════════════════════╝', 'magenta');

  // Check if local directory exists, offer to create if not
  try {
    await fs.access(resolvedDir);
  } catch {
    const { createDir } = await prompts({
      type: 'confirm',
      name: 'createDir',
      message: `Directory does not exist: ${resolvedDir}\n  Create it?`,
      initial: true,
    });

    if (!createDir) {
      log('Cancelled.', 'yellow');
      process.exit(0);
    }

    await fs.mkdir(resolvedDir, { recursive: true });
    log(`✓ Created ${resolvedDir}`, 'green');
  }

  logSection('Configuration');
  log(`Local target: ${resolvedDir}`, 'bright');
  log(`⚠️  All code runs in an isolated sandbox`, 'yellow');
  log(`   Changes will be copied back when complete`, 'dim');

  // Initialize sandbox and copy files
  logSection('Sandbox Setup');
  await initializeSandbox(resolvedDir);

  const sandboxDomain = getSandboxDomain();

  // Load AGENTS.md if it exists
  let agentsMd = '';
  try {
    const content = await readFromSandbox('AGENTS.md');
    if (content) {
      agentsMd = content;
      log(`Found AGENTS.md`, 'dim');
    }
  } catch {
    // No AGENTS.md, that's fine
  }

  // Get the task prompt (may run interactive interview)
  const { prompt: taskPrompt, source: promptSource } = await getTaskPrompt(promptArg);

  log(`Prompt source: ${promptSource}`, 'dim');
  
  logSection('Task');
  // Show first 500 chars of prompt, or full if shorter
  const promptPreview = taskPrompt.length > 500 
    ? taskPrompt.slice(0, 500) + '...' 
    : taskPrompt;
  log(promptPreview, 'bright');

  // Confirm before starting
  console.log();
  const { confirmed } = await prompts({
    type: 'confirm',
    name: 'confirmed',
    message: 'Start the agent?',
    initial: true,
  });

  if (!confirmed) {
    log('Cancelled.', 'yellow');
    await closeSandbox(resolvedDir);
    process.exit(0);
  }

  // Build instructions with optional AGENTS.md
  const baseInstructions = `You are an expert software engineer. Your task is to complete coding tasks autonomously.

All your work happens in an isolated sandbox environment. You have full access to modify files and run commands.

## Guidelines:
1. First, explore the codebase to understand its structure (list files, read key files like package.json, README, etc.)
2. Plan your approach before making changes
3. Make incremental changes - modify one file at a time
4. After making changes, verify they work (run tests, type-check, lint, etc.)
5. When the task is complete and verified, use markComplete to finish

## CRITICAL - Package Versions:
Before adding ANY new dependency, you MUST check the latest version using:
  npm view <package-name> version

Then use that exact version. NEVER guess or use outdated versions.

## Best Practices:
- Always read a file before modifying it
- For SMALL CHANGES (fixing imports, renaming, type errors), use editFile instead of writeFile
- editFile is more token-efficient and prevents full file rewrites
- For LARGE FILES, use lineStart/lineEnd in readFile to read specific sections
- Run tests frequently to catch issues early
- Be thorough but efficient
- You can start a dev server with startDevServer and test it with curl

Sandbox dev server URL: ${sandboxDomain}`;

  const instructions = agentsMd 
    ? `${baseInstructions}\n\n## Project-Specific Instructions (from AGENTS.md)\n\n${agentsMd}`
    : baseInstructions;

  const tools = createCodingAgentTools();

  const agent = new RalphLoopAgent({
    model: 'anthropic/claude-opus-4.5' as any,
    instructions,
    tools,

    // Enable context management to handle long conversations
    contextManagement: {
      maxContextTokens: 180_000,
      enableSummarization: true,
      recentIterationsToKeep: 2,
      maxFileChars: MAX_FILE_CHARS,
      changeLogBudget: 8_000,
      fileContextBudget: 60_000,
    },

    stopWhen: iterationCountIs(20),

    verifyCompletion: async ({ result, originalPrompt }: VerifyCompletionContext<CodingTools>) => {
      // Check if markComplete was called
      for (const step of result.steps) {
        for (const toolResult of step.toolResults) {
          if (
            toolResult.toolName === 'markComplete' &&
            typeof toolResult.output === 'object' &&
            toolResult.output !== null &&
            'complete' in toolResult.output
          ) {
            pendingJudgeReview = true;
            taskSummary = (toolResult.output as any).summary;
            lastFilesModified = (toolResult.output as any).filesModified || [];
          }
        }
      }

      // If markComplete was called, run the judge
      if (pendingJudgeReview) {
        pendingJudgeReview = false;
        
        const judgeResult = await runJudge(
          originalPrompt,
          taskSummary,
          lastFilesModified
        );

        if (judgeResult.approved) {
          log('  📤 Task approved by judge!', 'green');
          return {
            complete: true,
            reason: `Task complete: ${taskSummary}\n\nJudge verdict: ${judgeResult.feedback}`,
          };
        } else {
          // Judge requested changes - feed back to the agent
          log('  📤 Sending judge feedback to coding agent...', 'yellow');
          log(`     Feedback preview: ${judgeResult.feedback.slice(0, 150)}...`, 'dim');
          return {
            complete: false,
            reason: `The judge reviewed your work and requested changes:\n\n${judgeResult.feedback}\n\nPlease address these issues and use markComplete again when done.`,
          };
        }
      }

      return {
        complete: false,
        reason: 'Continue working on the task. Use markComplete when finished and verified.',
      };
    },

    onIterationStart: ({ iteration }: { iteration: number }) => {
      logSection(`Iteration ${iteration}`);
    },

    onIterationEnd: ({ iteration, duration }: { iteration: number; duration: number }) => {
      log(`  ⏱️  Duration: ${duration}ms`, 'dim');
    },

    onContextSummarized: ({ iteration, summarizedIterations, tokensSaved }: { iteration: number; summarizedIterations: number; tokensSaved: number }) => {
      log(`  📝 Context summarized: ${summarizedIterations} iterations compressed, ${tokensSaved} tokens available`, 'yellow');
    },
  });

  logSection('Starting Task');
  log('The agent will iterate until the task is complete...', 'dim');
  log(`Dev server URL: ${sandboxDomain}`, 'blue');

  const startTime = Date.now();

  try {
    const result = await agent.loop({
      prompt: taskPrompt,
    });

    const totalDuration = Date.now() - startTime;

    logSection('Result');
    log(`Status: ${result.completionReason}`, result.completionReason === 'verified' ? 'green' : 'yellow');
    log(`Iterations: ${result.iterations}`, 'blue');
    log(`Total time: ${Math.round(totalDuration / 1000)}s`, 'blue');

    if (result.reason) {
      logSection('Summary');
      log(result.reason, 'bright');
    }

    logSection('Final Notes');
    console.log(result.text);

  } catch (error) {
    logSection('Error');
    console.error(error);
    await closeSandbox(resolvedDir);
    process.exit(1);
  } finally {
    await closeSandbox(resolvedDir);
  }
}

main();
