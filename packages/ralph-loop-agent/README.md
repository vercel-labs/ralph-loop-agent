# ralph-loop-agent

> **Note**: This package is experimental. APIs may change between versions.

A framework for building autonomous AI agents that iterate until a task is complete. Implements the "Ralph Wiggum" technique - an iterative approach with verification at each step.

## Installation

```bash
npm install ralph-loop-agent zod
# or
pnpm add ralph-loop-agent zod
```

**Note**: `zod` is a peer dependency required for tool schemas.

## Quick Start

```typescript
import { RalphLoopAgent, iterationCountIs } from 'ralph-loop-agent';
import { tool } from 'ai';
import { z } from 'zod';

// Define your tools
const tools = {
  readFile: tool({
    description: 'Read a file',
    parameters: z.object({ path: z.string() }),
    execute: async ({ path }) => {
      // Your implementation
      return { content: '...' };
    },
  }),
  writeFile: tool({
    description: 'Write a file',
    parameters: z.object({ path: z.string(), content: z.string() }),
    execute: async ({ path, content }) => {
      // Your implementation
      return { success: true };
    },
  }),
  markComplete: tool({
    description: 'Mark the task as complete',
    parameters: z.object({ summary: z.string() }),
    execute: async ({ summary }) => {
      return { complete: true, summary };
    },
  }),
};

// Create the agent
const agent = new RalphLoopAgent({
  model: 'anthropic/claude-opus-4.5',
  instructions: 'You are a coding assistant. Complete tasks and use markComplete when done.',
  tools,
  stopWhen: iterationCountIs(20),
  verifyCompletion: async ({ result }) => {
    // Check if markComplete was called
    for (const step of result.steps) {
      for (const toolResult of step.toolResults) {
        if (toolResult.toolName === 'markComplete') {
          return { complete: true, reason: 'Task marked complete' };
        }
      }
    }
    return { complete: false, reason: 'Continue working' };
  },
});

// Run the agent
const result = await agent.loop({
  prompt: 'Create a hello world function in hello.ts',
});

console.log(`Completed in ${result.iterations} iterations`);
console.log(`Reason: ${result.completionReason}`);
```

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Ralph Loop Agent                      │
├─────────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────────┐    │
│  │              Outer Loop (Ralph)                  │    │
│  │  - Runs iterations until verified complete       │    │
│  │  - Calls verifyCompletion after each iteration   │    │
│  │  - Manages context/summarization                 │    │
│  │                                                  │    │
│  │  ┌─────────────────────────────────────────┐    │    │
│  │  │        Inner Loop (Tool Loop)           │    │    │
│  │  │  - Executes LLM calls                   │    │    │
│  │  │  - Runs tools                           │    │    │
│  │  │  - Continues until step limit           │    │    │
│  │  └─────────────────────────────────────────┘    │    │
│  └─────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────┘
```

## API Reference

### `RalphLoopAgent`

The main agent class.

```typescript
const agent = new RalphLoopAgent<TOOLS>({
  // Required
  model: 'anthropic/claude-opus-4.5',  // AI Gateway format
  instructions: string,                 // System prompt
  tools: TOOLS,                         // Tool definitions

  // Optional
  id?: string,                          // Agent identifier
  stopWhen?: RalphStopCondition,        // When to stop iterating
  verifyCompletion?: VerifyCompletionFunction,  // Completion check
  onIterationStart?: (ctx) => void,     // Called before each iteration
  onIterationEnd?: (ctx) => void,       // Called after each iteration
  onContextSummarized?: (ctx) => void,  // Called when context is compressed

  // Context management (for long tasks)
  contextManagement?: {
    maxContextTokens?: number,          // Default: 150,000
    enableSummarization?: boolean,      // Default: true
    recentIterationsToKeep?: number,    // Default: 2
    maxFileChars?: number,              // Default: 30,000
    changeLogBudget?: number,           // Default: 5,000
    fileContextBudget?: number,         // Default: 50,000
  },
});
```

### `agent.loop(params)`

Run the agent loop.

```typescript
const result = await agent.loop({
  prompt: 'Your task description',
  abortSignal?: AbortSignal,  // For cancellation
});

// Result shape
{
  text: string,                    // Final text output
  iterations: number,              // How many iterations ran
  completionReason: 'verified' | 'max-iterations' | 'aborted',
  reason?: string,                 // From verifyCompletion
  result: GenerateTextResult,      // Last iteration result
  allResults: GenerateTextResult[], // All iteration results
  totalUsage: LanguageModelUsage,  // Aggregated token usage
}
```

### `agent.stream(params)`

Stream the agent loop (returns an async iterable).

```typescript
const stream = agent.stream({
  prompt: 'Your task description',
});

for await (const chunk of stream) {
  // Handle streaming chunks
}

// Get final result
const result = await stream.result;
```

## Stop Conditions

Control when the agent stops iterating:

```typescript
import { 
  iterationCountIs, 
  tokenCountIs, 
  inputTokenCountIs,
  outputTokenCountIs,
  costIs 
} from 'ralph-loop-agent';

// Stop after N iterations
stopWhen: iterationCountIs(20)

// Stop after N total tokens
stopWhen: tokenCountIs(100_000)

// Stop after N input tokens
stopWhen: inputTokenCountIs(80_000)

// Stop after N output tokens
stopWhen: outputTokenCountIs(20_000)

// Stop after $X spent (auto-detects model pricing)
stopWhen: costIs(5.00)

// Stop after $X with explicit model
stopWhen: costIs(5.00, 'anthropic/claude-opus-4.5')

// Stop after $X with custom rates
stopWhen: costIs(5.00, {
  inputCostPerMillionTokens: 5.0,
  outputCostPerMillionTokens: 25.0,
})

// Combine multiple conditions (any triggers stop)
stopWhen: [iterationCountIs(50), costIs(10.00)]
```

## Verification Function

Define when a task is complete:

```typescript
verifyCompletion: async ({ result, iteration, allResults, originalPrompt }) => {
  // Check tool results
  for (const step of result.steps) {
    for (const toolResult of step.toolResults) {
      if (toolResult.toolName === 'markComplete') {
        return { complete: true, reason: 'Task complete!' };
      }
    }
  }

  // Check output text
  if (result.text.includes('ERROR')) {
    return { complete: false, reason: 'Error detected, please fix' };
  }

  // Continue iterating
  return { complete: false, reason: 'Keep working on the task' };
}
```

## Context Management

For long-running tasks, enable auto-summarization:

```typescript
const agent = new RalphLoopAgent({
  // ...
  contextManagement: {
    maxContextTokens: 180_000,      // Leave room for output
    enableSummarization: true,      // Compress old iterations
    recentIterationsToKeep: 2,      // Keep last 2 in full detail
    changeLogBudget: 8_000,         // Tokens for change log
    fileContextBudget: 60_000,      // Tokens for file cache
  },
  onContextSummarized: ({ iteration, summarizedIterations, tokensSaved }) => {
    console.log(`Compressed ${summarizedIterations} iterations, saved ${tokensSaved} tokens`);
  },
});
```

## Lifecycle Callbacks

Monitor agent progress:

```typescript
const agent = new RalphLoopAgent({
  // ...
  onIterationStart: ({ iteration }) => {
    console.log(`Starting iteration ${iteration}`);
  },
  onIterationEnd: ({ iteration, duration, result }) => {
    console.log(`Iteration ${iteration} took ${duration}ms`);
    console.log(`Tokens: ${result.usage.totalTokens}`);
  },
});
```

## Utility Functions

### Token/Cost Calculation

```typescript
import { 
  getModelPricing, 
  calculateCost, 
  addLanguageModelUsage,
  estimateTokens,
} from 'ralph-loop-agent';

// Get pricing for a model
const pricing = getModelPricing('anthropic/claude-opus-4.5');
// { inputCostPerMillionTokens: 5.0, outputCostPerMillionTokens: 25.0 }

// Calculate cost from usage
const cost = calculateCost(usage, pricing);

// Combine usage from multiple calls
const totalUsage = addLanguageModelUsage(usage1, usage2);

// Estimate tokens for text
const tokens = estimateTokens('Hello world');
```

## Model Support

Uses AI Gateway format for model identifiers:

| Provider | Model ID |
|----------|----------|
| Anthropic | `anthropic/claude-opus-4.5`, `anthropic/claude-sonnet-4` |
| OpenAI | `openai/gpt-4o`, `openai/o1`, `openai/o3-mini` |
| Google | `google/gemini-2.5-pro`, `google/gemini-2.0-flash` |
| xAI | `xai/grok-3`, `xai/grok-3-mini` |
| DeepSeek | `deepseek/deepseek-chat`, `deepseek/deepseek-reasoner` |

## License

Apache-2.0

