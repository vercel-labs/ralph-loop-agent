/**
 * Tools for the interviewer agent (codebase exploration)
 */

import { tool } from 'ai';
import { z } from 'zod';
import { runInSandbox, readFromSandbox } from '../sandbox.js';

export function createInterviewerTools() {
  return {
    listFiles: tool({
      description: 'List files matching a pattern to understand project structure',
      inputSchema: z.object({
        pattern: z.string().describe('Glob-like pattern like "*.ts" or "src/"'),
      }),
      execute: async ({ pattern }) => {
        try {
          const result = await runInSandbox(`find . -type f -name "${pattern}" | head -50 | grep -v node_modules | grep -v .git`);
          const files = result.stdout.split('\n').filter(f => f.trim()).map(f => f.replace(/^\.\//, ''));
          return { files };
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
          const content = await readFromSandbox(filePath);
          if (!content) return { error: 'File not found' };
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
          const result = await runInSandbox(`ls -la ${dirPath || '.'}`);
          return { listing: result.stdout };
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
}

