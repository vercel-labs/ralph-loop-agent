/**
 * Git operations for repo-based tasks
 * All operations run on host machine, not sandbox
 */

import { execSync, spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { log } from './logger.js';

/**
 * Parse a GitHub URL into owner and repo
 */
export function parseGitHubUrl(url: string): { owner: string; repo: string } | null {
  // Support various GitHub URL formats:
  // https://github.com/owner/repo
  // https://github.com/owner/repo.git
  // git@github.com:owner/repo.git
  
  const httpsMatch = url.match(/github\.com\/([^\/]+)\/([^\/\.]+)/);
  if (httpsMatch) {
    return { owner: httpsMatch[1], repo: httpsMatch[2] };
  }
  
  const sshMatch = url.match(/git@github\.com:([^\/]+)\/([^\/\.]+)/);
  if (sshMatch) {
    return { owner: sshMatch[1], repo: sshMatch[2] };
  }
  
  return null;
}

/**
 * Check if a string is a GitHub repo URL
 */
export function isGitHubUrl(str: string): boolean {
  return str.includes('github.com/') || str.includes('git@github.com:');
}

/**
 * Generate a task directory path for a repo
 */
export function getTaskDir(owner: string, repo: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const cliDir = path.dirname(new URL(import.meta.url).pathname);
  return path.join(cliDir, '..', 'tasks', owner, repo, timestamp);
}

/**
 * Clone a GitHub repo to the task directory
 */
export async function cloneRepo(repoUrl: string, targetDir: string): Promise<void> {
  log(`  [-] Cloning ${repoUrl}...`, 'cyan');
  
  // Ensure parent directory exists
  await fs.mkdir(path.dirname(targetDir), { recursive: true });
  
  try {
    execSync(`git clone --depth 1 "${repoUrl}" "${targetDir}"`, {
      stdio: 'pipe',
      encoding: 'utf-8',
    });
    log(`  [+] Cloned to ${targetDir}`, 'green');
  } catch (error: any) {
    throw new Error(`Failed to clone repo: ${error.message}`);
  }
}

/**
 * Create a new branch for the task
 */
export function createBranch(repoDir: string, branchName: string): void {
  log(`  [-] Creating branch: ${branchName}`, 'cyan');
  
  try {
    execSync(`git checkout -b "${branchName}"`, {
      cwd: repoDir,
      stdio: 'pipe',
      encoding: 'utf-8',
    });
    log(`  [+] Created and switched to branch: ${branchName}`, 'green');
  } catch (error: any) {
    throw new Error(`Failed to create branch: ${error.message}`);
  }
}

/**
 * Stage all changes
 */
export function stageChanges(repoDir: string): void {
  try {
    execSync('git add -A', {
      cwd: repoDir,
      stdio: 'pipe',
      encoding: 'utf-8',
    });
  } catch (error: any) {
    throw new Error(`Failed to stage changes: ${error.message}`);
  }
}

/**
 * Get list of changed files
 */
export function getChangedFiles(repoDir: string): string[] {
  try {
    const output = execSync('git diff --cached --name-only', {
      cwd: repoDir,
      encoding: 'utf-8',
    });
    return output.trim().split('\n').filter(f => f.length > 0);
  } catch {
    return [];
  }
}

/**
 * Commit changes with a message
 */
export function commitChanges(repoDir: string, message: string): void {
  log(`  [-] Committing changes...`, 'cyan');
  
  try {
    execSync(`git commit -m "${message.replace(/"/g, '\\"')}"`, {
      cwd: repoDir,
      stdio: 'pipe',
      encoding: 'utf-8',
    });
    log(`  [+] Committed: ${message.slice(0, 60)}...`, 'green');
  } catch (error: any) {
    if (error.message.includes('nothing to commit')) {
      log(`  [i] Nothing to commit`, 'dim');
      return;
    }
    throw new Error(`Failed to commit: ${error.message}`);
  }
}

/**
 * Push branch to remote
 */
export function pushBranch(repoDir: string, branchName: string): void {
  log(`  [-] Pushing branch to origin...`, 'cyan');
  
  try {
    execSync(`git push -u origin "${branchName}"`, {
      cwd: repoDir,
      stdio: 'pipe',
      encoding: 'utf-8',
    });
    log(`  [+] Pushed to origin/${branchName}`, 'green');
  } catch (error: any) {
    throw new Error(`Failed to push: ${error.message}`);
  }
}

/**
 * Open a pull request using GitHub CLI
 */
export async function openPullRequest(
  repoDir: string,
  title: string,
  body: string
): Promise<string | null> {
  log(`  [-] Opening pull request...`, 'cyan');
  
  // Check if gh CLI is available
  try {
    execSync('which gh', { stdio: 'pipe' });
  } catch {
    log(`  [!] GitHub CLI (gh) not installed - skipping PR creation`, 'yellow');
    log(`      Install with: brew install gh`, 'dim');
    return null;
  }
  
  // Check if authenticated
  try {
    execSync('gh auth status', { cwd: repoDir, stdio: 'pipe' });
  } catch {
    log(`  [!] Not authenticated with GitHub CLI - skipping PR creation`, 'yellow');
    log(`      Run: gh auth login`, 'dim');
    return null;
  }
  
  try {
    const output = execSync(
      `gh pr create --title "${title.replace(/"/g, '\\"')}" --body "${body.replace(/"/g, '\\"')}"`,
      {
        cwd: repoDir,
        encoding: 'utf-8',
        stdio: 'pipe',
      }
    );
    
    const prUrl = output.trim();
    log(`  [+] Pull request created: ${prUrl}`, 'green');
    return prUrl;
  } catch (error: any) {
    log(`  [!] Failed to create PR: ${error.message}`, 'yellow');
    return null;
  }
}

/**
 * Generate a branch name from a task description
 */
export function generateBranchName(taskSummary: string): string {
  // Clean up the summary to make a valid branch name
  const cleaned = taskSummary
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 50)
    .replace(/-+$/, '');
  
  const timestamp = Date.now().toString(36);
  return `ralph/${cleaned}-${timestamp}`;
}

/**
 * Generate a commit message from task summary and files changed
 */
export function generateCommitMessage(taskSummary: string, filesChanged: string[]): string {
  // Keep it concise
  const summary = taskSummary.slice(0, 72);
  
  if (filesChanged.length <= 3) {
    return `${summary}\n\nFiles changed:\n${filesChanged.map(f => `- ${f}`).join('\n')}`;
  }
  
  return `${summary}\n\nFiles changed: ${filesChanged.length} files`;
}

/**
 * Generate PR body from task prompt and summary
 */
export function generatePRBody(taskPrompt: string, taskSummary: string, filesChanged: string[]): string {
  return `## Summary

${taskSummary}

## Original Task

${taskPrompt.slice(0, 1000)}${taskPrompt.length > 1000 ? '...' : ''}

## Files Changed

${filesChanged.map(f => `- \`${f}\``).join('\n')}

---
*This PR was created by [Ralph Loop Agent](https://github.com/ctate/ralph-loop-agent)*
`;
}

/**
 * Full workflow: create branch, commit, push, and open PR
 */
export async function createPullRequestWorkflow(
  repoDir: string,
  taskPrompt: string,
  taskSummary: string
): Promise<{ branchName: string; prUrl: string | null }> {
  log('\n━━━ Creating Pull Request ━━━', 'magenta');
  
  // Stage all changes
  stageChanges(repoDir);
  
  // Get changed files
  const filesChanged = getChangedFiles(repoDir);
  
  if (filesChanged.length === 0) {
    log(`  [i] No changes to commit`, 'dim');
    return { branchName: '', prUrl: null };
  }
  
  log(`  [i] ${filesChanged.length} files changed`, 'dim');
  
  // Generate branch name
  const branchName = generateBranchName(taskSummary);
  
  // Create branch
  createBranch(repoDir, branchName);
  
  // Stage changes again on new branch
  stageChanges(repoDir);
  
  // Commit
  const commitMessage = generateCommitMessage(taskSummary, filesChanged);
  commitChanges(repoDir, commitMessage);
  
  // Push
  pushBranch(repoDir, branchName);
  
  // Open PR
  const prTitle = taskSummary.slice(0, 72);
  const prBody = generatePRBody(taskPrompt, taskSummary, filesChanged);
  const prUrl = await openPullRequest(repoDir, prTitle, prBody);
  
  return { branchName, prUrl };
}

