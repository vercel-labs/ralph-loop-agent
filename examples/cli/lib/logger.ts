/**
 * Logger utilities with ANSI colors
 */

export const colors = {
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

export type Color = keyof typeof colors;

export function log(message: string, color: Color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

export function logSection(title: string) {
  console.log();
  log(`━━━ ${title} ━━━`, 'cyan');
}

