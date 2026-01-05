#!/usr/bin/env npx tsx
/**
 * Ralph CLI Example - Autonomous Coding Agent
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

import { RalphLoopAgent, iterationCountIs, addLanguageModelUsage, type VerifyCompletionContext } from 'ralph-loop-agent';
import type { LanguageModelUsage, GenerateTextResult } from 'ai';
import * as fs from 'fs/promises';
import * as path from 'path';
import prompts from 'prompts';

import { log, logSection, logUsageReport } from './lib/logger.js';
import { MAX_FILE_CHARS } from './lib/constants.js';
import { initializeSandbox, closeSandbox, readFromSandbox, getSandboxDomain } from './lib/sandbox.js';
import { getTaskPrompt, runInterviewAndGetPrompt } from './lib/interview.js';
import { createCodingAgentTools, type CodingTools } from './lib/tools/coding.js';
import { runJudge } from './lib/judge.js';
import { 
  isGitHubUrl, 
  parseGitHubUrl, 
  getTaskDir, 
  cloneRepo, 
  createPullRequestWorkflow 
} from './lib/git.js';

// Get CLI arguments
const targetArg = process.argv[2];
const promptArg = process.argv[3];

if (!targetArg) {
  console.error('Usage: npx tsx index.ts <target-directory-or-repo> [prompt or prompt-file]');
  console.error('');
  console.error('Examples:');
  console.error('  npx tsx index.ts ~/Developer/myproject                     # Local directory');
  console.error('  npx tsx index.ts https://github.com/owner/repo             # Clone from GitHub');
  console.error('  npx tsx index.ts ~/Developer/myproject "Add TypeScript"    # With prompt');
  console.error('  npx tsx index.ts ~/Developer/myproject ./task.md           # With prompt file');
  process.exit(1);
}

// Detect if target is a GitHub URL or local path
const isRepoUrl = isGitHubUrl(targetArg);
let resolvedDir: string;
let repoInfo: { owner: string; repo: string; url: string } | null = null;

if (isRepoUrl) {
  const parsed = parseGitHubUrl(targetArg);
  if (!parsed) {
    console.error(`Error: Could not parse GitHub URL: ${targetArg}`);
    process.exit(1);
  }
  repoInfo = { ...parsed, url: targetArg };
  // Will be set after cloning
  resolvedDir = '';
} else {
  resolvedDir = path.resolve(targetArg.replace('~', process.env.HOME || ''));
}

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

// Track sandbox state for cleanup
let sandboxInitialized = false;
let isCleaningUp = false;
let interruptPending = false;
let interruptResolver: ((action: 'continue' | 'followup' | 'save' | 'quit') => void) | null = null;
let followUpPrompt = '';

// Cleanup function - just closes sandbox, doesn't copy files
async function cleanup(exitCode: number = 0) {
  if (isCleaningUp) return;
  isCleaningUp = true;
  
  if (sandboxInitialized) {
    log('\n  [~] Closing sandbox (changes NOT saved)...', 'yellow');
    try {
      // Close without copying files back
      const { closeSandboxWithoutCopy } = await import('./lib/sandbox.js');
      await closeSandboxWithoutCopy();
      log('  [+] Sandbox closed', 'green');
    } catch (error) {
      log(`  [x] Error closing sandbox: ${error}`, 'red');
    }
  }
  
  process.exit(exitCode);
}

// Save files and cleanup
async function saveAndCleanup(exitCode: number = 0) {
  if (isCleaningUp) return;
  isCleaningUp = true;
  
  if (sandboxInitialized) {
    log('\n  [~] Saving changes and closing sandbox...', 'yellow');
    try {
      await closeSandbox(resolvedDir);
      log('  [+] Changes saved, sandbox closed', 'green');
    } catch (error) {
      log(`  [x] Error: ${error}`, 'red');
    }
  }
  
  process.exit(exitCode);
}

// Show interrupt menu
async function showInterruptMenu(): Promise<'continue' | 'followup' | 'save' | 'quit'> {
  console.log('\n');
  log('  ╔═══════════════════════════════════════╗', 'yellow');
  log('  ║           INTERRUPTED (Ctrl+C)         ║', 'yellow');
  log('  ╚═══════════════════════════════════════╝', 'yellow');
  log('  Press Ctrl+C again to force quit\n', 'dim');
  
  const { action } = await prompts({
    type: 'select',
    name: 'action',
    message: 'What would you like to do?',
    choices: [
      { title: 'Continue', description: 'Resume the current task', value: 'continue' },
      { title: 'Follow up', description: 'Send a message to the agent', value: 'followup' },
      { title: 'Save & exit', description: 'Copy files back and exit', value: 'save' },
      { title: 'Quit', description: 'Exit WITHOUT saving changes', value: 'quit' },
    ],
  }, {
    onCancel: () => {
      // Don't exit on Ctrl+C during menu, just return continue
      return false;
    }
  });
  
  if (action === 'followup') {
    const { message } = await prompts({
      type: 'text',
      name: 'message',
      message: 'Enter your follow-up message:',
    }, {
      onCancel: () => false
    });
    followUpPrompt = message || '';
    if (!followUpPrompt) {
      return 'continue'; // No message entered, just continue
    }
  }
  
  return action || 'continue';
}

// SIGINT handling - track count instead of timing to avoid race conditions
let menuCtrlCCount = 0;

const menuSigintHandler = () => {
  menuCtrlCCount++;
  if (menuCtrlCCount >= 2) {
    log('\n\n  [!] Force quit', 'red');
    process.exit(130);
  }
  log('\n  [!] Press Ctrl+C again to force quit', 'yellow');
};

const mainSigintHandler = async () => {
  if (interruptPending) {
    menuSigintHandler();
    return;
  }
  
  interruptPending = true;
  menuCtrlCCount = 0;
  
  // Swap to menu handler while menu is showing
  process.removeListener('SIGINT', mainSigintHandler);
  process.on('SIGINT', menuSigintHandler);
  
  try {
    const action = await showInterruptMenu();
    interruptPending = false;
    
    // Restore main handler
    process.removeListener('SIGINT', menuSigintHandler);
    process.on('SIGINT', mainSigintHandler);
    
    if (action === 'quit') {
      await cleanup(130);
    } else if (action === 'save') {
      await saveAndCleanup(0);
    } else if (action === 'continue' || action === 'followup') {
      if (interruptResolver) {
        interruptResolver(action);
        interruptResolver = null;
      }
      log('  [>] Resuming...', 'green');
    }
  } catch {
    interruptPending = false;
    process.removeListener('SIGINT', menuSigintHandler);
    process.on('SIGINT', mainSigintHandler);
    log('  [>] Resuming...', 'green');
  }
};

process.on('SIGINT', mainSigintHandler);

process.on('SIGTERM', () => {
  log('\n\n  [!] Terminated', 'yellow');
  cleanup(143);
});

// Handle uncaught errors
process.on('uncaughtException', async (error) => {
  log(`\n\n  [x] Uncaught exception: ${error.message}`, 'red');
  console.error(error);
  await saveAndCleanup(1);
});

process.on('unhandledRejection', async (reason) => {
  log(`\n\n  [x] Unhandled rejection: ${reason}`, 'red');
  await saveAndCleanup(1);
});

// Export for use in agent loop
export function getFollowUpPrompt(): string {
  const prompt = followUpPrompt;
  followUpPrompt = '';
  return prompt;
}

// Track running token usage
let runningUsage: LanguageModelUsage = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  inputTokenDetails: {
    noCacheTokens: undefined,
    cacheReadTokens: undefined,
    cacheWriteTokens: undefined,
  },
  outputTokenDetails: {
    textTokens: undefined,
    reasoningTokens: undefined,
  },
};

const AGENT_MODEL = 'anthropic/claude-opus-4.5';

async function main() {
  log('╔════════════════════════════════════════════════════════════╗', 'magenta');
  log('║         Ralph CLI Example - Autonomous Coding Agent        ║', 'magenta');
  log('╚════════════════════════════════════════════════════════════╝', 'magenta');

  logSection('Configuration');
  
  if (repoInfo) {
    // GitHub repo mode
    log(`Repository: ${repoInfo.url}`, 'bright');
    log(`  [i] Repo will be cloned when task starts`, 'dim');
    log(`  [i] Changes will create a PR when complete`, 'dim');
    // Set a placeholder - will be updated after cloning
    resolvedDir = getTaskDir(repoInfo.owner, repoInfo.repo);
    log(`  [i] Task dir: ${resolvedDir}`, 'dim');
  } else {
    // Local directory mode
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
      log(`  [+] Created ${resolvedDir}`, 'green');
    }
    
    log(`Local target: ${resolvedDir}`, 'bright');
    log(`  [!] All code runs in an isolated sandbox`, 'yellow');
    log(`      Changes will be copied back when complete`, 'dim');
  }

  // Clone repo early if using GitHub URL (needed for PROMPT.md check and Plan Mode)
  if (repoInfo) {
    logSection('Cloning Repository');
    await cloneRepo(repoInfo.url, resolvedDir);
  }

  // Get the task prompt (works the same for local path or cloned repo)
  let taskPrompt: string;
  let promptSource: string;

  // Track if user already confirmed via Plan Mode approval
  let alreadyConfirmed = false;

  const promptResult = await getTaskPrompt(promptArg, resolvedDir);

  if ('needsInterview' in promptResult) {
    // Interview mode now uses just-bash with OverlayFs for read-only exploration
    // No sandbox needed - it reads directly from the local filesystem
    const interviewResult = await runInterviewAndGetPrompt(
      promptResult.localDir,
      async (filename: string, content: string) => {
        // Write to local directory during interview phase
        const pathModule = await import('path');
        const fsModule = await import('fs/promises');
        const filePath = pathModule.join(resolvedDir, filename);
        await fsModule.writeFile(filePath, content, 'utf-8');
      }
    );
    taskPrompt = interviewResult.prompt;
    promptSource = interviewResult.source;
    // User already approved in Plan Mode, no need to ask again
    alreadyConfirmed = true;
  } else {
    taskPrompt = promptResult.prompt;
    promptSource = promptResult.source;
  }

  log(`Prompt source: ${promptSource}`, 'dim');
  
  logSection('Task');
  // Show first 500 chars of prompt, or full if shorter
  const promptPreview = taskPrompt.length > 500 
    ? taskPrompt.slice(0, 500) + '...' 
    : taskPrompt;
  log(promptPreview, 'bright');

  // Only ask for confirmation if we didn't already get approval via Plan Mode
  if (!alreadyConfirmed) {
    console.log();
    const { confirmed } = await prompts({
      type: 'confirm',
      name: 'confirmed',
      message: 'Start the agent?',
      initial: true,
    });

    if (!confirmed) {
      log('Cancelled.', 'yellow');
      process.exit(0);
    }
  }

  // Create sandbox now - only when the actual task begins
  logSection('Sandbox Setup');
  await initializeSandbox(resolvedDir);
  sandboxInitialized = true;

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

  // Build instructions with optional AGENTS.md
  const baseInstructions = `You are an expert software engineer. Your task is to complete coding tasks autonomously.

All your work happens in an isolated sandbox environment. You have full access to modify files and run commands.

## FIRST STEPS (do these IMMEDIATELY):
1. List files to see the project structure
2. Call detectPackageManager to determine the right package manager (npm/yarn/pnpm/bun)
3. If there's a package.json (or requirements.txt for Python), IMMEDIATELY install dependencies
4. Start the dev server in the background so you can take screenshots and test the app
5. THEN proceed with the task

Example first steps for a JS/TS project:
  detectPackageManager() → returns { commands: { install: 'pnpm install', run: 'pnpm run' } }
  runCommand({ command: 'pnpm install', background: false })
  startDevServer({ command: 'pnpm run dev' })

## Guidelines:
1. Explore the codebase to understand its structure (read key files like package.json, README, etc.)
2. Take a screenshot early to see the current state of the app
3. Plan your approach before making changes
4. Make incremental changes - modify one file at a time
5. After making changes, verify they work (run tests, type-check, lint, take screenshots)
6. When the task is complete and verified, use markComplete to finish

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
- Use takeScreenshot to visually verify UI changes
- Be thorough but efficient

## NEVER DO THIS:
- NEVER use \`cat > file << 'EOF'\` or heredocs to create files - use writeFile tool instead
- NEVER use \`echo "..." > file\` to create files - use writeFile tool instead
- NEVER use shell commands to create or modify files - always use the file tools (writeFile, editFile)
- Using cat/echo wastes tokens and bypasses proper file tracking

Sandbox dev server URL: ${sandboxDomain}`;

  const instructions = agentsMd 
    ? `${baseInstructions}\n\n## Project-Specific Instructions (from AGENTS.md)\n\n${agentsMd}`
    : baseInstructions;

  const tools = createCodingAgentTools();

  const agent = new RalphLoopAgent({
    model: AGENT_MODEL,
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

        // Add judge usage to running total
        runningUsage = addLanguageModelUsage(runningUsage, judgeResult.usage);

        if (judgeResult.approved) {
          log('  [+] Task approved by judge!', 'green');
          return {
            complete: true,
            reason: `Task complete: ${taskSummary}\n\nJudge verdict: ${judgeResult.feedback}`,
          };
        } else {
          // Judge requested changes - feed back to the agent
          log('  [>] Sending judge feedback to coding agent...', 'yellow');
          log(`      Feedback preview: ${judgeResult.feedback.slice(0, 150)}...`, 'dim');
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

    onIterationEnd: ({ iteration, duration, result }: { iteration: number; duration: number; result: GenerateTextResult<CodingTools, never> }) => {
      log(`      Duration: ${duration}ms`, 'dim');
      
      // Update running usage
      runningUsage = addLanguageModelUsage(runningUsage, result.usage);
      
      // Show usage report for this iteration
      logUsageReport(result.usage, AGENT_MODEL, `Iteration ${iteration}`);
      logUsageReport(runningUsage, AGENT_MODEL, 'Running Total');
    },

    onContextSummarized: ({ iteration, summarizedIterations, tokensSaved }: { iteration: number; summarizedIterations: number; tokensSaved: number }) => {
      log(`  [~] Context summarized: ${summarizedIterations} iterations compressed, ${tokensSaved} tokens available`, 'yellow');
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

    // Show final usage report
    logSection('Final Usage Report');
    logUsageReport(result.totalUsage, AGENT_MODEL, 'Total');

    if (result.reason) {
      logSection('Summary');
      log(result.reason, 'bright');
    }

    logSection('Final Notes');
    console.log(result.text);

    // Handle successful completion
    if (result.completionReason === 'verified') {
      if (repoInfo && taskSummary) {
        // Repo mode: close sandbox (copies files back), then create PR
        await closeSandbox(resolvedDir);
        sandboxInitialized = false;
        
        // Create PR workflow (on host, not sandbox)
        try {
          const { branchName, prUrl } = await createPullRequestWorkflow(
            resolvedDir,
            taskPrompt,
            taskSummary
          );
          
          if (prUrl) {
            logSection('Pull Request');
            log(`Branch: ${branchName}`, 'blue');
            log(`PR: ${prUrl}`, 'green');
          }
        } catch (error) {
          log(`  [!] Failed to create PR: ${error}`, 'yellow');
        }
        
        process.exit(0);
      } else {
        // Local mode: save changes back to local directory
        await saveAndCleanup(0);
      }
    } else {
      // Not verified (max iterations, aborted, etc.) - don't auto-save
      await cleanup(0);
    }

  } catch (error) {
    logSection('Error');
    console.error(error);
    await cleanup(1);
  }
}

main();
