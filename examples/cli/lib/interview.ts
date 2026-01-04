/**
 * Interactive interview for task definition
 */

import { generateText, stepCountIs } from 'ai';
import prompts from 'prompts';
import { createInterviewerTools } from './tools/interviewer.js';
import { readFromSandbox, writeToSandbox } from './sandbox.js';
import { log } from './logger.js';
import { TASK_TYPES, VERIFICATION_METHODS } from './constants.js';

// Cache for codebase analysis (explored once, reused for all questions)
let codebaseAnalysis: string | null = null;

/**
 * Explore the codebase once and cache the analysis.
 */
async function exploreCodebase(taskType: string, title: string, techStack?: string): Promise<string> {
  if (codebaseAnalysis) {
    return codebaseAnalysis;
  }

  log('  🔍 AI exploring codebase...', 'cyan');

  try {
    const interviewerTools = createInterviewerTools();
    const result = await generateText({
      model: 'anthropic/claude-opus-4.5' as any,
      tools: interviewerTools,
      stopWhen: stepCountIs(15),
      messages: [
        {
          role: 'system',
          content: `You are analyzing a codebase to help define a coding task. Explore the project thoroughly.

## Process:
1. Call listDirectory to see the project structure
2. Call readFile on package.json if it exists
3. Read README.md if it exists
4. List key directories (src/, app/, components/, etc.)
5. Read a few important files to understand the architecture

At the end, provide a comprehensive summary of what you found.`,
        },
        {
          role: 'user',
          content: `I want to: ${title} (${taskType})
${techStack ? `Tech stack: ${techStack}` : ''}

Please explore this codebase and give me a summary of:
- What kind of project this is
- Key technologies/frameworks used
- Important directories and files
- Current architecture/patterns`,
        },
      ],
    });

    // Count tool calls for logging
    let toolCallCount = 0;
    for (const step of result.steps) {
      toolCallCount += step.toolResults.length;
    }
    log(`     ✓ Explored (${toolCallCount} files/dirs checked)`, 'dim');

    codebaseAnalysis = result.text || 'Unable to analyze codebase';
    return codebaseAnalysis;
  } catch (error) {
    log(`     ⚠️ Error exploring: ${error}`, 'yellow');
    codebaseAnalysis = 'New or empty project';
    return codebaseAnalysis;
  }
}

/**
 * Generate suggestions for a question using cached codebase analysis.
 */
async function generateSuggestions(
  question: string,
  context: { taskType: string; title: string; techStack?: string; codebaseAnalysis: string }
): Promise<string[]> {
  try {
    const result = await generateText({
      model: 'anthropic/claude-opus-4.5' as any,
      messages: [
        {
          role: 'system',
          content: `Generate SHORT, DISTINCT suggestions for a coding task question.

Rules:
- Each suggestion must be DIFFERENT (not variations of the same idea)
- Keep each under 15 words
- Focus on WHAT to achieve, not HOW to implement
- Only include suggestions that genuinely make sense for this project
- Return 1-5 suggestions based on what's relevant (don't force a number)
- One suggestion per line, no bullets or numbers`,
        },
        {
          role: 'user',
          content: `Task: ${context.title}

Project: ${context.codebaseAnalysis.slice(0, 1500)}

Question: ${question}`,
        },
      ],
      maxOutputTokens: 250,
    });

    const suggestions = result.text
      .split('\n')
      .map(s => s.replace(/^[\d\-\*\.\)]+\s*/, '').trim())
      .filter(s => s.length > 5 && s.length < 120)
      .slice(0, 5);

    return suggestions.length > 0 ? suggestions : ['Define the core requirement'];
  } catch {
    return ['Define the core requirement'];
  }
}

/**
 * Create a multi-selection prompt with AI-generated options + "Other" + "Skip".
 */
async function selectWithAI(
  message: string,
  aiQuestion: string,
  context: { taskType: string; title: string; techStack?: string; codebaseAnalysis: string },
  onCancel: () => void
): Promise<string> {
  const suggestions = await generateSuggestions(aiQuestion, context);
  
  const choices = [
    ...suggestions.map(s => ({ title: s, value: s })),
    { title: '✏️  Other (add custom)', value: '__other__' },
    { title: '⏭️  Skip this question', value: '__skip__' },
  ];

  const { selections } = await prompts({
    type: 'multiselect',
    name: 'selections',
    message,
    choices,
    hint: '- Space to select, Enter to confirm',
    instructions: false,
  }, { onCancel });

  // If skip was selected, return empty
  if (selections?.includes('__skip__')) {
    return '';
  }

  const results: string[] = selections?.filter((s: string) => s !== '__other__' && s !== '__skip__') || [];

  // If "Other" was selected, prompt for custom input
  if (selections?.includes('__other__')) {
    const { custom } = await prompts({
      type: 'text',
      name: 'custom',
      message: 'Add your own:',
    }, { onCancel });
    if (custom) {
      results.push(custom);
    }
  }

  // If nothing selected, that's okay - return empty
  if (results.length === 0) {
    return '';
  }

  return results.join('. ');
}

/**
 * Run the interactive interview to generate a task prompt.
 */
export async function runInterview(): Promise<{ prompt: string; saveToFile: boolean }> {
  console.log();
  log('Let\'s define your task. Press Ctrl+C to cancel at any time.', 'dim');
  console.log();

  // Handle Ctrl+C gracefully
  prompts.override({});
  const onCancel = () => {
    log('\nCancelled.', 'yellow');
    process.exit(0);
  };

  // Step 1 & 2: Task type and title (user-defined)
  const { taskType, title } = await prompts([
    {
      type: 'select',
      name: 'taskType',
      message: 'What type of task is this?',
      choices: TASK_TYPES,
      initial: 0,
    },
    {
      type: 'text',
      name: 'title',
      message: 'Give your task a short title:',
      initial: (prev: string) => {
        const type = TASK_TYPES.find(t => t.value === prev);
        return type ? `${type.title}: ` : '';
      },
      validate: (value: string) => value.length > 0 || 'Title is required',
    },
  ], { onCancel });

  // If creating a new project, ask about tech stack
  let techStack = '';
  if (taskType === 'create') {
    const { stack } = await prompts({
      type: 'text',
      name: 'stack',
      message: 'What tech stack? (e.g., Next.js, React + Vite, Node.js + Express)',
      validate: (v: string) => v.length > 0 || 'Please specify a tech stack',
    }, { onCancel });
    techStack = stack;
  }

  // Explore codebase ONCE at the start
  const analysis = await exploreCodebase(taskType, title, techStack);
  const aiContext = { taskType, title, techStack, codebaseAnalysis: analysis };

  // Step 3: Goal (AI-suggested) - high level, what to achieve
  const goal = await selectWithAI(
    'What is the goal?',
    'What is the high-level outcome or goal? Focus on WHAT, not how.',
    aiContext,
    onCancel
  );

  // Step 4: Requirements (AI-suggested) - key requirements
  const requirements = await selectWithAI(
    'Any specific requirements?',
    'What specific requirements or constraints should be met?',
    aiContext,
    onCancel
  );

  // Step 5: Verification (user-defined multiselect - keeping as is)
  const { verification } = await prompts({
    type: 'multiselect',
    name: 'verification',
    message: 'How should success be verified?',
    choices: VERIFICATION_METHODS,
    hint: '- Space to select, Enter to confirm',
    instructions: false,
  }, { onCancel });

  // Step 6: Success criteria (AI-suggested) - what does done look like
  const successCriteria = await selectWithAI(
    'What does done look like?',
    'How will we know this is complete? What is the definition of done?',
    aiContext,
    onCancel
  );

  // Step 8: Save to file
  const { saveToFile } = await prompts({
    type: 'confirm',
    name: 'saveToFile',
    message: 'Save as PROMPT.md in the target directory?',
    initial: true,
  }, { onCancel });

  const response = { taskType, title, techStack, goal, requirements, verification, successCriteria, saveToFile };

  // Build the prompt markdown
  const promptLines: string[] = [];
  
  promptLines.push(`# ${response.title}`);
  
  if (response.goal) {
    promptLines.push('');
    promptLines.push('## Goal');
    promptLines.push(response.goal);
  }

  if (response.techStack) {
    promptLines.push('');
    promptLines.push('## Tech Stack');
    promptLines.push(response.techStack);
  }
  
  if (response.requirements) {
    promptLines.push('');
    promptLines.push('## Requirements');
    promptLines.push(response.requirements);
  }

  if (response.verification && response.verification.length > 0) {
    promptLines.push('');
    promptLines.push('## Verification');
    const verificationMap: Record<string, string> = {
      tests: 'Run tests to ensure nothing is broken',
      typecheck: 'Type check with `tsc --noEmit`',
      lint: 'Run linter and fix any issues',
      build: 'Ensure the project builds successfully',
      manual: 'Manual verification required',
    };
    for (const v of response.verification) {
      promptLines.push(`- ${verificationMap[v] || v}`);
    }
  }

  if (response.successCriteria) {
    promptLines.push('');
    promptLines.push('## Success Criteria');
    promptLines.push(response.successCriteria);
  }

  promptLines.push('');
  promptLines.push('## Guidelines');
  promptLines.push('- Read files before modifying them');
  promptLines.push('- Make incremental changes');
  promptLines.push('- Use `editFile` for small changes instead of rewriting entire files');
  promptLines.push('- Verify changes work before moving on');

  const prompt = promptLines.join('\n');

  return { prompt, saveToFile: response.saveToFile };
}

/**
 * Get the task prompt from various sources:
 * 1. CLI argument (string or path to .md file)
 * 2. PROMPT.md in the sandbox
 * 3. Interactive interview
 */
export async function getTaskPrompt(promptArg: string | undefined): Promise<{ prompt: string; source: string }> {
  // If a prompt argument was provided
  if (promptArg) {
    // Check if it's a path to a .md file
    if (promptArg.endsWith('.md')) {
      const path = await import('path');
      const fs = await import('fs/promises');
      const promptPath = path.resolve(promptArg.replace('~', process.env.HOME || ''));
      try {
        const content = await fs.readFile(promptPath, 'utf-8');
        return { prompt: content.trim(), source: promptPath };
      } catch {
        // If file doesn't exist, treat it as a literal string
        return { prompt: promptArg, source: 'CLI argument' };
      }
    }
    // It's a literal prompt string
    return { prompt: promptArg, source: 'CLI argument' };
  }

  // Check for PROMPT.md in sandbox
  try {
    const content = await readFromSandbox('PROMPT.md');
    if (content) {
      return { prompt: content.trim(), source: 'PROMPT.md (from sandbox)' };
    }
  } catch {
    // No PROMPT.md found
  }

  // Run interactive interview
  log('No PROMPT.md found. Starting interactive setup...', 'yellow');
  
  const { prompt, saveToFile } = await runInterview();

  if (saveToFile) {
    await writeToSandbox('PROMPT.md', prompt);
    log(`\n✓ Saved PROMPT.md to sandbox`, 'green');
  }

  return { prompt, source: saveToFile ? 'PROMPT.md' : 'interactive' };
}

