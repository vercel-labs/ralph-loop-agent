# Examples

This directory contains example projects demonstrating how to use `ralph-wiggum`.

## Examples

| Example | Description |
|---------|-------------|
| [cli-basic](./cli-basic) | Simple CLI math problem solver with tools and verification |
| [cli-streaming](./cli-streaming) | Streaming output with abort signal support |

## Running Examples

Each example is a standalone project. To run one:

```bash
cd examples/cli-basic
pnpm install
pnpm start
```

## Environment Variables

Most examples require an API key for the model provider:

```bash
export ANTHROPIC_API_KEY=your_key_here
```

