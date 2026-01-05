/**
 * Plan Mode - Conversational task planning inspired by Cursor's Plan Mode
 *
 * Instead of rigid forms, users describe their task naturally.
 * The AI explores the codebase, asks clarifying questions only when needed,
 * and generates an approvable plan.
 *
 * Uses just-bash with OverlayFs for read-only codebase exploration,
 * avoiding the need for a Vercel sandbox during the planning phase.
 */

import { streamText, generateText, stepCountIs } from 'ai';
import prompts from 'prompts';

// Message type for conversation history
type Message = { role: 'user' | 'assistant' | 'system'; content: string };
import { createInterviewerTools } from './tools/interviewer.js';
import { createInterviewBash } from './interview-bash.js';
import { log, colors } from './logger.js';

interface PlanModeResult {
  prompt: string;
  saveToFile: boolean;
}

/**
 * Check if an error is an AI Gateway authentication error.
 */
function isAuthError(error: unknown): boolean {
  if (error && typeof error === 'object' && 'name' in error) {
    return (error as { name: string }).name === 'GatewayAuthenticationError';
  }
  return false;
}

/**
 * Handle AI errors gracefully.
 */
function handleAIError(error: unknown): never {
  if (isAuthError(error)) {
    console.log();
    log('━━━ Authentication Error ━━━', 'red');
    log('Missing or invalid AI_GATEWAY_API_KEY environment variable.', 'yellow');
    console.log();
    log('To fix this, set your API key:', 'dim');
    log('  export AI_GATEWAY_API_KEY=your-api-key', 'bright');
    console.log();
    log('Or add it to your .env file:', 'dim');
    log('  AI_GATEWAY_API_KEY=your-api-key', 'bright');
    console.log();
    process.exit(1);
  }

  // For other errors, re-throw
  throw error;
}

/**
 * Run the conversational Plan Mode experience.
 *
 * @param localDir - The local directory to explore (uses just-bash with OverlayFs)
 */
export async function runPlanMode(localDir: string): Promise<PlanModeResult> {
  console.log();
  log('╭───────────────────────────────────────────────────────────────╮', 'dim');
  log('│  Plan Mode - Describe your task and I\'ll create a plan       │', 'dim');
  log('╰───────────────────────────────────────────────────────────────╯', 'dim');
  console.log();

  // Handle Ctrl+C gracefully
  const onCancel = () => {
    log('\nCancelled.', 'yellow');
    process.exit(0);
  };

  // Step 1: Get the user's natural language description
  const { taskDescription } = await prompts({
    type: 'text',
    name: 'taskDescription',
    message: 'What would you like to do?',
    validate: (v: string) => v.trim().length > 0 || 'Please describe your task',
  }, { onCancel });

  // Create a read-only bash shell for codebase exploration using just-bash
  // This avoids needing the Vercel sandbox during the interview phase
  const interviewBash = createInterviewBash(localDir);

  // Conversation history for multi-turn dialogue
  const conversationHistory: Message[] = [];
  const interviewerTools = createInterviewerTools(interviewBash);

  // Step 2: AI explores codebase and potentially asks questions
  console.log();
  log('  ○ Exploring codebase...', 'dim');

  const systemPrompt = `You are a senior software engineer helping plan a coding task. You have tools to explore the codebase.

## Your Process

1. **EXPLORE** - Use your tools to understand the codebase:
   - List the root directory to see structure
   - Read package.json, README.md, and key config files
   - Explore relevant directories based on the task
   - Understand the tech stack, patterns, and conventions

2. **CLARIFY** (only if genuinely needed) - If the task is ambiguous or missing critical information:
   - Ask 1-3 SHORT, specific questions
   - Format questions as a bullet list
   - Only ask questions that would significantly change the plan
   - Skip this if you have enough context

3. **PLAN** - Generate a comprehensive task plan in markdown format

## Plan Format

When you're ready to generate the plan, output it in this EXACT format:

\`\`\`plan
# [Descriptive Title]

## Goal
[One paragraph describing the high-level outcome]

## Scope
[What will and won't be changed]

## Steps
1. [First step]
2. [Second step]
...

## Verification
- [How to verify success]
- [What tests to run]

## Success Criteria
- [Clear, measurable criteria]
\`\`\`

## Important Rules

- Be concise - users don't want to read walls of text
- Only ask questions if you GENUINELY need clarification
- Base your plan on what you DISCOVER in the codebase, not assumptions
- The plan should be actionable and specific to THIS codebase`;

  // Phase 1: Exploration and potential clarification loop
  let plan: string | null = null;
  let currentUserMessage = taskDescription;

  while (!plan) {
    conversationHistory.push({
      role: 'user',
      content: currentUserMessage,
    });

    try {
      // Stream the AI's response
      const stream = streamText({
        model: 'anthropic/claude-opus-4.5' as any,
        system: systemPrompt,
        messages: conversationHistory,
        tools: interviewerTools,
        stopWhen: stepCountIs(15),
        onStepFinish: ({ toolCalls }) => {
          // Log tool usage in real-time
          for (const call of toolCalls) {
            if (call.toolName === 'listDirectory') {
              const input = call.input as { dirPath?: string };
              const dir = input?.dirPath || '.';
              process.stdout.write(`${colors.dim}  ○ Listing ${dir}...${colors.reset}\n`);
            } else if (call.toolName === 'readFile') {
              const input = call.input as { filePath: string };
              const file = input?.filePath;
              process.stdout.write(`${colors.dim}  ○ Reading ${file}...${colors.reset}\n`);
            } else if (call.toolName === 'listFiles') {
              const input = call.input as { pattern: string };
              const pattern = input?.pattern;
              process.stdout.write(`${colors.dim}  ○ Finding ${pattern}...${colors.reset}\n`);
            }
          }
        },
      });

      // Collect the full response
      let fullResponse = '';
      try {
        for await (const chunk of stream.textStream) {
          fullResponse += chunk;
        }
      } catch (streamError) {
        handleAIError(streamError);
      }

      // Check if response contains a plan
      const planMatch = fullResponse.match(/```plan\n([\s\S]*?)```/);
      if (planMatch) {
        plan = planMatch[1].trim();
        conversationHistory.push({
          role: 'assistant',
          content: fullResponse,
        });
        break;
      }

      // Check if AI is asking clarifying questions
      const hasQuestions = fullResponse.includes('?') && 
        (fullResponse.includes('•') || fullResponse.includes('-') || fullResponse.includes('1.'));

      if (hasQuestions) {
        // Display the questions
        console.log();
        log('─'.repeat(60), 'dim');
        console.log(fullResponse);
        log('─'.repeat(60), 'dim');
        console.log();

        conversationHistory.push({
          role: 'assistant',
          content: fullResponse,
        });

        // Get user's response to questions
        const { answer } = await prompts({
          type: 'text',
          name: 'answer',
          message: 'Your response',
          validate: (v: string) => v.trim().length > 0 || 'Please provide an answer',
        }, { onCancel });

        currentUserMessage = answer;
      } else {
        // No plan and no questions - something unexpected, try to get a plan directly
        conversationHistory.push({
          role: 'assistant',
          content: fullResponse,
        });
        currentUserMessage = 'Please generate the plan now.';
      }
    } catch (error) {
      handleAIError(error);
    }
  }

  // Step 3: Display the plan for review
  console.log();
  log('═'.repeat(60), 'cyan');
  log('  PLAN', 'bright');
  log('═'.repeat(60), 'cyan');
  console.log();
  console.log(plan);
  console.log();
  log('═'.repeat(60), 'cyan');
  console.log();

  // Step 4: Review loop - approve, refine, or cancel
  let approved = false;
  let finalPlan = plan;

  while (!approved) {
    const { action } = await prompts({
      type: 'select',
      name: 'action',
      message: 'What would you like to do?',
      choices: [
        { title: 'Approve - Start the task', value: 'approve' },
        { title: 'Refine - Modify the plan', value: 'refine' },
        { title: 'Cancel - Exit', value: 'cancel' },
      ],
    }, { onCancel });

    if (action === 'approve') {
      approved = true;
    } else if (action === 'cancel') {
      log('Cancelled.', 'yellow');
      process.exit(0);
    } else if (action === 'refine') {
      // Get refinement feedback
      const { feedback } = await prompts({
        type: 'text',
        name: 'feedback',
        message: 'What changes would you like?',
        validate: (v: string) => v.trim().length > 0 || 'Please describe what to change',
      }, { onCancel });

      console.log();
      log('  ○ Refining plan...', 'dim');

      // Add feedback to conversation and regenerate
      conversationHistory.push({
        role: 'user',
        content: `Please revise the plan based on this feedback: ${feedback}

Remember to output the revised plan in the exact same format:
\`\`\`plan
...
\`\`\``,
      });

      try {
        const refinedResult = await generateText({
          model: 'anthropic/claude-opus-4.5' as any,
          system: systemPrompt,
          messages: conversationHistory,
          tools: interviewerTools,
          stopWhen: stepCountIs(5),
        });

        const refinedPlanMatch = refinedResult.text.match(/```plan\n([\s\S]*?)```/);
        if (refinedPlanMatch) {
          finalPlan = refinedPlanMatch[1].trim();
          conversationHistory.push({
            role: 'assistant',
            content: refinedResult.text,
          });
        }
      } catch (error) {
        handleAIError(error);
      }

      // Display refined plan
      console.log();
      log('═'.repeat(60), 'cyan');
      log('  REVISED PLAN', 'bright');
      log('═'.repeat(60), 'cyan');
      console.log();
      console.log(finalPlan);
      console.log();
      log('═'.repeat(60), 'cyan');
      console.log();
    }
  }

  // Step 5: Ask about saving
  const { saveToFile } = await prompts({
    type: 'confirm',
    name: 'saveToFile',
    message: 'Save as PROMPT.md in the target directory?',
    initial: true,
  }, { onCancel });

  // Convert the plan to a proper prompt format
  const prompt = formatPlanAsPrompt(finalPlan);

  return { prompt, saveToFile };
}

/**
 * Convert the plan format to a prompt format suitable for the coding agent.
 */
function formatPlanAsPrompt(plan: string): string {
  // The plan is already in markdown format, just add guidelines
  const lines = plan.split('\n');
  const promptLines: string[] = [];

  for (const line of lines) {
    promptLines.push(line);
  }

  // Add standard guidelines
  promptLines.push('');
  promptLines.push('## Guidelines');
  promptLines.push('- Read files before modifying them');
  promptLines.push('- Make incremental changes');
  promptLines.push('- Use `editFile` for small changes instead of rewriting entire files');
  promptLines.push('- Verify changes work before moving on');

  return promptLines.join('\n');
}
