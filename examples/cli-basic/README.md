# CLI Basic Example

A command-line math problem solver using RalphLoopAgent.

## What This Demonstrates

- Creating a `RalphLoopAgent` with tools
- Using `iterationCountIs()` to limit iterations
- Custom `verifyCompletion` function for task verification
- Progress callbacks with `onIterationStart` and `onIterationEnd`
- Processing the result including iteration count and completion reason

## Setup

```bash
# Install dependencies
pnpm install

# Set your API key
export ANTHROPIC_API_KEY=your_api_key_here
```

## Usage

```bash
# Run with default problem
pnpm start

# Run with custom problem
pnpm start "What is 2^10 + 3^5?"

# Or directly with tsx
npx tsx index.ts "Calculate the factorial of 7"
```

## Example Output

```
╔════════════════════════════════════════════════════════════╗
║         Ralph Wiggum Agent - Math Problem Solver           ║
╚════════════════════════════════════════════════════════════╝

━━━ Problem ━━━
Calculate the sum of the first 10 prime numbers

━━━ Starting Agent ━━━
The agent will iterate until the answer is verified...

━━━ Iteration 1 ━━━
  📦 Stored: sum_10_primes = 129
  ✅ Verified: 129
  ⏱️  Duration: 3421ms
  💭 I'll solve this step by step...

━━━ Result ━━━
Completion: verified
Iterations: 1
Total time: 3421ms
Reason: Answer verified: 129

━━━ Final Answer ━━━
The sum of the first 10 prime numbers (2, 3, 5, 7, 11, 13, 17, 19, 23, 29) is **129**.

VERIFIED

━━━ Tool Usage Summary ━━━
Total tool calls: 12
```

## How It Works

1. The agent receives a math problem
2. It uses the `calculate` tool to perform arithmetic
3. The `storeResult` tool tracks intermediate values
4. When confident, it calls `verifyAnswer` to confirm
5. The `verifyCompletion` function checks if verification happened
6. If not verified, the agent tries again (up to 5 iterations)

