/**
 * Tools for the coding agent
 */

import { tool } from 'ai';
import { z } from 'zod';
import * as path from 'path';
import { runInSandbox, readFromSandbox, writeToSandbox, getSandboxDomain } from '../sandbox.js';
import { log } from '../logger.js';
import { MAX_FILE_CHARS, MAX_FILE_LINES_PREVIEW } from '../constants.js';

export function createCodingAgentTools() {
  const sandboxDomain = getSandboxDomain();

  return {
    listFiles: tool({
      description: 'List files in the sandbox matching a pattern',
      inputSchema: z.object({
        pattern: z.string().describe('Pattern like "**/*.js" or "src/"'),
      }),
      execute: async ({ pattern }) => {
        try {
          const result = await runInSandbox(`find . -type f -path "*${pattern}*" | grep -v node_modules | grep -v .git | head -100`);
          const files = result.stdout.split('\n').filter(f => f.trim()).map(f => f.replace(/^\.\//, ''));
          log(`  📂 Found ${files.length} files matching "${pattern}"`, 'dim');
          return { success: true, files };
        } catch (error) {
          return { success: false, error: String(error) };
        }
      },
    }),

    readFile: tool({
      description: 'Read the contents of a file. For large files, use lineStart/lineEnd to read specific sections.',
      inputSchema: z.object({
        filePath: z.string().describe('Path to the file'),
        lineStart: z.number().optional().describe('Start line (1-indexed). Use for large files.'),
        lineEnd: z.number().optional().describe('End line (inclusive). Use for large files.'),
      }),
      execute: async ({ filePath, lineStart, lineEnd }) => {
        try {
          const content = await readFromSandbox(filePath);
          if (!content) {
            return { success: false, error: 'File not found' };
          }
          
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
        filePath: z.string().describe('Path to the file'),
        content: z.string().describe('The content to write to the file'),
      }),
      execute: async ({ filePath, content }) => {
        try {
          // Create parent directory if needed
          const dir = path.dirname(filePath);
          if (dir && dir !== '.') {
            await runInSandbox(`mkdir -p "${dir}"`);
          }
          await writeToSandbox(filePath, content);
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
        filePath: z.string().describe('Path to the file'),
        old_string: z.string().describe('Exact text to find and replace (must be unique in the file)'),
        new_string: z.string().describe('Text to replace it with'),
      }),
      execute: async ({ filePath, old_string, new_string }) => {
        try {
          const content = await readFromSandbox(filePath);
          if (!content) {
            return { success: false, error: 'File not found' };
          }
          
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
          await writeToSandbox(filePath, newContent);
          
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
        filePath: z.string().describe('Path to the file'),
      }),
      execute: async ({ filePath }) => {
        try {
          await runInSandbox(`rm -f "${filePath}"`);
          log(`  🗑️  Deleted: ${filePath}`, 'yellow');
          return { success: true, filePath };
        } catch (error) {
          return { success: false, error: String(error) };
        }
      },
    }),

    runCommand: tool({
      description: 'Run a shell command in the sandbox',
      inputSchema: z.object({
        command: z.string().describe('The shell command to run'),
      }),
      execute: async ({ command }) => {
        try {
          log(`  🔧 Running: ${command}`, 'blue');
          const result = await runInSandbox(command);
          const output = result.stdout + (result.stderr ? `\nSTDERR: ${result.stderr}` : '');
          
          if (result.exitCode === 0) {
            log(`  ✓ Command completed`, 'dim');
          } else {
            log(`  ✗ Command failed (exit ${result.exitCode})`, 'red');
          }
          
          return { 
            success: result.exitCode === 0, 
            output: output.slice(0, 8000),
            exitCode: result.exitCode,
          };
        } catch (error: any) {
          log(`  ✗ Command failed`, 'red');
          return { success: false, error: error.message };
        }
      },
    }),

    startDevServer: tool({
      description: 'Start a development server in the background. Returns the URL where the app is accessible.',
      inputSchema: z.object({
        command: z.string().optional().describe('Custom start command (auto-detects if not provided)'),
      }),
      execute: async ({ command }) => {
        try {
          // Determine start command
          let startCmd = command;
          if (!startCmd) {
            // Auto-detect
            const pkgJson = await readFromSandbox('package.json');
            if (pkgJson) {
              const pkg = JSON.parse(pkgJson);
              if (pkg.scripts?.dev) startCmd = 'npm run dev';
              else if (pkg.scripts?.start) startCmd = 'npm run start';
            }
          }

          if (!startCmd) {
            return { success: false, error: 'Could not detect start command. Please provide one.' };
          }

          // Kill any existing server on port 3000
          await runInSandbox('fuser -k 3000/tcp 2>/dev/null || true');
          
          // Start in background
          const bgCmd = `nohup sh -c '${startCmd}' > /tmp/server.log 2>&1 &`;
          await runInSandbox(bgCmd);
          
          // Wait a moment for server to start
          await new Promise(resolve => setTimeout(resolve, 3000));
          
          log(`  🚀 Dev server starting at ${sandboxDomain}`, 'green');
          return { 
            success: true, 
            url: sandboxDomain,
            command: startCmd,
            logFile: '/tmp/server.log',
          };
        } catch (error) {
          return { success: false, error: String(error) };
        }
      },
    }),

    curl: tool({
      description: 'Make an HTTP request (useful for testing the dev server)',
      inputSchema: z.object({
        url: z.string().describe('URL to request (use localhost:3000 for the sandbox dev server)'),
        method: z.enum(['GET', 'POST', 'PUT', 'DELETE']).optional().describe('HTTP method'),
      }),
      execute: async ({ url, method }) => {
        try {
          const resolvedUrl = url.replace('localhost:3000', sandboxDomain || 'localhost:3000');
          const result = await runInSandbox(`curl -s -X ${method || 'GET'} "${resolvedUrl}"`);
          return { success: true, response: result.stdout.slice(0, 5000) };
        } catch (error) {
          return { success: false, error: String(error) };
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
}

export type CodingTools = ReturnType<typeof createCodingAgentTools>;

