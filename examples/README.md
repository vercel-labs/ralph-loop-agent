# Examples

> **Note**: This package is experimental. APIs may change between versions.

This directory contains example projects demonstrating how to use `ralph-loop-agent`.

## Examples

| Example | Description |
|---------|-------------|
| [cli](./cli) | General-purpose autonomous coding agent for migrations, upgrades, refactoring, etc. |

## Running the CLI Example

```bash
cd examples/cli
pnpm install
```

### Local Directory

```bash
# Interactive Plan Mode
pnpm cli /path/to/your/project

# With a specific prompt
pnpm cli /path/to/project "Migrate from Jest to Vitest"

# With a prompt file
pnpm cli /path/to/project ./task.md
```

### GitHub Repository

Clone a repo, run the task, and create a PR:

```bash
pnpm cli https://github.com/owner/repo "Upgrade dependencies"
pnpm cli https://github.com/owner/repo ./task.md
```

### Using PROMPT.md

Create a `PROMPT.md` file in your target project describing the task, then run:

```bash
pnpm cli /path/to/project
```

## Environment Variables

The CLI requires the following environment variables. Create a `.env` file in `examples/cli/`:

```bash
# Vercel Sandbox (required for isolated code execution)
SANDBOX_VERCEL_TOKEN=your_vercel_token
SANDBOX_VERCEL_TEAM_ID=your_team_id
SANDBOX_VERCEL_PROJECT_ID=your_project_id
```

### Optional: GitHub CLI

For automatic PR creation when using GitHub repo URLs:

```bash
# Install
brew install gh

# Authenticate
gh auth login
```
