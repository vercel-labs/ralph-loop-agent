/**
 * Tools for the judge agent (read-only sandbox access)
 */

import { tool } from 'ai';
import { z } from 'zod';
import { runInSandbox, readFromSandbox, getSandboxDomain } from '../sandbox.js';

export function createJudgeTools() {
  const sandboxDomain = getSandboxDomain();

  return {
    listFiles: tool({
      description: 'List files in the sandbox',
      inputSchema: z.object({
        pattern: z.string().describe('Pattern like "**/*.js" or "src/"'),
      }),
      execute: async ({ pattern }) => {
        try {
          const result = await runInSandbox(`find . -type f -path "*${pattern}*" | grep -v node_modules | grep -v .git | head -100`);
          const files = result.stdout.split('\n').filter(f => f.trim()).map(f => f.replace(/^\.\//, ''));
          return { success: true, files };
        } catch (error) {
          return { success: false, error: String(error) };
        }
      },
    }),

    readFile: tool({
      description: 'Read the contents of a file to review changes',
      inputSchema: z.object({
        filePath: z.string().describe('Path to the file'),
        lineStart: z.number().optional().describe('Start line (1-indexed)'),
        lineEnd: z.number().optional().describe('End line (inclusive)'),
      }),
      execute: async ({ filePath, lineStart, lineEnd }) => {
        try {
          const content = await readFromSandbox(filePath);
          if (!content) {
            return { success: false, error: 'File not found' };
          }
          
          const lines = content.split('\n');
          const totalLines = lines.length;
          
          if (lineStart !== undefined || lineEnd !== undefined) {
            const start = Math.max(1, lineStart ?? 1);
            const end = Math.min(totalLines, lineEnd ?? totalLines);
            const selectedLines = lines.slice(start - 1, end);
            return { success: true, content: selectedLines.join('\n'), totalLines };
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
          const result = await runInSandbox(command);
          return { 
            success: result.exitCode === 0, 
            output: (result.stdout + result.stderr).slice(0, 5000),
            exitCode: result.exitCode,
          };
        } catch (error: any) {
          return { success: false, error: error.message };
        }
      },
    }),

    curl: tool({
      description: 'Test the running dev server',
      inputSchema: z.object({
        path: z.string().optional().describe('Path to request (e.g., "/api/health")'),
      }),
      execute: async ({ path }) => {
        try {
          const url = `https://${sandboxDomain}${path || '/'}`;
          const result = await runInSandbox(`curl -s "${url}"`);
          return { success: true, response: result.stdout.slice(0, 5000) };
        } catch (error) {
          return { success: false, error: String(error) };
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
}

