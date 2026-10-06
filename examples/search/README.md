# Web search with Parallel MCP

This example gives a `RalphLoopAgent` web search tools through the AI SDK's HTTP
MCP client. Run it explicitly when you want an answer grounded in web sources.
The core package and CLI example keep their existing behavior.

## Setup

From the repository root:

```bash
pnpm install
pnpm --filter ralph-loop-agent build
export AI_GATEWAY_API_KEY=your_gateway_key
pnpm --filter ralph-loop-agent-search-example search "What does RalphLoopAgent do? Include official sources."
```

The example uses the AI Gateway model format required by this repository.
Gateway inference requires credentials and may incur charges. Parallel search at
`https://search.parallel.ai/mcp` is free and anonymous at lower rate limits, with
no Parallel key or account required. Anonymous searches use Fast mode with
server-managed settings. See [Parallel's MCP documentation](https://docs.parallel.ai/integrations/mcp/search-mcp).

## How it works

`search.ts` creates an HTTP MCP client, discovers its tools, and passes them to
`RalphLoopAgent.tools`. The agent searches and returns an answer with source URLs.
It allows at most two outer iterations, retaining the core's inner tool limit.
Completion requires both nonempty text and a tool result. This is a demonstration
check, so inspect the answer and its sources before relying on it.

`index.ts` accepts a research question and passes a two-minute abort signal to the
agent loop. MCP initialization and discovery use the client's own request timeout.
The client closes in a `finally` block when discovery or execution fails, or when
the loop returns. Requests identify this example with the User-Agent
`ralph-loop-agent/search-example`. No dotenv file or saved settings are loaded.

`@ai-sdk/mcp` is pinned to 1.0.2 to match the provider utilities used by this
repository's locked AI SDK version. When updating AI SDK, update and validate the
MCP client alongside it.

## Validation

```bash
pnpm --filter ralph-loop-agent-search-example type-check
pnpm --filter ralph-loop-agent-search-example test
```

The tests exercise HTTP discovery, tool execution through `RalphLoopAgent.loop`,
a sourced answer, and session cleanup on success and discovery failure. They use
a deterministic model and a local fetch fixture, so they don't need credentials.

To also test the real anonymous endpoint:

```bash
TEST_SEARCH_LIVE=1 pnpm --filter ralph-loop-agent-search-example test
```

This still uses a deterministic model, but discovery and search run against
Parallel. It prints the returned evidence and observed request metadata, and
checks that requests carry the project User-Agent and no Authorization header.
It doesn't validate Gateway inference or measure answer quality. If your Node
runtime requires an HTTP proxy, configure its proxy support before running.
