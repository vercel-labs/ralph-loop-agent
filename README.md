# ralph-loop-agent

**Continuous Autonomy for the [AI SDK](https://ai-sdk.dev/)**

> **Note**: This package is experimental. APIs may change between versions.

## Packages

| Package | Description |
|---------|-------------|
| [ralph-loop-agent](./packages/ralph-loop-agent) | Core agent framework with loop control, stop conditions, and context management |

## Examples

| Example | Description |
|---------|-------------|
| [cli](./examples/cli) | Full-featured CLI agent with Vercel Sandbox, Playwright, PostgreSQL, and GitHub PR integration |

## Installation

```bash
npm install ralph-loop-agent ai zod
```

## What is the Ralph Wiggum Technique?

The Ralph Wiggum technique is a development methodology built around continuous AI agent loops. At its core, it's elegantly simple: keep feeding an AI agent a task until the job is done. As Geoffrey Huntley describes it: **"Ralph is a Bash loop."**

Named after the lovably persistent Ralph Wiggum from *The Simpsons*, this approach embraces iterative improvement over single-shot perfection. Where traditional agentic workflows stop when an LLM finishes calling tools, Ralph keeps going—verifying completion, providing feedback, and running another iteration until the task actually succeeds.

Think of it as `while (true)` for AI autonomy: the agent works, an evaluator checks the result, and if it's not done, the agent tries again with context from previous attempts.

```
┌──────────────────────────────────────────────────────┐
│                   Ralph Loop (outer)                 │
│  ┌────────────────────────────────────────────────┐  │
│  │  AI SDK Tool Loop (inner)                      │  │
│  │  LLM ↔ tools ↔ LLM ↔ tools ... until done      │  │
│  └────────────────────────────────────────────────┘  │
│                         ↓                            │
│  verifyCompletion: "Is the TASK actually complete?"  │
│                         ↓                            │
│       No? → Inject feedback → Run another iteration  │
│       Yes? → Return final result                     │
└──────────────────────────────────────────────────────┘
```

### Why Continuous Autonomy?

Standard AI SDK tool loops are great—but they stop as soon as the model finishes its tool calls. That works for simple tasks, but complex work often requires:

- **Verification**: Did the agent actually accomplish what was asked?
- **Persistence**: Retry on failure instead of giving up
- **Feedback loops**: Guide the agent based on real-world checks
- **Long-running tasks**: Migrations, refactors, multi-file changes

Ralph wraps the AI SDK's `generateText` in an outer loop that keeps iterating until your `verifyCompletion` function confirms success—or you hit a safety limit.

## Features

- **Iterative completion** — Runs until `verifyCompletion` says the task is done
- **Full AI SDK compatibility** — Uses AI Gateway string format, supports all AI SDK tools
- **Flexible stop conditions** — Limit by iterations, tokens, or cost
- **Context management** — Built-in summarization for long-running loops
- **Streaming support** — Stream the final iteration for responsive UIs
- **Feedback injection** — Failed verifications can guide the next attempt

## Usage

### Basic Example

```typescript
import { RalphLoopAgent, iterationCountIs } from 'ralph-loop-agent';

const agent = new RalphLoopAgent({
  model: 'anthropic/claude-opus-4.5',
  instructions: 'You are a helpful coding assistant.',
  stopWhen: iterationCountIs(10),
  verifyCompletion: async ({ result }) => ({
    complete: result.text.includes('DONE'),
    reason: 'Task completed successfully',
  }),
});

const { text, iterations, completionReason } = await agent.loop({
  prompt: 'Create a function that calculates fibonacci numbers',
});

console.log(text);
console.log(`Completed in ${iterations} iterations`);
console.log(`Reason: ${completionReason}`);
```

### Migration Example

```typescript
import { RalphLoopAgent, iterationCountIs } from 'ralph-loop-agent';

const migrationAgent = new RalphLoopAgent({
  model: 'anthropic/claude-opus-4.5',
  instructions: `You are migrating a codebase from Jest to Vitest.
    
    Completion criteria:
    - All test files use vitest imports
    - vitest.config.ts exists
    - All tests pass when running 'pnpm test'`,
  
  tools: { readFile, writeFile, execute },
  
  stopWhen: iterationCountIs(50),
  
  verifyCompletion: async () => {
    const checks = await Promise.all([
      fileExists('vitest.config.ts'),
      !await fileExists('jest.config.js'),
      noFilesMatch('**/*.test.ts', /from ['"]@jest/),
      fileContains('package.json', '"vitest"'),
    ]);
    
    return { 
      complete: checks.every(Boolean),
      reason: checks.every(Boolean) ? 'Migration complete' : 'Structural checks failed'
    };
  },

  onIterationStart: ({ iteration }) => console.log(`Starting iteration ${iteration}`),
  onIterationEnd: ({ iteration, duration }) => console.log(`Iteration ${iteration} completed in ${duration}ms`),
});

const result = await migrationAgent.loop({
  prompt: 'Migrate all Jest tests to Vitest.',
});

console.log(result.text);
console.log(result.iterations);
console.log(result.completionReason);
```

### With Tools

```typescript
import { RalphLoopAgent, iterationCountIs } from 'ralph-loop-agent';
import { tool } from 'ai';
import { z } from 'zod';

const agent = new RalphLoopAgent({
  model: 'anthropic/claude-opus-4.5',
  instructions: 'You help users with file operations.',
  tools: {
    readFile: tool({
      description: 'Read a file from disk',
      parameters: z.object({ path: z.string() }),
      execute: async ({ path }) => ({ content: '...' }),
    }),
    writeFile: tool({
      description: 'Write content to a file',
      parameters: z.object({ path: z.string(), content: z.string() }),
      execute: async ({ path, content }) => ({ success: true }),
    }),
  },
  stopWhen: iterationCountIs(10),
  verifyCompletion: ({ result }) => ({
    complete: result.text.includes('All files updated'),
  }),
});
```

### Streaming

```typescript
const stream = await agent.stream({
  prompt: 'Build a calculator',
});

for await (const chunk of stream.textStream) {
  process.stdout.write(chunk);
}
```

Note: Streaming runs non-streaming iterations until verification passes or the final iteration, then streams that last iteration.

## API Reference

### `RalphLoopAgent`

#### Constructor Options

| Option | Type | Required | Default | Description |
|--------|------|----------|---------|-------------|
| `model` | `LanguageModel` | ✅ | - | The AI model (AI Gateway string format) |
| `instructions` | `string` | ❌ | - | System prompt for the agent |
| `tools` | `ToolSet` | ❌ | - | Tools the agent can use |
| `stopWhen` | `IterationStopCondition` | ❌ | `iterationCountIs(10)` | When to stop the outer loop |
| `toolStopWhen` | `StopCondition` | ❌ | `stepCountIs(20)` | When to stop the inner tool loop |
| `verifyCompletion` | `function` | ❌ | - | Function to verify task completion |
| `onIterationStart` | `function` | ❌ | - | Called at start of each iteration |
| `onIterationEnd` | `function` | ❌ | - | Called at end of each iteration |

### Stop Conditions

Ralph provides multiple ways to limit agent execution:

#### `iterationCountIs(n)`

Stop after `n` iterations.

```typescript
import { iterationCountIs } from 'ralph-loop-agent';

stopWhen: iterationCountIs(50)
```

#### `tokenCountIs(n)`

Stop when total token usage (input + output) exceeds `n`.

```typescript
import { tokenCountIs } from 'ralph-loop-agent';

stopWhen: tokenCountIs(100_000)
```

#### `costIs(maxCost, rates?)`

Stop when estimated cost exceeds `maxCost`. Uses built-in pricing for common models, or accepts custom rates.

```typescript
import { costIs } from 'ralph-loop-agent';

// Stop at $5
stopWhen: costIs(5.00)

// With custom pricing
stopWhen: costIs(5.00, { inputTokenCost: 0.01, outputTokenCost: 0.03 })
```

#### Combining Stop Conditions

Pass an array to stop when *any* condition is met:

```typescript
stopWhen: [iterationCountIs(50), tokenCountIs(100_000), costIs(5.00)]
```

### `verifyCompletion`

Function to verify if the task is complete. Return `{ complete: true }` to stop the loop, or `{ complete: false, reason: "..." }` to continue with feedback:

```typescript
verifyCompletion: async ({ result, iteration, allResults, originalPrompt }) => ({
  complete: boolean,
  reason?: string, // Feedback if not complete, or explanation if complete
})
```

The `reason` string is injected into the next iteration, helping the agent understand what still needs work.

### Methods

**`loop(options)`** — Runs the agent loop until completion

```typescript
interface RalphLoopAgentResult {
  text: string;                              // Final output text
  iterations: number;                        // Number of iterations run
  completionReason: 'verified' | 'max-iterations' | 'aborted';
  reason?: string;                           // Reason from verifyCompletion
  result: GenerateTextResult;                // Full result from last iteration
  allResults: GenerateTextResult[];          // All iteration results
  totalUsage: LanguageModelUsage;            // Aggregated token usage
}
```

**`stream(options)`** — Streams the final iteration

Runs non-streaming iterations until verification passes, then streams the final one. Returns `StreamTextResult`.

## Using Claude Max Subscription (No API Key)

Ralph Loop Agent supports running without an API key by using the official [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript). This spawns Claude Code as a subprocess, authenticating with your Claude account.

### Installation

```bash
npm install ralph-loop-agent @anthropic-ai/claude-agent-sdk
```

Make sure you're authenticated with Claude Code:
```bash
claude auth login
```

### Usage

```typescript
import { runWithClaudeCode } from 'ralph-loop-agent/providers/claude-code';

const result = await runWithClaudeCode({
  prompt: 'Fix all TypeScript errors in the project',
  maxTurns: 10,
  permissionMode: 'acceptEdits',  // auto-accept file edits

  verifyCompletion: async ({ text }) => ({
    complete: text.includes('All errors fixed'),
    reason: 'Errors remain',
  }),

  onTurnStart: ({ turn }) => console.log(`Starting turn ${turn}`),
  onTurnEnd: ({ turn }) => console.log(`Completed turn ${turn}`),
});

console.log(`Completed in ${result.turns} turns`);
console.log(`Reason: ${result.completionReason}`);
console.log(`Cost: $${result.cost?.toFixed(4)} (covered by subscription)`);
```

### API Reference

#### `runWithClaudeCode(options)`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `prompt` | `string` | **required** | The task to complete |
| `maxTurns` | `number` | `10` | Maximum turns before stopping |
| `model` | `string` | CLI default | Claude model to use |
| `cwd` | `string` | `process.cwd()` | Working directory |
| `permissionMode` | `'default' \| 'acceptEdits' \| 'bypassPermissions'` | `'acceptEdits'` | How to handle permissions |
| `systemPromptAppend` | `string` | - | Text to append to system prompt |
| `verifyCompletion` | `function` | - | Verification callback |
| `onTurnStart` | `function` | - | Called at turn start |
| `onTurnEnd` | `function` | - | Called at turn end |

#### Return Value

```typescript
interface ClaudeCodeResult {
  text: string;                    // Final output text
  turns: number;                   // Turns executed
  completionReason: 'verified' | 'max-turns' | 'error';
  reason?: string;                 // Reason from verification
  cost?: number;                   // Cost (covered by subscription)
  allMessages: SDKMessage[];       // All SDK messages
}
```

### Benefits

- **No API key required** - Uses your Claude Max subscription
- **Full Claude Code tools** - Access to Bash, Read, Edit, Grep, etc.
- **Permission control** - Auto-accept edits or prompt for approval
- **Cost tracking** - See usage (covered by subscription, not billed separately)

## License

Apache-2.0
