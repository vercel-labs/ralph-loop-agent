/**
 * Tools for the Plan Mode agent (codebase exploration)
 *
 * Uses just-bash with OverlayFs for read-only codebase exploration.
 * This avoids needing to spin up a Vercel sandbox just for the interview phase.
 */

import { tool } from 'ai';
import { z } from 'zod';
import type { Bash } from 'just-bash';
import { runInInterviewBash, readFromInterviewBash } from '../interview-bash.js';

export function createInterviewerTools(bash: Bash) {
  return {
    listFiles: tool({
      description: 'List files matching a pattern to understand project structure',
      inputSchema: z.object({
        pattern: z.string().describe('Glob-like pattern like "*.ts" or "src/"'),
      }),
      execute: async ({ pattern }) => {
        try {
          const result = await runInInterviewBash(
            bash,
            `find /project -type f -name "${pattern}" 2>/dev/null | head -50 | grep -v node_modules | grep -v .git`
          );
          const files = result.stdout
            .split('\n')
            .filter((f: string) => f.trim())
            .map((f: string) => f.replace(/^\/project\/?/, ''));
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
          const content = await readFromInterviewBash(bash, filePath);
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
          const path = dirPath ? `/project/${dirPath}` : '/project';
          const result = await runInInterviewBash(bash, `ls -la ${path}`);
          return { listing: result.stdout };
        } catch (error) {
          return { error: String(error) };
        }
      },
    }),
  };
}
