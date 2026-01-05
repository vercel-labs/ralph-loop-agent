/**
 * Task prompt handling and Plan Mode entry point
 *
 * Plan Mode now uses just-bash with OverlayFs for read-only codebase exploration,
 * so it no longer requires the Vercel sandbox to be running.
 */

import { runPlanMode } from './plan-mode.js';
import { log } from './logger.js';

/**
 * Get the task prompt from various sources (reads from local directory, not sandbox):
 * 1. CLI argument (string or path to .md file)
 * 2. PROMPT.md in the local directory
 * 3. Interactive Plan Mode (no longer requires sandbox)
 */
export async function getTaskPrompt(
  promptArg: string | undefined,
  localDir: string
): Promise<{ prompt: string; source: string } | { needsInterview: true; localDir: string }> {
  const pathModule = await import('path');
  const fsModule = await import('fs/promises');

  // If a prompt argument was provided
  if (promptArg) {
    // Check if it's a path to a .md file
    if (promptArg.endsWith('.md')) {
      const promptPath = pathModule.resolve(promptArg.replace('~', process.env.HOME || ''));
      try {
        const content = await fsModule.readFile(promptPath, 'utf-8');
        return { prompt: content.trim(), source: promptPath };
      } catch {
        // If file doesn't exist, treat it as a literal string
        return { prompt: promptArg, source: 'CLI argument' };
      }
    }
    // It's a literal prompt string
    return { prompt: promptArg, source: 'CLI argument' };
  }

  // Check for PROMPT.md in local directory (not sandbox)
  try {
    const promptPath = pathModule.join(localDir, 'PROMPT.md');
    const content = await fsModule.readFile(promptPath, 'utf-8');
    if (content) {
      return { prompt: content.trim(), source: 'PROMPT.md' };
    }
  } catch {
    // No PROMPT.md found
  }

  // Need Plan Mode - pass localDir so it can create the just-bash shell
  return { needsInterview: true, localDir };
}

/**
 * Run Plan Mode and get the prompt.
 * Uses just-bash with OverlayFs - no sandbox required.
 *
 * @param localDir - The local directory to explore
 * @param writeToLocalDir - Function to write files to the local directory
 */
export async function runInterviewAndGetPrompt(
  localDir: string,
  writeToLocalDir: (filename: string, content: string) => Promise<void>
): Promise<{ prompt: string; source: string }> {
  log('No PROMPT.md found. Starting Plan Mode...', 'yellow');
  
  const { prompt, saveToFile } = await runPlanMode(localDir);

  if (saveToFile) {
    await writeToLocalDir('PROMPT.md', prompt);
    log(`\n[+] Saved PROMPT.md to local directory`, 'green');
  }

  return { prompt, source: saveToFile ? 'PROMPT.md' : 'Plan Mode' };
}
