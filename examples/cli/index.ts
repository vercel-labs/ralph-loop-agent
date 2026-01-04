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

/**
 * Get a quick snapshot of the codebase for AI context.
 */
async function getCodebaseSnapshot(): Promise<string> {
  const parts: string[] = [];
  
  // Try to read package.json
  try {
    const pkg = await fs.readFile(path.join(resolvedDir, 'package.json'), 'utf-8');
    parts.push(`package.json:\n${pkg.slice(0, 2000)}`);
  } catch {
    // No package.json
  }

  // List top-level files and directories
  try {
    const entries = await fs.readdir(resolvedDir, { withFileTypes: true });
    const listing = entries
      .slice(0, 30)
      .map(e => `${e.isDirectory() ? '📁' : '📄'} ${e.name}`)
      .join('\n');
    parts.push(`Directory listing:\n${listing}`);
  } catch {
    // Can't read directory
  }

  // Try to find some source files
  try {
    const sourceFiles = await glob('**/*.{ts,js,tsx,jsx,py,go,rs}', { 
      cwd: resolvedDir, 
      nodir: true,
      ignore: ['**/node_modules/**', '**/dist/**', '**/build/**'],
    });
    if (sourceFiles.length > 0) {
      parts.push(`Source files (${sourceFiles.length} total):\n${sourceFiles.slice(0, 20).join('\n')}`);
    }
  } catch {
    // Can't glob
  }

  return parts.join('\n\n') || 'Empty or new directory';
}

/**
 * Use AI to generate suggestions for a question.
 */
async function generateSuggestions(
  question: string,
  context: { taskType: string; title: string; codebaseSnapshot: string }
): Promise<string[]> {
  try {
    const result = await generateText({
      model: 'anthropic/claude-opus-4.5' as any,
      messages: [
        {
          role: 'system',
          content: `You are helping a developer define a coding task. Generate exactly 3 brief, specific suggestions for the question asked. Each suggestion should be 1-2 sentences max. Return ONLY the 3 suggestions, one per line, no numbering or bullets.`,
        },
        {
          role: 'user',
          content: `Task type: ${context.taskType}
Task title: ${context.title}

Codebase info:
${context.codebaseSnapshot}

Question: ${question}

Generate 3 specific suggestions:`,
        },
      ],
      maxOutputTokens: 300,
    });

    const suggestions = result.text
      .split('\n')
      .map(s => s.trim())
      .filter(s => s.length > 0)
      .slice(0, 3);

    return suggestions.length >= 2 ? suggestions : ['Start with the main entry point', 'Focus on core functionality', 'Address one component at a time'];
  } catch (error) {
    // Fallback suggestions if AI fails
    return ['Start with the basics', 'Focus on core functionality', 'Take an incremental approach'];
  }
}

/**
 * Create a multi-selection prompt with AI-generated options + "Other".
 */
async function selectWithAI(
  message: string,
  aiQuestion: string,
  context: { taskType: string; title: string; codebaseSnapshot: string },
  onCancel: () => void
): Promise<string> {
  log('  Generating suggestions...', 'dim');
  const suggestions = await generateSuggestions(aiQuestion, context);
  
  const choices = [
    ...suggestions.map(s => ({ title: s, value: s })),
    { title: '✏️  Other (add custom)', value: '__other__' },
  ];

  const { selections } = await prompts({
    type: 'multiselect',
    name: 'selections',
    message,
    choices,
    hint: '- Space to select, Enter to confirm',
    instructions: false,
  }, { onCancel });

  const results: string[] = selections?.filter((s: string) => s !== '__other__') || [];

  // If "Other" was selected, prompt for custom input
  if (selections?.includes('__other__')) {
    const { custom } = await prompts({
      type: 'text',
      name: 'custom',
      message: 'Add your own:',
      validate: (v: string) => v.length > 0 || 'Please enter something',
    }, { onCancel });
    if (custom) {
      results.push(custom);
    }
  }

  // If nothing selected, require at least one
  if (results.length === 0) {
    const { custom } = await prompts({
      type: 'text',
      name: 'custom',
      message: 'Please enter at least one:',
      validate: (v: string) => v.length > 0 || 'Required',
    }, { onCancel });
    return custom;
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

  // Get codebase snapshot for AI context
  log('\nAnalyzing codebase...', 'dim');
  const codebaseSnapshot = await getCodebaseSnapshot();
  const aiContext = { 
    taskType, 
    title, 
    codebaseSnapshot: taskType === 'create' 
      ? `New project with tech stack: ${techStack}\n\n${codebaseSnapshot}`
      : codebaseSnapshot 
  };

  // Step 3: Description (AI-suggested)
  const description = await selectWithAI(
    'What needs to be done?',
    'What specific work needs to be done for this task? Be concrete and actionable.',
    aiContext,
    onCancel
  );

  // Step 4: Context (AI-suggested)
  const context = await selectWithAI(
    'What context is important?',
    'What technical context, constraints, or considerations are important for this task?',
    aiContext,
    onCancel
  );

  // Step 5: Focus areas (AI-suggested)
  const focusAreasStr = await selectWithAI(
    'Where should the agent focus?',
    'What specific files, directories, or areas of the codebase should be the focus?',
    aiContext,
    onCancel
  );
  const focusAreas = focusAreasStr.split(',').map(s => s.trim()).filter(Boolean);

  // Step 6: Verification (user-defined multiselect - keeping as is)
  const { verification } = await prompts({
    type: 'multiselect',
    name: 'verification',
    message: 'How should success be verified?',
    choices: VERIFICATION_METHODS,
    hint: '- Space to select, Enter to confirm',
    instructions: false,
  }, { onCancel });

  // Step 7: Success criteria (AI-suggested)
  const successCriteria = await selectWithAI(
    'What does success look like?',
    'What are the specific success criteria? How will we know the task is complete?',
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

  const response = { taskType, title, techStack, description, context, focusAreas, verification, successCriteria, saveToFile };

  // Build the prompt markdown
  const promptLines: string[] = [];
  
  promptLines.push(`# ${response.title}`);
  promptLines.push('');
  promptLines.push(response.description);

  if (response.techStack) {
    promptLines.push('');
    promptLines.push('## Tech Stack');
    promptLines.push(response.techStack);
  }
  
  if (response.context) {
    promptLines.push('');
    promptLines.push('## Context');
    promptLines.push(response.context);
  }

  if (response.focusAreas && response.focusAreas.length > 0 && response.focusAreas[0] !== '') {
    promptLines.push('');
    promptLines.push('## Focus Areas');
    for (const area of response.focusAreas) {
      if (area.trim()) {
        promptLines.push(`- ${area.trim()}`);
      }
    }
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
1. Read the task requirements carefully
2. Review the files that were modified
3. Run verification commands (tests, type-check, etc.) as specified in the task
4. Determine if ALL success criteria are met

## Rules:
- Be thorough but fair
- Run the verification commands mentioned in the task
- Check that the code actually implements what was requested
- If tests fail or there are type errors, request changes
- Only approve if you're confident the task is truly complete

## Final Action:
- Use approveTask if everything is correct
- Use requestChanges if there are issues (be specific about what needs fixing)`,
        },
        {
          role: 'user',
          content: `## Task Requirements:
${taskPrompt}

## Work Summary from Coding Agent:
${workSummary}

## Files Modified:
${filesModified.length > 0 ? filesModified.join('\n') : 'None reported'}

Please review the work. Check the modified files, run any verification commands mentioned in the task, and either approve or request changes.`,
        },
      ],
    });

    // Find the final verdict from tool calls
    for (const step of result.steps) {
      for (const toolResult of step.toolResults) {
        if (toolResult.toolName === 'approveTask') {
          const output = toolResult.output as { approved: boolean; reason: string };
          log('  ✅ Judge approved', 'green');
          return { approved: true, feedback: output.reason };
        }
        if (toolResult.toolName === 'requestChanges') {
          const output = toolResult.output as { approved: boolean; issues: string[]; suggestions: string[] };
          log('  ❌ Judge requested changes', 'yellow');
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

    // No clear verdict - default to not approved
    return { 
      approved: false, 
      feedback: 'Judge did not provide a clear verdict. Please verify your work and try markComplete again.' 
    };
  } catch (error) {
    log(`  ⚠️  Judge error: ${error}`, 'red');
    // On error, don't block - let the main agent continue
    return { approved: false, feedback: 'Judge encountered an error. Please verify your work manually.' };
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

  // Verify directory exists
  try {
    await fs.access(resolvedDir);
  } catch {
    log(`Error: Directory does not exist: ${resolvedDir}`, 'red');
    process.exit(1);
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
          return {
            complete: true,
            reason: `Task complete: ${taskSummary}\n\nJudge verdict: ${judgeResult.feedback}`,
          };
        } else {
          // Judge requested changes - feed back to the agent
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
