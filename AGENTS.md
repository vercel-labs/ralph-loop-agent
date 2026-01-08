# Agent Instructions

## Package Management

**Always check the latest version before installing a package.**

Before adding or updating any dependency, verify the current latest version on npm:

```bash
npm view <package-name> version
```

Or check multiple packages at once:

```bash
npm view ai version
npm view @ai-sdk/provider-utils version
npm view zod version
```

This ensures we don't install outdated versions that may have incompatible types or missing features.

## AI Gateway

**Use AI Gateway string format for models, not provider packages.**

Do NOT install or import from provider-specific packages like `@ai-sdk/openai`, `@ai-sdk/anthropic`, etc.

Instead, use the AI Gateway string format: `{provider}/{model}`

```typescript
// CORRECT - Use AI Gateway strings
import { streamText } from 'ai';

const result = streamText({
  model: 'anthropic/claude-opus-4.5',
  prompt: 'Why is the sky blue?',
});

// INCORRECT - Don't use provider packages
import { anthropic } from '@ai-sdk/anthropic';  // DON'T DO THIS

const result = streamText({
  model: anthropic('claude-opus-4.5'),  // DON'T DO THIS
  prompt: 'Why is the sky blue?',
});
```

**Default model:** When examples need a model, default to `anthropic/claude-opus-4.5`.

Note: `@ai-sdk/provider-utils` is fine to use for types like `ModelMessage`, `SystemModelMessage`, etc.

<!-- opensrc:start -->

## Source Code Reference

Source code for dependencies is available in `opensrc/` for deeper understanding of implementation details.

See `opensrc/sources.json` for the list of available packages and their versions.

Use this source code when you need to understand how a package works internally, not just its types/interface.

### Fetching Additional Source Code

To fetch source code for a package or repository you need to understand, run:

```bash
npx opensrc <package>           # npm package (e.g., npx opensrc zod)
npx opensrc pypi:<package>      # Python package (e.g., npx opensrc pypi:requests)
npx opensrc crates:<package>    # Rust crate (e.g., npx opensrc crates:serde)
npx opensrc <owner>/<repo>      # GitHub repo (e.g., npx opensrc vercel/ai)
```

<!-- opensrc:end -->
