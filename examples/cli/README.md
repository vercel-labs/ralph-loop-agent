# Ralph CLI Example

> **Note**: This package is experimental. APIs may change between versions.

A general-purpose autonomous coding agent for long-running tasks like:

- **Code migrations** (Jest → Vitest, CJS → ESM, etc.)
- **Dependency upgrades** (React 17 → 18, TypeScript 4 → 5, etc.)
- **Large refactoring** (rename across codebase, restructure directories)
- **Feature implementation** (from specifications)
- **Bug fixes** (across multiple files)

## Usage

```bash
# Local directory - Interactive Plan Mode
pnpm cli /path/to/project

# Local directory - With an inline prompt
pnpm cli /path/to/project "Migrate from CommonJS to ESM"

# Local directory - With a prompt file
pnpm cli /path/to/project ./my-task.md

# GitHub repo - Clones, runs task, creates PR
pnpm cli https://github.com/owner/repo "Upgrade dependencies to latest"
pnpm cli https://github.com/owner/repo ./task.md
```

## Plan Mode (Interactive)

If no `PROMPT.md` exists and no prompt is provided, the CLI enters **Plan Mode** - an AI-powered conversation to define your task:

```
╭───────────────────────────────────────────────────────────────╮
│  Plan Mode - Describe your task and I'll create a plan        │
╰───────────────────────────────────────────────────────────────╯

You: I want to upgrade better-auth to the latest version

AI: I'll analyze the codebase to understand the current setup...
    [reads package.json, lib/auth.ts, etc.]
    
    Here's my plan:
    
    ## Goal
    Upgrade better-auth from ^1.3.34 to latest version
    
    ## Steps
    1. Check latest version and changelog
    2. Update package.json
    3. Run pnpm install
    4. Verify type-check passes
    5. Test auth endpoints
    ...

? What would you like to do?
❯ Approve - Start the task
  Refine - Modify the plan
  Cancel - Exit
```

The AI can read your codebase (read-only) to understand context and generate a detailed plan.

## GitHub Repo Mode

When you provide a GitHub URL instead of a local path:

1. **Clones** the repo to `tasks/[owner]/[repo]/[timestamp]/`
2. **Runs** Plan Mode or uses provided prompt
3. **Executes** the task in the sandbox
4. **Creates a PR** with the changes (via `gh` CLI)

```bash
pnpm cli https://github.com/vercel-labs/ai-chatbot "Add dark mode support"
```

After completion:
```
━━━ Creating Pull Request ━━━
  [i] 6 files changed
  [-] Creating branch: ralph/add-dark-mode-support-a1b2c3
  [+] Pushed to origin/ralph/add-dark-mode-support-a1b2c3
  [+] Pull request created: https://github.com/vercel-labs/ai-chatbot/pull/123
```

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Coding Agent   │────▶│  Vercel Sandbox │────▶│   Judge Agent   │
│  (Claude Opus)  │     │  (Isolated Env) │     │  (Claude Opus)  │
└─────────────────┘     └─────────────────┘     └─────────────────┘
        │                       │                       │
        ▼                       ▼                       ▼
   Writes code            Runs commands          Reviews work
   Takes screenshots      Dev server             Approves/rejects
   Interacts with UI      Type-check/build       Visual verification
```

- **Coding Agent**: Writes code, runs commands, takes screenshots
- **Vercel Sandbox**: Isolated environment with PostgreSQL, Redis, Playwright
- **Judge Agent**: Reviews completed work, can approve or request changes

## Features

### Sandbox Environment
All code runs in an isolated Vercel Sandbox:
- **Playwright** pre-installed for screenshots and browser testing
- **PostgreSQL** available for database migrations
- **Redis** available for caching
- Dev server accessible via public URL

### Visual Verification
The agent can see what it's building:
```
[>] Taking screenshot of https://sb-xxx.vercel.run
    Screenshot saved to /tmp/screenshot.png
    Analyzing screenshot...
    Vision: The page shows a todo app with a header "Todos". There's an input 
            field for adding items and 3 existing todos below...
```

### Context Management
Handles long conversations automatically:
- **Auto-summarization** of older iterations when approaching token limits
- **Large file handling** with line-range reading
- **Change log** tracking decisions and progress

### Efficient Editing
- `editFile` tool for surgical search/replace (more token-efficient than full rewrites)
- `readFile` with `lineStart`/`lineEnd` for reading specific sections of large files

## Tools Available

| Tool | Description |
|------|-------------|
| `listFiles` | Glob-based file listing |
| `readFile` | Read files (with optional line range) |
| `writeFile` | Write/create files |
| `editFile` | Search/replace editing |
| `deleteFile` | Delete files |
| `runCommand` | Execute shell commands |
| `startDevServer` | Start a dev server (background) |
| `detectPackageManager` | Detect npm/yarn/pnpm/bun |
| `takeScreenshot` | Screenshot + AI vision analysis |
| `browserInteract` | Navigate, click, fill forms |
| `runPlaywrightTest` | Run Playwright test files |
| `markComplete` | Signal task completion |

## Environment Variables

Create a `.env` file in the `examples/cli` directory:

```bash
# Vercel Sandbox (required)
SANDBOX_VERCEL_TOKEN=your_vercel_token
SANDBOX_VERCEL_TEAM_ID=your_team_id
SANDBOX_VERCEL_PROJECT_ID=your_project_id

# Optional: GitHub CLI for PR creation
# Install with: brew install gh
# Authenticate with: gh auth login
```

## Interrupt Handling

Press `Ctrl+C` during execution to see options:

```
╔═══════════════════════════════════════╗
║           INTERRUPTED (Ctrl+C)         ║
╚═══════════════════════════════════════╝

? What would you like to do?
❯ Continue       - Resume the current task
  Follow up      - Send a message to the agent
  Save & exit    - Copy files back and exit
  Quit           - Exit WITHOUT saving changes
```

Press `Ctrl+C` twice quickly to force quit.
