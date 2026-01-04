/**
 * Vercel Sandbox management
 */

import { Sandbox } from '@vercel/sandbox';
import * as fs from 'fs/promises';
import * as path from 'path';
import ignore, { Ignore } from 'ignore';
import { log } from './logger.js';
import { SANDBOX_TIMEOUT_MS } from './constants.js';

// Sandbox state
let sandbox: Sandbox | null = null;
let sandboxDomain: string | null = null;

export function getSandbox(): Sandbox | null {
  return sandbox;
}

export function getSandboxDomain(): string | null {
  return sandboxDomain;
}

/**
 * Helper to convert ReadableStream to string
 */
export async function streamToString(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf-8');
}

/**
 * Load all .gitignore files from a directory tree and create an ignore instance
 */
async function loadGitignore(rootDir: string): Promise<Ignore> {
  const ig = ignore();
  
  // Always ignore these regardless of .gitignore
  ig.add([
    '.git',
    'node_modules',
  ]);

  // Recursively find and load all .gitignore files
  async function loadFromDir(dir: string, prefix = ''): Promise<void> {
    try {
      const gitignorePath = path.join(dir, '.gitignore');
      try {
        const content = await fs.readFile(gitignorePath, 'utf-8');
        // Adjust patterns for nested .gitignore files
        const patterns = content
          .split('\n')
          .filter(line => line.trim() && !line.startsWith('#'))
          .map(pattern => {
            // If we're in a subdirectory, prefix the patterns
            if (prefix) {
              // Handle negation patterns
              if (pattern.startsWith('!')) {
                return '!' + prefix + '/' + pattern.slice(1);
              }
              return prefix + '/' + pattern;
            }
            return pattern;
          });
        ig.add(patterns);
      } catch {
        // No .gitignore in this directory
      }

      // Check subdirectories for nested .gitignore files
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name !== '.git' && entry.name !== 'node_modules') {
          const subPrefix = prefix ? `${prefix}/${entry.name}` : entry.name;
          await loadFromDir(path.join(dir, entry.name), subPrefix);
        }
      }
    } catch {
      // Directory doesn't exist or isn't readable
    }
  }

  await loadFromDir(rootDir);
  return ig;
}

/**
 * Initialize the sandbox and copy files from local directory
 */
export async function initializeSandbox(localDir: string): Promise<void> {
  log('  🔒 Creating secure sandbox...', 'cyan');
  
  sandbox = await Sandbox.create({
    runtime: 'node22',
    timeout: SANDBOX_TIMEOUT_MS,
    ports: [3000],
    token: process.env.SANDBOX_VERCEL_TOKEN!,
    teamId: process.env.SANDBOX_VERCEL_TEAM_ID!,
    projectId: process.env.SANDBOX_VERCEL_PROJECT_ID!,
    resources: { vcpus: 4 },
  });

  sandboxDomain = sandbox.domain(3000);
  log(`  ✓ Sandbox created (${sandbox.sandboxId})`, 'green');
  log(`  📡 Dev server URL: ${sandboxDomain}`, 'dim');

  // Copy files from local directory to sandbox
  await copyLocalToSandbox(localDir);
}

/**
 * Copy files from local directory to sandbox (respects .gitignore)
 */
async function copyLocalToSandbox(localDir: string): Promise<void> {
  log('  📦 Copying project files to sandbox...', 'cyan');
  
  // Load gitignore rules
  const ig = await loadGitignore(localDir);
  
  const filesToCopy: { path: string; content: Buffer }[] = [];
  
  async function collectFiles(dir: string, prefix = ''): Promise<void> {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      
      for (const entry of entries) {
        const localPath = path.join(dir, entry.name);
        const sandboxPath = prefix ? `${prefix}/${entry.name}` : entry.name;
        
        // Check if path is ignored by .gitignore
        // For directories, add trailing slash for proper matching
        const checkPath = entry.isDirectory() ? sandboxPath + '/' : sandboxPath;
        if (ig.ignores(checkPath)) {
          continue;
        }
        
        if (entry.isDirectory()) {
          await collectFiles(localPath, sandboxPath);
        } else if (entry.isFile()) {
          try {
            const content = await fs.readFile(localPath);
            // Skip files larger than 1MB
            if (content.length < 1024 * 1024) {
              filesToCopy.push({ path: sandboxPath, content });
            }
          } catch {
            // Skip unreadable files
          }
        }
      }
    } catch {
      // Directory doesn't exist or isn't readable - that's fine for new projects
    }
  }

  await collectFiles(localDir);
  
  if (filesToCopy.length > 0) {
    // Write files in batches to avoid overwhelming the sandbox
    const batchSize = 50;
    for (let i = 0; i < filesToCopy.length; i += batchSize) {
      const batch = filesToCopy.slice(i, i + batchSize);
      await sandbox!.writeFiles(batch);
    }
    log(`  ✓ Copied ${filesToCopy.length} files to sandbox`, 'green');
  } else {
    log(`  ℹ️  Starting with empty sandbox (new project)`, 'dim');
  }
}

/**
 * Load gitignore from sandbox and create ignore instance
 */
async function loadSandboxGitignore(): Promise<Ignore> {
  const ig = ignore();
  
  // Always ignore these regardless of .gitignore
  ig.add([
    '.git',
    'node_modules',
  ]);

  // Try to read .gitignore from sandbox root
  try {
    const stream = await sandbox!.readFile({ path: '.gitignore' });
    if (stream) {
      const content = await streamToString(stream);
      const patterns = content
        .split('\n')
        .filter(line => line.trim() && !line.startsWith('#'));
      ig.add(patterns);
    }
  } catch {
    // No .gitignore in sandbox
  }

  // Also try to find nested .gitignore files
  try {
    const cmd = await sandbox!.runCommand({
      cmd: 'find',
      args: ['.', '-name', '.gitignore', '-not', '-path', './node_modules/*', '-not', '-path', './.git/*'],
      detached: true,
    });
    
    let stdout = '';
    try {
      for await (const logEntry of cmd.logs()) {
        if (logEntry.stream === 'stdout') stdout += logEntry.data;
      }
    } catch {
      // Ignore streaming errors
    }
    await cmd.wait();

    const gitignoreFiles = stdout.split('\n').filter(f => f.trim() && f !== './.gitignore');
    
    for (const gitignorePath of gitignoreFiles) {
      try {
        const relativePath = gitignorePath.replace(/^\.\//, '').replace('/.gitignore', '');
        const stream = await sandbox!.readFile({ path: gitignorePath.replace(/^\.\//, '') });
        if (stream) {
          const content = await streamToString(stream);
          const patterns = content
            .split('\n')
            .filter(line => line.trim() && !line.startsWith('#'))
            .map(pattern => {
              // Prefix patterns with the directory they're in
              if (pattern.startsWith('!')) {
                return '!' + relativePath + '/' + pattern.slice(1);
              }
              return relativePath + '/' + pattern;
            });
          ig.add(patterns);
        }
      } catch {
        // Skip unreadable .gitignore files
      }
    }
  } catch {
    // Ignore errors finding nested .gitignore files
  }

  return ig;
}

/**
 * Copy files from sandbox back to local directory (respects .gitignore)
 */
async function copySandboxToLocal(localDir: string): Promise<void> {
  log('  📦 Copying changes back to local...', 'cyan');
  
  // Load gitignore rules from sandbox
  const ig = await loadSandboxGitignore();
  
  // Get list of files in sandbox
  const cmd = await sandbox!.runCommand({
    cmd: 'find',
    args: ['.', '-type', 'f', '-not', '-path', './node_modules/*', '-not', '-path', './.git/*'],
    detached: true,
  });
  
  let stdout = '';
  try {
    for await (const logEntry of cmd.logs()) {
      if (logEntry.stream === 'stdout') stdout += logEntry.data;
    }
  } catch {
    // Ignore streaming errors
  }
  await cmd.wait();

  const files = stdout.split('\n').filter(f => f.trim() && f !== '.');
  let copiedCount = 0;
  let skippedCount = 0;

  for (const file of files) {
    const sandboxPath = file.replace(/^\.\//, '');
    
    // Check if file is ignored by .gitignore
    if (ig.ignores(sandboxPath)) {
      skippedCount++;
      continue;
    }
    
    const localPath = path.join(localDir, sandboxPath);
    
    try {
      const stream = await sandbox!.readFile({ path: sandboxPath });
      if (stream) {
        const content = await streamToString(stream);
        await fs.mkdir(path.dirname(localPath), { recursive: true });
        await fs.writeFile(localPath, content, 'utf-8');
        copiedCount++;
      }
    } catch {
      // Skip files that can't be read
    }
  }

  log(`  ✓ Copied ${copiedCount} files back to local${skippedCount > 0 ? ` (${skippedCount} ignored)` : ''}`, 'green');
}

/**
 * Close and cleanup the sandbox
 */
export async function closeSandbox(localDir: string): Promise<void> {
  if (sandbox) {
    try {
      // Copy files back before closing
      await copySandboxToLocal(localDir);
      await sandbox.close();
      log('  🔒 Sandbox closed', 'dim');
    } catch {
      // Ignore close errors
    }
    sandbox = null;
    sandboxDomain = null;
  }
}

/**
 * Run a command in the sandbox
 */
export async function runInSandbox(command: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  if (!sandbox) throw new Error('Sandbox not initialized');
  
  const cmd = await sandbox.runCommand({
    cmd: 'sh',
    args: ['-c', command],
    detached: true,
  });

  let stdout = '';
  let stderr = '';

  try {
    for await (const logEntry of cmd.logs()) {
      if (logEntry.stream === 'stdout') stdout += logEntry.data;
      if (logEntry.stream === 'stderr') stderr += logEntry.data;
    }
  } catch {
    // Ignore streaming errors
  }

  const result = await cmd.wait();
  return { stdout, stderr, exitCode: result.exitCode };
}

/**
 * Read a file from the sandbox
 */
export async function readFromSandbox(filePath: string): Promise<string | null> {
  if (!sandbox) throw new Error('Sandbox not initialized');
  
  const stream = await sandbox.readFile({ path: filePath });
  if (!stream) return null;
  return streamToString(stream);
}

/**
 * Write a file to the sandbox
 */
export async function writeToSandbox(filePath: string, content: string): Promise<void> {
  if (!sandbox) throw new Error('Sandbox not initialized');
  await sandbox.writeFiles([{ path: filePath, content: Buffer.from(content) }]);
}

