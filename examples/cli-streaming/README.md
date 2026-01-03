# CLI Streaming Example

A streaming story writer using RalphLoopAgent.

## What This Demonstrates

- Using `agent.stream()` for real-time streaming output
- `AbortSignal` for cancellation with Ctrl+C
- Tools that write output directly to stdout
- Graceful handling of aborted operations

## Setup

```bash
# Install dependencies
pnpm install

# Set your API key
export ANTHROPIC_API_KEY=your_api_key_here
```

## Usage

```bash
# Run with default topic
pnpm start

# Run with custom topic
pnpm start "A time-traveling chef"

# Press Ctrl+C to abort at any time
```

## Example Output

```
╔════════════════════════════════════════════════════════════╗
║          Ralph Wiggum Agent - Story Writer                 ║
╚════════════════════════════════════════════════════════════╝

Topic: A curious cat who discovers a hidden garden
Press Ctrl+C to abort

[Iteration 1]

Chapter 1: The Mysterious Wall

Whiskers had always been drawn to the old ivy-covered wall at the edge 
of the garden. While the other cats napped in sunbeams, she would sit 
for hours, watching the leaves rustle with secrets.

One autumn morning, as golden light filtered through the branches, 
she noticed something she'd never seen before: a small gap where 
the stones had crumbled away...

Chapter 2: Through the Gap

Heart pounding, Whiskers squeezed through the narrow opening...

Chapter 3: The Garden's Secret

The hidden garden was unlike anything Whiskers had ever seen...

~ Sometimes the greatest adventures await just beyond what we think we know. ~

[Iteration 1 completed in 8234ms]

━━━ Final thoughts ━━━

The story is complete! Whiskers discovered that curiosity, far from 
being dangerous, can lead to the most wonderful discoveries.

━━━ Complete ━━━
Total time: 8234ms
Story parts: 4
```

## How Streaming Works

1. The agent runs non-streaming iterations until `verifyCompletion` passes
2. The final iteration is streamed to provide real-time output
3. Tool calls during streaming still execute normally
4. If aborted, partial results may still be available

