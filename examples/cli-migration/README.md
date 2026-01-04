# CLI Migration Example

A code migration agent using RalphLoopAgent that can transform codebases automatically.

## What This Demonstrates

- Using `RalphLoopAgent` with filesystem tools
- Running shell commands from an agent
- Verification-based completion (migration marked complete)
- Real-world code transformation workflow
- Flexible prompt input (CLI arg, file, or auto-detect)

## Setup

```bash
# Install dependencies
pnpm install

# Set your API key
export ANTHROPIC_API_KEY=your_api_key_here
```

## Usage

The agent accepts prompts in three ways:

### 1. Auto-detect PROMPT.md in target repo

```bash
# If ~/Developer/myproject/PROMPT.md exists, it will be used automatically
pnpm start ~/Developer/myproject
```

### 2. Provide prompt as CLI argument

```bash
pnpm start ~/Developer/classnames "Migrate from Node test to Vitest"
```

### 3. Provide path to a prompt file

```bash
pnpm start ~/Developer/myproject ./my-migration-prompt.md
```

## Example PROMPT.md

Create a `PROMPT.md` file in your target repo:

```markdown
# Migration Task

Migrate this codebase from Node's native test runner to Vitest.

## Requirements

1. Add vitest as a devDependency (check latest version with `npm view vitest version`)
2. Create vitest.config.ts with appropriate settings
3. Update test files to use vitest imports (describe, it, expect from 'vitest')
4. Replace assert.equal() with expect().toBe()
5. Update package.json test script to use "vitest run"
6. Run npm install to install new dependencies
7. Run the tests to verify they pass

## Important

- Always check latest package versions before adding dependencies
- Start by reading package.json and exploring test files
```

## Example: Node Test → Vitest Migration

```bash
# Clone a test repo
git clone --depth 1 https://github.com/JedWatson/classnames.git ~/Developer/classnames

# Run the migration
pnpm start ~/Developer/classnames "Migrate from Node native test runner to Vitest"
```

The agent will:
1. Explore the codebase structure
2. Read existing test files
3. Add vitest as a dependency
4. Create vitest.config.ts
5. Transform test files to use vitest syntax
6. Update package.json scripts
7. Run npm install
8. Verify tests pass

## Available Tools

| Tool | Description |
|------|-------------|
| `listFiles` | List files matching a glob pattern |
| `readFile` | Read file contents |
| `writeFile` | Write/create files |
| `deleteFile` | Delete files |
| `runCommand` | Execute shell commands |
| `markComplete` | Signal migration completion |

## Example Output

```
╔════════════════════════════════════════════════════════════╗
║         Ralph Wiggum Agent - Code Migration                ║
╚════════════════════════════════════════════════════════════╝

━━━ Configuration ━━━
Target: /Users/you/Developer/classnames
Task: Migrate from Node native test runner to Vitest

━━━ Starting Migration ━━━
The agent will iterate until the migration is complete...

━━━ Iteration 1 ━━━
  📖 Read: package.json (1847 chars)
  📂 Found 3 files matching "tests/**/*.js"
  📖 Read: tests/index.js (3421 chars)
  ⏱️  Duration: 4521ms

━━━ Iteration 2 ━━━
  ✏️  Wrote: vitest.config.ts
  ✏️  Wrote: package.json
  🔧 Running: npm install
  ✓ Command completed
  ⏱️  Duration: 12043ms

━━━ Iteration 3 ━━━
  ✏️  Wrote: tests/index.js
  ✏️  Wrote: tests/bind.js
  ✏️  Wrote: tests/dedupe.js
  🔧 Running: npm test
  ✓ Command completed
  ✅ Migration marked complete
  ⏱️  Duration: 8234ms

━━━ Migration Result ━━━
Status: verified
Iterations: 3
Total time: 25s

━━━ Summary ━━━
Migration complete: Successfully migrated from Node test to Vitest...
```

## Notes

- The agent has a 15 iteration limit to prevent runaway costs
- Shell commands have a 60 second timeout
- File output is truncated to prevent token overflow

