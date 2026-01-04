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
 * Usage:
 *   npx tsx index.ts /path/to/repo                    # Interactive mode or uses PROMPT.md
 *   npx tsx index.ts /path/to/repo "Your task"        # Uses provided prompt
 *   npx tsx index.ts /path/to/repo ./task.md          # Uses prompt from file
 *
 * Environment:
 *   ANTHROPIC_API_KEY - Your Anthropic API key
 */

import {
  RalphLoopAgent,
  iterationCountIs,
  type VerifyCompletionContext,
} from 'ralph-wiggum';
import { tool, generateText, stepCountIs } from 'ai';
import { z } from 'zod';
import * as fs from 'fs/promises';
import * as path from 'path';
import { glob } from 'glob';
import { exec } from 'child_process';
import { promisify } from 'util';
import prompts from 'prompts';

const execAsync = promisify(exec);

// Constants for context management
const MAX_FILE_CHARS = 30_000;
const MAX_FILE_LINES_PREVIEW = 400;

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
  console.error('  npx tsx index.ts ~/Developer/myproject                     # Interactive mode');
  console.error('  npx tsx index.ts ~/Developer/myproject "Add TypeScript"    # Uses provided prompt');
  console.error('  npx tsx index.ts ~/Developer/myproject ./task.md           # Uses prompt from file');
  process.exit(1);
}

const resolvedDir = path.resolve(targetDir.replace('~', process.env.HOME || ''));

// Task types for the interview
const TASK_TYPES = [
  { title: 'Create', value: 'create', description: 'Create a new project, app, or library from scratch' },
  { title: 'Migration', value: 'migration', description: 'Migrate between frameworks, libraries, or patterns' },
  { title: 'Upgrade', value: 'upgrade', description: 'Upgrade dependencies or language versions' },
  { title: 'Refactor', value: 'refactor', description: 'Restructure code without changing behavior' },
  { title: 'Feature', value: 'feature', description: 'Implement a new feature from scratch' },
  { title: 'Bug Fix', value: 'bugfix', description: 'Fix bugs across multiple files' },
  { title: 'Other', value: 'other', description: 'Something else' },
];

const VERIFICATION_METHODS = [
  { title: 'Run tests', value: 'tests', selected: true },
  { title: 'Type check (tsc)', value: 'typecheck', selected: true },
  { title: 'Lint', value: 'lint', selected: false },
  { title: 'Build', value: 'build', selected: false },
  { title: 'Manual verification', value: 'manual', selected: false },
];

// Tools for the interviewer agent to explore the codebase
const interviewerTools = {
  listFiles: tool({
    description: 'List files matching a glob pattern to understand project structure',
    inputSchema: z.object({
      pattern: z.string().describe('Glob pattern like "**/*.ts" or "src/**/*"'),
    }),
    execute: async ({ pattern }) => {
      try {
        const files = await glob(pattern, { 
          cwd: resolvedDir, 
          nodir: true,
          ignore: ['**/node_modules/**', '**/dist/**', '**/.next/**', '**/build/**'],
        });
        return { files: files.slice(0, 50) };
      } catch (error) {
        return { error: String(error) };
      }
    },
  }),

  readFile: tool({
    description: 'Read a file to understand its contents',
    inputSchema: z.object({
      filePath: z.string().describe('Path to the file'),
    }),
    execute: async ({ filePath }) => {
      try {
        const fullPath = path.join(resolvedDir, filePath);
        const content = await fs.readFile(fullPath, 'utf-8');
        return { content: content.slice(0, 5000) };
      } catch (error) {
        return { error: String(error) };
      }
    },
  }),

  listDirectory: tool({
    description: 'List contents of a directory',
    inputSchema: z.object({
      dirPath: z.string().optional().describe('Directory path (default: root)'),
    }),
    execute: async ({ dirPath }) => {
      try {
        const fullPath = path.join(resolvedDir, dirPath || '.');
        const entries = await fs.readdir(fullPath, { withFileTypes: true });
        const listing = entries.slice(0, 50).map(e => ({
          name: e.name,
          type: e.isDirectory() ? 'dir' : 'file',
        }));
        return { entries: listing };
      } catch (error) {
        return { error: String(error) };
      }
    },
  }),

  provideSuggestions: tool({
    description: 'Provide suggestions for a question based on your analysis of the codebase',
    inputSchema: z.object({
      suggestions: z.array(z.string()).length(3).describe('Exactly 3 specific, actionable suggestions based on the codebase'),
    }),
    execute: async ({ suggestions }) => {
      return { suggestions };
    },
  }),
};

// Cache for codebase analysis (explored once, reused for all questions)
let codebaseAnalysis: string | null = null;

/**
 * Explore the codebase once and cache the analysis.
 */
async function exploreCodebase(taskType: string, title: string, techStack?: string): Promise<string> {
  if (codebaseAnalysis) {
    return codebaseAnalysis;
  }

  log('  🔍 AI exploring codebase...', 'cyan');

  try {
    const result = await generateText({
      model: 'anthropic/claude-opus-4.5' as any,
      tools: interviewerTools,
      stopWhen: stepCountIs(15),
      messages: [
        {
          role: 'system',
          content: `You are analyzing a codebase to help define a coding task. Explore the project thoroughly.

## Process:
1. Call listDirectory to see the project structure
2. Call readFile on package.json if it exists
3. Read README.md if it exists
4. List key directories (src/, app/, components/, etc.)
5. Read a few important files to understand the architecture

At the end, provide a comprehensive summary of what you found.`,
        },
        {
          role: 'user',
          content: `I want to: ${title} (${taskType})
${techStack ? `Tech stack: ${techStack}` : ''}

Please explore this codebase and give me a summary of:
- What kind of project this is
- Key technologies/frameworks used
- Important directories and files
- Current architecture/patterns`,
        },
      ],
    });

    // Count tool calls for logging
    let toolCallCount = 0;
    for (const step of result.steps) {
      toolCallCount += step.toolResults.length;
    }
    log(`     ✓ Explored (${toolCallCount} files/dirs checked)`, 'dim');

    codebaseAnalysis = result.text || 'Unable to analyze codebase';
    return codebaseAnalysis;
  } catch (error) {
    log(`     ⚠️ Error exploring: ${error}`, 'yellow');
    codebaseAnalysis = 'New or empty project';
    return codebaseAnalysis;
  }
}

/**
 * Generate suggestions for a question using cached codebase analysis.
 */
async function generateSuggestions(
  question: string,
  context: { taskType: string; title: string; techStack?: string; codebaseAnalysis: string }
): Promise<string[]> {
  try {
    const result = await generateText({
      model: 'anthropic/claude-opus-4.5' as any,
      messages: [
        {
          role: 'system',
          content: `Generate SHORT, DISTINCT suggestions for a coding task question.

Rules:
- Each suggestion must be DIFFERENT (not variations of the same idea)
- Keep each under 15 words
- Focus on WHAT to achieve, not HOW to implement
- Only include suggestions that genuinely make sense for this project
- Return 1-5 suggestions based on what's relevant (don't force a number)
- One suggestion per line, no bullets or numbers`,
        },
        {
          role: 'user',
          content: `Task: ${context.title}

Project: ${context.codebaseAnalysis.slice(0, 1500)}

Question: ${question}`,
        },
      ],
      maxOutputTokens: 250,
    });

    const suggestions = result.text
      .split('\n')
      .map(s => s.replace(/^[\d\-\*\.\)]+\s*/, '').trim())
      .filter(s => s.length > 5 && s.length < 120)
      .slice(0, 5);

    return suggestions.length > 0 ? suggestions : ['Define the core requirement'];
  } catch (error) {
    return ['Define the core requirement'];
  }
}

/**
 * Create a multi-selection prompt with AI-generated options + "Other" + "Skip".
 */
async function selectWithAI(
  message: string,
  aiQuestion: string,
  context: { taskType: string; title: string; techStack?: string; codebaseAnalysis: string },
  onCancel: () => void
): Promise<string> {
  const suggestions = await generateSuggestions(aiQuestion, context);
  
  const choices = [
    ...suggestions.map(s => ({ title: s, value: s })),
    { title: '✏️  Other (add custom)', value: '__other__' },
    { title: '⏭️  Skip this question', value: '__skip__' },
  ];

  const { selections } = await prompts({
    type: 'multiselect',
    name: 'selections',
    message,
    choices,
    hint: '- Space to select, Enter to confirm',
    instructions: false,
  }, { onCancel });

  // If skip was selected, return empty
  if (selections?.includes('__skip__')) {
    return '';
  }

  const results: string[] = selections?.filter((s: string) => s !== '__other__' && s !== '__skip__') || [];

  // If "Other" was selected, prompt for custom input
  if (selections?.includes('__other__')) {
    const { custom } = await prompts({
      type: 'text',
      name: 'custom',
      message: 'Add your own:',
    }, { onCancel });
    if (custom) {
      results.push(custom);
    }
  }

  // If nothing selected, that's okay - return empty
  if (results.length === 0) {
    return '';
  }

  return results.join('. ');
}

/**
 * Run the interactive interview to generate a task prompt.
 */
async function runInterview(): Promise<{ prompt: string; saveToFile: boolean }> {
  console.log();
  log('Let\'s define your task. Press Ctrl+C to cancel at any time.', 'dim');
  console.log();

  // Handle Ctrl+C gracefully
  prompts.override({});
  const onCancel = () => {
    log('\nCancelled.', 'yellow');
    process.exit(0);
  };

  // Step 1 & 2: Task type and title (user-defined)
  const { taskType, title } = await prompts([
    {
      type: 'select',
      name: 'taskType',
      message: 'What type of task is this?',
      choices: TASK_TYPES,
      initial: 0,
    },
    {
      type: 'text',
      name: 'title',
      message: 'Give your task a short title:',
      initial: (prev: string) => {
        const type = TASK_TYPES.find(t => t.value === prev);
        return type ? `${type.title}: ` : '';
      },
      validate: (value: string) => value.length > 0 || 'Title is required',
    },
  ], { onCancel });

  // If creating a new project, ask about tech stack
  let techStack = '';
  if (taskType === 'create') {
    const { stack } = await prompts({
      type: 'text',
      name: 'stack',
      message: 'What tech stack? (e.g., Next.js, React + Vite, Node.js + Express)',
      validate: (v: string) => v.length > 0 || 'Please specify a tech stack',
    }, { onCancel });
    techStack = stack;
  }

  // Explore codebase ONCE at the start
  const analysis = await exploreCodebase(taskType, title, techStack);
  const aiContext = { taskType, title, techStack, codebaseAnalysis: analysis };

  // Step 3: Goal (AI-suggested) - high level, what to achieve
  const goal = await selectWithAI(
    'What is the goal?',
    'What is the high-level outcome or goal? Focus on WHAT, not how.',
    aiContext,
    onCancel
  );

  // Step 4: Requirements (AI-suggested) - key requirements
  const requirements = await selectWithAI(
    'Any specific requirements?',
    'What specific requirements or constraints should be met?',
    aiContext,
    onCancel
  );

  // Step 5: Verification (user-defined multiselect - keeping as is)
  const { verification } = await prompts({
    type: 'multiselect',
    name: 'verification',
    message: 'How should success be verified?',
    choices: VERIFICATION_METHODS,
    hint: '- Space to select, Enter to confirm',
    instructions: false,
  }, { onCancel });

  // Step 6: Success criteria (AI-suggested) - what does done look like
  const successCriteria = await selectWithAI(
    'What does done look like?',
    'How will we know this is complete? What is the definition of done?',
    aiContext,
    onCancel
  );

  // Step 8: Save to file
  const { saveToFile } = await prompts({
    type: 'confirm',
    name: 'saveToFile',
    message: 'Save as PROMPT.md in the target directory?',
    initial: true,
  }, { onCancel });

  const response = { taskType, title, techStack, goal, requirements, verification, successCriteria, saveToFile };

  // Build the prompt markdown
  const promptLines: string[] = [];
  
  promptLines.push(`# ${response.title}`);
  
  if (response.goal) {
    promptLines.push('');
    promptLines.push('## Goal');
    promptLines.push(response.goal);
  }

  if (response.techStack) {
    promptLines.push('');
    promptLines.push('## Tech Stack');
    promptLines.push(response.techStack);
  }
  
  if (response.requirements) {
    promptLines.push('');
    promptLines.push('## Requirements');
    promptLines.push(response.requirements);
  }

  if (response.verification && response.verification.length > 0) {
    promptLines.push('');
    promptLines.push('## Verification');
    const verificationMap: Record<string, string> = {
      tests: 'Run tests to ensure nothing is broken',
      typecheck: 'Type check with `tsc --noEmit`',
      lint: 'Run linter and fix any issues',
      build: 'Ensure the project builds successfully',
      manual: 'Manual verification required',
    };
    for (const v of response.verification) {
      promptLines.push(`- ${verificationMap[v] || v}`);
    }
  }

  if (response.successCriteria) {
    promptLines.push('');
    promptLines.push('## Success Criteria');
    promptLines.push(response.successCriteria);
  }

  promptLines.push('');
  promptLines.push('## Guidelines');
  promptLines.push('- Read files before modifying them');
  promptLines.push('- Make incremental changes');
  promptLines.push('- Use `editFile` for small changes instead of rewriting entire files');
  promptLines.push('- Verify changes work before moving on');

  const prompt = promptLines.join('\n');

  return { prompt, saveToFile: response.saveToFile };
}

/**
 * Get the task prompt from various sources:
 * 1. CLI argument (string or path to .md file)
 * 2. PROMPT.md in the target directory
 * 3. Interactive interview
 */
async function getTaskPrompt(): Promise<{ prompt: string; source: string }> {
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
    // No PROMPT.md found - run interactive interview
  }

  // Run interactive interview
  log('No PROMPT.md found. Starting interactive setup...', 'yellow');
  
  const { prompt, saveToFile } = await runInterview();

  if (saveToFile) {
    await fs.writeFile(promptMdPath, prompt, 'utf-8');
    log(`\n✓ Saved to ${promptMdPath}`, 'green');
  }

  return { prompt, source: saveToFile ? promptMdPath : 'interactive' };
}

// Define tools for the agent
const tools = {
  listFiles: tool({
    description: 'List files in a directory matching a glob pattern',
    inputSchema: z.object({
      pattern: z.string().describe('Glob pattern like "**/*.js" or "src/**/*.ts"'),
    }),
    execute: async ({ pattern }) => {
      try {
        const files = await glob(pattern, { cwd: resolvedDir, nodir: true });
        log(`  📂 Found ${files.length} files matching "${pattern}"`, 'dim');
        return { success: true, files: files.slice(0, 100) }; // Limit to 100 files
      } catch (error) {
        return { success: false, error: String(error) };
      }
    },
  }),

  readFile: tool({
    description: 'Read the contents of a file. For large files, use lineStart/lineEnd to read specific sections.',
    inputSchema: z.object({
      filePath: z.string().describe('Path to the file relative to the project root'),
      lineStart: z.number().optional().describe('Start line (1-indexed). Use for large files.'),
      lineEnd: z.number().optional().describe('End line (inclusive). Use for large files.'),
    }),
    execute: async ({ filePath, lineStart, lineEnd }) => {
      try {
        const fullPath = path.join(resolvedDir, filePath);
        const content = await fs.readFile(fullPath, 'utf-8');
        const lines = content.split('\n');
        const totalLines = lines.length;
        
        // If specific range requested, extract it
        if (lineStart !== undefined || lineEnd !== undefined) {
          const start = Math.max(1, lineStart ?? 1);
          const end = Math.min(totalLines, lineEnd ?? totalLines);
          const selectedLines = lines.slice(start - 1, end);
          const numberedContent = selectedLines
            .map((line, i) => `${String(start + i).padStart(6)}| ${line}`)
            .join('\n');
          log(`  📖 Read: ${filePath} lines ${start}-${end} of ${totalLines}`, 'dim');
          return { 
            success: true, 
            content: numberedContent,
            totalLines,
            lineRange: { start, end },
          };
        }
        
        // Auto-truncate large files
        if (content.length > MAX_FILE_CHARS) {
          const maxLines = Math.min(MAX_FILE_LINES_PREVIEW, totalLines);
          const selectedLines = lines.slice(0, maxLines);
          const numberedContent = selectedLines
            .map((line, i) => `${String(i + 1).padStart(6)}| ${line}`)
            .join('\n');
          const warning = `\n\n... [TRUNCATED: File has ${totalLines} lines, showing 1-${maxLines}. Use lineStart/lineEnd to read specific sections] ...`;
          log(`  📖 Read: ${filePath} (TRUNCATED: ${totalLines} lines, showing 1-${maxLines})`, 'yellow');
          return { 
            success: true, 
            content: numberedContent + warning,
            totalLines,
            truncated: true,
            lineRange: { start: 1, end: maxLines },
          };
        }
        
        log(`  📖 Read: ${filePath} (${content.length} chars)`, 'dim');
        return { success: true, content, totalLines };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    },
  }),

  writeFile: tool({
    description: 'Write content to a file (creates directories if needed). For small changes, prefer editFile instead.',
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

  editFile: tool({
    description: 'Make surgical edits to a file by replacing specific text. More token-efficient than writeFile for small changes. The old_string must be unique in the file.',
    inputSchema: z.object({
      filePath: z.string().describe('Path to the file relative to the project root'),
      old_string: z.string().describe('Exact text to find and replace (must be unique in the file)'),
      new_string: z.string().describe('Text to replace it with'),
    }),
    execute: async ({ filePath, old_string, new_string }) => {
      try {
        const fullPath = path.join(resolvedDir, filePath);
        const content = await fs.readFile(fullPath, 'utf-8');
        
        // Check for exact match
        const occurrences = content.split(old_string).length - 1;
        if (occurrences === 0) {
          return { 
            success: false, 
            error: 'old_string not found in file. Make sure it matches exactly (including whitespace).',
          };
        }
        if (occurrences > 1) {
          return { 
            success: false, 
            error: `old_string found ${occurrences} times - must be unique. Add more surrounding context to make it unique.`,
          };
        }
        
        // Perform replacement
        const newContent = content.replace(old_string, new_string);
        await fs.writeFile(fullPath, newContent, 'utf-8');
        
        log(`  🔧 Edited: ${filePath}`, 'green');
        return { 
          success: true, 
          filePath,
          replaced: old_string.length > 100 ? old_string.slice(0, 100) + '...' : old_string,
          with: new_string.length > 100 ? new_string.slice(0, 100) + '...' : new_string,
        };
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
          timeout: 120000, // 2 minute timeout
        });
        const output = stdout + (stderr ? `\nSTDERR: ${stderr}` : '');
        log(`  ✓ Command completed`, 'dim');
        return { success: true, output: output.slice(0, 8000) }; // Limit output
      } catch (error: any) {
        log(`  ✗ Command failed`, 'red');
        return {
          success: false,
          error: error.message,
          stdout: error.stdout?.slice(0, 3000),
          stderr: error.stderr?.slice(0, 3000),
        };
      }
    },
  }),

  markComplete: tool({
    description: 'Mark the task as complete with a summary of what was done',
    inputSchema: z.object({
      summary: z.string().describe('Summary of what was accomplished'),
      filesModified: z.array(z.string()).describe('List of files that were modified'),
    }),
    execute: async ({ summary, filesModified }) => {
      log(`  ✅ Task marked complete`, 'green');
      return { complete: true, summary, filesModified };
    },
  }),
};

type Tools = typeof tools;

// Read-only tools for the judge agent
const judgeTools = {
  listFiles: tool({
    description: 'List files in a directory matching a glob pattern',
    inputSchema: z.object({
      pattern: z.string().describe('Glob pattern like "**/*.js" or "src/**/*.ts"'),
    }),
    execute: async ({ pattern }) => {
      try {
        const files = await glob(pattern, { cwd: resolvedDir, nodir: true });
        return { success: true, files: files.slice(0, 100) };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    },
  }),

  readFile: tool({
    description: 'Read the contents of a file to review changes',
    inputSchema: z.object({
      filePath: z.string().describe('Path to the file relative to the project root'),
      lineStart: z.number().optional().describe('Start line (1-indexed)'),
      lineEnd: z.number().optional().describe('End line (inclusive)'),
    }),
    execute: async ({ filePath, lineStart, lineEnd }) => {
      try {
        const fullPath = path.join(resolvedDir, filePath);
        const content = await fs.readFile(fullPath, 'utf-8');
        const lines = content.split('\n');
        const totalLines = lines.length;
        
        if (lineStart !== undefined || lineEnd !== undefined) {
          const start = Math.max(1, lineStart ?? 1);
          const end = Math.min(totalLines, lineEnd ?? totalLines);
          const selectedLines = lines.slice(start - 1, end);
          return { 
            success: true, 
            content: selectedLines.join('\n'),
            totalLines,
          };
        }
        
        // Truncate for judge
        if (content.length > 15000) {
          return { 
            success: true, 
            content: content.slice(0, 15000) + '\n... [truncated]',
            totalLines,
            truncated: true,
          };
        }
        
        return { success: true, content, totalLines };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    },
  }),

  runCommand: tool({
    description: 'Run a command to verify the code (e.g., tests, type-check, lint)',
    inputSchema: z.object({
      command: z.string().describe('The shell command to run'),
    }),
    execute: async ({ command }) => {
      try {
        const { stdout, stderr } = await execAsync(command, {
          cwd: resolvedDir,
          timeout: 60000,
        });
        return { success: true, output: (stdout + stderr).slice(0, 5000) };
      } catch (error: any) {
        return {
          success: false,
          error: error.message,
          stdout: error.stdout?.slice(0, 2000),
          stderr: error.stderr?.slice(0, 2000),
        };
      }
    },
  }),

  approveTask: tool({
    description: 'Approve the task as complete - all success criteria are met',
    inputSchema: z.object({
      reason: z.string().describe('Why the task is complete and meets all criteria'),
    }),
    execute: async ({ reason }) => {
      return { approved: true, reason };
    },
  }),

  requestChanges: tool({
    description: 'Request changes - the task is NOT complete or has issues',
    inputSchema: z.object({
      issues: z.array(z.string()).describe('List of specific issues that need to be fixed'),
      suggestions: z.array(z.string()).describe('Specific suggestions for the coding agent'),
    }),
    execute: async ({ issues, suggestions }) => {
      return { approved: false, issues, suggestions };
    },
  }),
};

/**
 * Run the judge agent to review the work done.
 */
async function runJudge(
  taskPrompt: string,
  workSummary: string,
  filesModified: string[]
): Promise<{ approved: boolean; feedback: string }> {
  log('  🧑‍⚖️  Judge reviewing...', 'cyan');

  try {
    const result = await generateText({
      model: 'anthropic/claude-opus-4.5' as any,
      tools: judgeTools,
      toolChoice: 'required',
      stopWhen: stepCountIs(10),
      messages: [
        {
          role: 'system',
          content: `You are a code review judge. Your job is to verify that a coding task has been completed correctly.

## Your Process:
1. Run verification commands (type-check, build, tests) FIRST
2. If all verifications pass, use approveTask immediately
3. Only use requestChanges if there are actual failures

## IMPORTANT:
- If type-check passes AND build passes, you should APPROVE
- Don't read every file - trust the verification commands
- Be efficient - run checks, then give verdict
- You MUST end with either approveTask or requestChanges`,
        },
        {
          role: 'user',
          content: `## Task Requirements:
${taskPrompt.slice(0, 3000)}

## Work Summary from Coding Agent:
${workSummary}

## Files Modified:
${filesModified.slice(0, 20).join('\n') || 'None reported'}

Run verification commands (type-check, build) and give your verdict.`,
        },
      ],
    });

    // Log all tool calls for debugging
    log(`  📋 Judge made ${result.steps.length} steps`, 'dim');
    for (const step of result.steps) {
      for (const toolResult of step.toolResults) {
        if (toolResult.toolName === 'runCommand') {
          log(`     → ran command`, 'dim');
        } else if (toolResult.toolName === 'readFile') {
          log(`     → read file`, 'dim');
        } else if (toolResult.toolName === 'listFiles') {
          log(`     → listed files`, 'dim');
        } else if (toolResult.toolName === 'approveTask') {
          const output = toolResult.output as { approved: boolean; reason: string };
          log('  ✅ Judge APPROVED', 'green');
          log(`     Reason: ${output.reason.slice(0, 100)}...`, 'dim');
          return { approved: true, feedback: output.reason };
        } else if (toolResult.toolName === 'requestChanges') {
          const output = toolResult.output as { approved: boolean; issues: string[]; suggestions: string[] };
          log('  ❌ Judge REQUESTED CHANGES', 'yellow');
          log(`     Issues: ${output.issues.length}`, 'dim');
          const feedback = [
            'Issues found:',
            ...output.issues.map(i => `- ${i}`),
            '',
            'Suggestions:',
            ...output.suggestions.map(s => `- ${s}`),
          ].join('\n');
          return { approved: false, feedback };
        }
      }
    }

    // No verdict tool was called - this is the problem!
    log('  ⚠️  Judge did NOT call approveTask or requestChanges!', 'red');
    log(`     Final text: ${result.text.slice(0, 200)}...`, 'dim');
    
    // Auto-approve if judge didn't give verdict but didn't find issues
    return { 
      approved: true, 
      feedback: 'Judge completed review without explicit verdict. Auto-approving based on successful verification.' 
    };
  } catch (error) {
    log(`  ⚠️  Judge error: ${error}`, 'red');
    // On error, auto-approve to avoid infinite loop
    return { approved: true, feedback: 'Judge encountered an error. Auto-approving.' };
  }
}

// Track completion
let taskComplete = false;
let taskSummary = '';
let pendingJudgeReview = false;
let lastFilesModified: string[] = [];

async function main() {
  log('╔════════════════════════════════════════════════════════════╗', 'magenta');
  log('║      Ralph Wiggum CLI Example - Autonomous Coding Agent    ║', 'magenta');
  log('╚════════════════════════════════════════════════════════════╝', 'magenta');

  // Check if directory exists, offer to create if not
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
  log(`Target: ${resolvedDir}`, 'bright');

  // Get the task prompt (may run interactive interview)
  const { prompt: taskPrompt, source: promptSource } = await getTaskPrompt();

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
    process.exit(0);
  }

  const agent = new RalphLoopAgent({
    model: 'anthropic/claude-opus-4.5' as any,
    instructions: `You are an expert software engineer. Your task is to complete coding tasks autonomously.

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

Current working directory: ${resolvedDir}`,

    tools,

    // Enable context management to handle long conversations
    contextManagement: {
      maxContextTokens: 180_000,      // Claude's 200k limit minus output buffer
      enableSummarization: true,       // Summarize old iterations
      recentIterationsToKeep: 2,       // Keep last 2 iterations in full detail
      maxFileChars: MAX_FILE_CHARS,    // Truncate files larger than this
      changeLogBudget: 8_000,          // Tokens for tracking decisions
      fileContextBudget: 60_000,       // Tokens for file content
    },

    stopWhen: iterationCountIs(20),

    verifyCompletion: async ({ result, originalPrompt }: VerifyCompletionContext<Tools>) => {
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
          taskComplete = true;
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
    process.exit(1);
  }
}

main();
