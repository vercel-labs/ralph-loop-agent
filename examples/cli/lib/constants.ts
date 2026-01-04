/**
 * Constants for the CLI example
 */

// Context management
export const MAX_FILE_CHARS = 30_000;
export const MAX_FILE_LINES_PREVIEW = 400;

// Sandbox
export const SANDBOX_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

// Task types for the interview
export const TASK_TYPES = [
  { title: 'Create', value: 'create', description: 'Create a new project, app, or library from scratch' },
  { title: 'Migration', value: 'migration', description: 'Migrate between frameworks, libraries, or patterns' },
  { title: 'Upgrade', value: 'upgrade', description: 'Upgrade dependencies or language versions' },
  { title: 'Refactor', value: 'refactor', description: 'Restructure code without changing behavior' },
  { title: 'Feature', value: 'feature', description: 'Implement a new feature from scratch' },
  { title: 'Bug Fix', value: 'bugfix', description: 'Fix bugs across multiple files' },
  { title: 'Other', value: 'other', description: 'Something else' },
];

export const VERIFICATION_METHODS = [
  { title: 'Run tests', value: 'tests', selected: true },
  { title: 'Type check (tsc)', value: 'typecheck', selected: true },
  { title: 'Lint', value: 'lint', selected: false },
  { title: 'Build', value: 'build', selected: false },
  { title: 'Manual verification', value: 'manual', selected: false },
];

