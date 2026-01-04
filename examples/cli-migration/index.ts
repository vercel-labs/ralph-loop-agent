#!/usr/bin/env npx tsx
/**
 * CLI Example: Code Migration Agent
 *
 * This example demonstrates using RalphLoopAgent to perform code migrations.
 * The agent iteratively modifies files until the migration is verified complete.
 *
 * Usage:
 *   npx tsx index.ts /path/to/repo                    # Uses PROMPT.md in repo
 *   npx tsx index.ts /path/to/repo "Your prompt"      # Uses provided prompt
 *   npx tsx index.ts /path/to/repo ./custom-prompt.md # Uses custom prompt file
 *
 * The prompt can be:
 *   1. A PROMPT.md file in the target directory (auto-detected)
 *   2. A string passed as the second argument
 *   3. A path to a .md file passed as the second argument
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
import * as fs from 'fs/promises';
import * as path from 'path';
import { glob } from 'glob';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// ANSI color codes
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  magenta: '\x1b[35m',
  blue: '\x1b[34m',
  red: '\x1b[31m',
};

function log(message: string, color: keyof typeof colors = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function logSection(title: string) {
  console.log();
  log(`━━━ ${title} ━━━`, 'cyan');
}

// Get CLI arguments
const targetDir = process.argv[2];
const promptArg = process.argv[3];

if (!targetDir) {
  console.error('Usage: npx tsx index.ts <target-directory> [prompt or prompt-file]');
  console.error('');
  console.error('Examples:');
  console.error('  npx tsx index.ts ~/Developer/myproject                    # Uses PROMPT.md in repo');
  console.error('  npx tsx index.ts ~/Developer/myproject "Migrate to Vitest" # Uses provided prompt');
  console.error('  npx tsx index.ts ~/Developer/myproject ./migration.md      # Uses prompt from file');
  process.exit(1);
}

const resolvedDir = path.resolve(targetDir.replace('~', process.env.HOME || ''));

/**
 * Get the migration prompt from various sources:
 * 1. CLI argument (string or path to .md file)
 * 2. PROMPT.md in the target directory
 * 3. Default fallback
 */
async function getMigrationPrompt(): Promise<{ prompt: string; source: string }> {
  // If a prompt argument was provided
  if (promptArg) {
    // Check if it's a path to a .md file
    if (promptArg.endsWith('.md')) {
      const promptPath = path.resolve(promptArg.replace('~', process.env.HOME || ''));
      try {
        const content = await fs.readFile(promptPath, 'utf-8');
        return { prompt: content.trim(), source: promptPath };
      } catch {
        // If file doesn't exist, treat it as a literal string
        return { prompt: promptArg, source: 'CLI argument' };
      }
    }
    // It's a literal prompt string
    return { prompt: promptArg, source: 'CLI argument' };
  }

  // Check for PROMPT.md in target directory
  const promptMdPath = path.join(resolvedDir, 'PROMPT.md');
  try {
    const content = await fs.readFile(promptMdPath, 'utf-8');
    return { prompt: content.trim(), source: promptMdPath };
  } catch {
    // No PROMPT.md found
  }

  // Default fallback
  return {
    prompt: 'Analyze this codebase and suggest improvements or migrations that could be made.',
    source: 'default',
  };
}

// Define tools for the migration agent
const tools = {
  listFiles: tool({
    description: 'List files in a directory matching a glob pattern',
    inputSchema: z.object({
      pattern: z.string().describe('Glob pattern like "**/*.js" or "tests/**/*"'),
    }),
    execute: async ({ pattern }) => {
      try {
        const files = await glob(pattern, { cwd: resolvedDir, nodir: true });
        log(`  📂 Found ${files.length} files matching "${pattern}"`, 'dim');
        return { success: true, files: files.slice(0, 50) }; // Limit to 50 files
      } catch (error) {
        return { success: false, error: String(error) };
      }
    },
  }),

  readFile: tool({
    description: 'Read the contents of a file',
    inputSchema: z.object({
      filePath: z.string().describe('Path to the file relative to the project root'),
    }),
    execute: async ({ filePath }) => {
      try {
        const fullPath = path.join(resolvedDir, filePath);
        const content = await fs.readFile(fullPath, 'utf-8');
        log(`  📖 Read: ${filePath} (${content.length} chars)`, 'dim');
        return { success: true, content };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    },
  }),

  writeFile: tool({
    description: 'Write content to a file (creates directories if needed)',
    inputSchema: z.object({
      filePath: z.string().describe('Path to the file relative to the project root'),
      content: z.string().describe('The content to write to the file'),
    }),
    execute: async ({ filePath, content }) => {
      try {
        const fullPath = path.join(resolvedDir, filePath);
        await fs.mkdir(path.dirname(fullPath), { recursive: true });
        await fs.writeFile(fullPath, content, 'utf-8');
        log(`  ✏️  Wrote: ${filePath}`, 'green');
        return { success: true, filePath };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    },
  }),

  deleteFile: tool({
    description: 'Delete a file',
    inputSchema: z.object({
      filePath: z.string().describe('Path to the file relative to the project root'),
    }),
    execute: async ({ filePath }) => {
      try {
        const fullPath = path.join(resolvedDir, filePath);
        await fs.unlink(fullPath);
        log(`  🗑️  Deleted: ${filePath}`, 'yellow');
        return { success: true, filePath };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    },
  }),

  runCommand: tool({
    description: 'Run a shell command in the project directory',
    inputSchema: z.object({
      command: z.string().describe('The shell command to run'),
    }),
    execute: async ({ command }) => {
      try {
        log(`  🔧 Running: ${command}`, 'blue');
        const { stdout, stderr } = await execAsync(command, {
          cwd: resolvedDir,
          timeout: 60000, // 60 second timeout
        });
        const output = stdout + (stderr ? `\nSTDERR: ${stderr}` : '');
        log(`  ✓ Command completed`, 'dim');
        return { success: true, output: output.slice(0, 5000) }; // Limit output
      } catch (error: any) {
        log(`  ✗ Command failed`, 'red');
        return {
          success: false,
          error: error.message,
          stdout: error.stdout?.slice(0, 2000),
          stderr: error.stderr?.slice(0, 2000),
        };
      }
    },
  }),

  markComplete: tool({
    description: 'Mark the migration as complete with a summary',
    inputSchema: z.object({
      summary: z.string().describe('Summary of changes made'),
      filesModified: z.array(z.string()).describe('List of files that were modified'),
    }),
    execute: async ({ summary, filesModified }) => {
      log(`  ✅ Migration marked complete`, 'green');
      return { complete: true, summary, filesModified };
    },
  }),
};

type Tools = typeof tools;

// Track completion
let migrationComplete = false;
let migrationSummary = '';

async function main() {
  log('╔════════════════════════════════════════════════════════════╗', 'magenta');
  log('║         Ralph Wiggum Agent - Code Migration                ║', 'magenta');
  log('╚════════════════════════════════════════════════════════════╝', 'magenta');

  // Verify directory exists
  try {
    await fs.access(resolvedDir);
  } catch {
    log(`Error: Directory does not exist: ${resolvedDir}`, 'red');
    process.exit(1);
  }

  // Get the migration prompt
  const { prompt: migrationPrompt, source: promptSource } = await getMigrationPrompt();

  logSection('Configuration');
  log(`Target: ${resolvedDir}`, 'bright');
  log(`Prompt source: ${promptSource}`, 'dim');
  
  logSection('Task');
  // Show first 500 chars of prompt, or full if shorter
  const promptPreview = migrationPrompt.length > 500 
    ? migrationPrompt.slice(0, 500) + '...' 
    : migrationPrompt;
  log(promptPreview, 'bright');

  const agent = new RalphLoopAgent({
    model: 'anthropic/claude-opus-4.5' as any,
    instructions: `You are a code migration expert. Your task is to migrate a codebase according to the user's instructions.

## Guidelines:
1. First, explore the codebase to understand its structure (list files, read key files like package.json)
2. Plan the migration steps
3. Make incremental changes - modify one file at a time
4. After making changes, verify they work by running tests if available
5. When the migration is complete and tests pass, use markComplete to finish

## CRITICAL - Package Versions:
Before adding ANY new dependency, you MUST check the latest version using:
  npm view <package-name> version

For example, before adding vitest:
  npm view vitest version

Then use that exact version in package.json. NEVER guess or use outdated versions.

## Important:
- Always read a file before modifying it
- Make sure to update package.json dependencies as needed
- Create any necessary config files (like vitest.config.ts)
- Run "npm install" or equivalent after modifying package.json
- Run tests to verify the migration works
- Be thorough but efficient

Current working directory: ${resolvedDir}`,

    tools,

    stopWhen: iterationCountIs(15),

    verifyCompletion: async ({ result }: VerifyCompletionContext<Tools>) => {
      // Check if markComplete was called
      for (const step of result.steps) {
        for (const toolResult of step.toolResults) {
          if (
            toolResult.toolName === 'markComplete' &&
            typeof toolResult.output === 'object' &&
            toolResult.output !== null &&
            'complete' in toolResult.output
          ) {
            migrationComplete = true;
            migrationSummary = (toolResult.output as any).summary;
          }
        }
      }

      if (migrationComplete) {
        return {
          complete: true,
          reason: `Migration complete: ${migrationSummary}`,
        };
      }

      return {
        complete: false,
        reason: 'Continue with the migration. Use markComplete when finished and tests pass.',
      };
    },

    onIterationStart: ({ iteration }: { iteration: number }) => {
      logSection(`Iteration ${iteration}`);
    },

    onIterationEnd: ({ iteration, duration }: { iteration: number; duration: number }) => {
      log(`  ⏱️  Duration: ${duration}ms`, 'dim');
    },
  });

  logSection('Starting Migration');
  log('The agent will iterate until the migration is complete...', 'dim');

  const startTime = Date.now();

  try {
    const result = await agent.loop({
      prompt: migrationPrompt,
    });

    const totalDuration = Date.now() - startTime;

    logSection('Migration Result');
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
    process.exit(1);
  }
}

main();

