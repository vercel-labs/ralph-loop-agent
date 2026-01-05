# Examples

This directory contains example projects demonstrating how to use `ralph-wiggum`.

## Examples

| Example | Description |
|---------|-------------|
| [cli](./cli) | General-purpose autonomous coding agent for migrations, upgrades, refactoring, etc. |

## Running the CLI Example

```bash
cd examples/cli
pnpm install
pnpm start -- /path/to/your/project
```

Or with a specific prompt:

```bash
pnpm start -- /path/to/project "Migrate from Jest to Vitest"
```

Or create a `PROMPT.md` file in your target project and run:

```bash
pnpm start -- /path/to/project
```

## Environment Variables

The CLI requires the following environment variables:

```bash
# AI Gateway API key (uses AI Gateway, not provider-specific packages)
export AI_GATEWAY_API_KEY=your_api_key_here

# Vercel Sandbox (for secure code execution)
export SANDBOX_VERCEL_TOKEN=your_vercel_token
export SANDBOX_VERCEL_TEAM_ID=your_team_id
export SANDBOX_VERCEL_PROJECT_ID=your_project_id
```

You can also create a `.env` file in the `examples/cli` directory with these values.
