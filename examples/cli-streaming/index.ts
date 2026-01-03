#!/usr/bin/env npx tsx
/**
 * CLI Example: Streaming Story Writer
 *
 * This example demonstrates using RalphLoopAgent's streaming capability
 * to write a short story with real-time output and abort signal support.
 *
 * Usage:
 *   npx tsx index.ts
 *   npx tsx index.ts "A robot who learns to paint"
 *
 * Press Ctrl+C to abort the generation.
 *
 * Environment:
 *   ANTHROPIC_API_KEY - Your Anthropic API key
 */

import { RalphLoopAgent, iterationCountIs, type VerifyCompletionContext } from 'ralph-wiggum';
import { tool } from 'ai';
import { z } from 'zod';

type Tools = typeof tools;

// ANSI codes
const cyan = '\x1b[36m';
const green = '\x1b[32m';
const yellow = '\x1b[33m';
const dim = '\x1b[2m';
const reset = '\x1b[0m';

// Track story progress
const storyParts: string[] = [];

const tools = {
  addChapter: tool({
    description: 'Add a chapter to the story',
    inputSchema: z.object({
      chapterNumber: z.number().describe('The chapter number'),
      title: z.string().describe('The chapter title'),
      content: z.string().describe('The chapter content (2-3 paragraphs)'),
    }),
    execute: async ({ chapterNumber, title, content }) => {
      const chapter = `\n${cyan}Chapter ${chapterNumber}: ${title}${reset}\n\n${content}\n`;
      storyParts.push(chapter);
      process.stdout.write(chapter);
      return { added: true, chapterNumber, title };
    },
  }),

  finishStory: tool({
    description: 'Mark the story as complete with a final message',
    inputSchema: z.object({
      ending: z.string().describe('A brief ending note or moral'),
    }),
    execute: async ({ ending }) => {
      const endingText = `\n${yellow}~ ${ending} ~${reset}\n`;
      storyParts.push(endingText);
      process.stdout.write(endingText);
      return { finished: true, ending };
    },
  }),
};

async function main() {
  const topic = process.argv[2] || 'A curious cat who discovers a hidden garden';

  console.log(`${cyan}╔════════════════════════════════════════════════════════════╗${reset}`);
  console.log(`${cyan}║          Ralph Wiggum Agent - Story Writer                 ║${reset}`);
  console.log(`${cyan}╚════════════════════════════════════════════════════════════╝${reset}`);
  console.log();
  console.log(`${dim}Topic: ${topic}${reset}`);
  console.log(`${dim}Press Ctrl+C to abort${reset}`);
  console.log();

  // Set up abort controller for Ctrl+C
  const controller = new AbortController();
  let aborted = false;

  process.on('SIGINT', () => {
    if (!aborted) {
      aborted = true;
      console.log(`\n${yellow}⚠ Aborting...${reset}`);
      controller.abort();
    }
  });

  // Track if story is finished
  let storyFinished = false;

  const agent = new RalphLoopAgent({
    model: 'anthropic/claude-sonnet-4-20250514' as any,
    instructions: `You are a creative storyteller.

Write a short story with 3 chapters about the given topic.
Use the addChapter tool to write each chapter.
When all chapters are written, use finishStory to complete the story.

Keep each chapter concise but engaging (2-3 paragraphs each).`,

    tools,

    stopWhen: iterationCountIs(3),

    verifyCompletion: async ({ result }: VerifyCompletionContext<Tools>) => {
      // Check if finishStory was called
      for (const step of result.steps) {
        for (const toolResult of step.toolResults) {
          if (
            toolResult.toolName === 'finishStory' &&
            typeof toolResult.output === 'object' &&
            toolResult.output !== null &&
            'finished' in toolResult.output
          ) {
            storyFinished = true;
          }
        }
      }

      if (storyFinished) {
        return { complete: true, reason: 'Story completed' };
      }

      return {
        complete: false,
        reason: 'Please finish the story using the finishStory tool.',
      };
    },

    onIterationStart: ({ iteration }: { iteration: number }) => {
      console.log(`${dim}[Iteration ${iteration}]${reset}`);
    },

    onIterationEnd: ({ iteration, duration }: { iteration: number; duration: number }) => {
      console.log(`${dim}[Iteration ${iteration} completed in ${duration}ms]${reset}`);
    },
  });

  const startTime = Date.now();

  try {
    // Use streaming for real-time output of the final iteration
    const stream = await agent.stream({
      prompt: `Write a short story about: ${topic}`,
      abortSignal: controller.signal,
    });

    // Stream the final text output
    console.log(`\n${green}━━━ Final thoughts ━━━${reset}\n`);

    for await (const chunk of stream.textStream) {
      process.stdout.write(chunk);
    }

    const totalDuration = Date.now() - startTime;

    console.log(`\n\n${green}━━━ Complete ━━━${reset}`);
    console.log(`${dim}Total time: ${totalDuration}ms${reset}`);
    console.log(`${dim}Story parts: ${storyParts.length}${reset}`);
  } catch (error: unknown) {
    const err = error as Error;
    if (err.name === 'AbortError' || aborted) {
      console.log(`\n${yellow}Story generation was aborted.${reset}`);

      if (storyParts.length > 0) {
        console.log(`${dim}Partial story (${storyParts.length} parts) was written.${reset}`);
      }
    } else {
      console.error(`\n${yellow}Error:${reset}`, err.message);
      process.exit(1);
    }
  }
}

main();
