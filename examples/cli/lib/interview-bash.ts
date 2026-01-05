/**
 * Interview Bash - A read-only bash shell for codebase exploration during interview/plan mode
 *
 * Uses just-bash with OverlayFs to provide a sandboxed read-only view of the local directory.
 * This allows the interview agent to explore the codebase without needing the full Vercel sandbox.
 */

import { Bash, OverlayFs } from 'just-bash';

/**
 * Create a read-only bash shell for exploring the local directory.
 * All writes stay in memory and don't affect the real filesystem.
 */
export function createInterviewBash(localDir: string): Bash {
  const overlayFs = new OverlayFs({
    root: localDir,
    mountPoint: '/project',
    readOnly: true,
  });

  return new Bash({
    fs: overlayFs,
    cwd: overlayFs.getMountPoint(),
  });
}

/**
 * Run a command in the interview bash and return the result.
 */
export async function runInInterviewBash(
  bash: Bash,
  command: string
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const result = await bash.exec(command);
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
  };
}

/**
 * Read a file from the interview bash filesystem.
 */
export async function readFromInterviewBash(
  bash: Bash,
  filePath: string
): Promise<string | null> {
  try {
    // Ensure path is relative to the project mount point
    const normalizedPath = filePath.startsWith('/') ? filePath : `/project/${filePath}`;
    return await bash.readFile(normalizedPath);
  } catch {
    return null;
  }
}

