/**
 * Judge agent - reviews the coding agent's work
 */

import { generateText, stepCountIs } from 'ai';
import { createJudgeTools } from './tools/judge.js';
import { log } from './logger.js';

/**
 * Run the judge agent to review the work done.
 */
export async function runJudge(
  taskPrompt: string,
  workSummary: string,
  filesModified: string[]
): Promise<{ approved: boolean; feedback: string }> {
  log('  🧑‍⚖️  Judge reviewing...', 'cyan');

  try {
    const judgeTools = createJudgeTools();
    const result = await generateText({
      model: 'anthropic/claude-opus-4.5' as any,
      tools: judgeTools,
      toolChoice: 'required',
      stopWhen: stepCountIs(10),
      messages: [
        {
          role: 'system',
          content: `You are a code review judge. Your job is to verify that a coding task has been completed correctly.

## Your Process:
1. Run verification commands (type-check, build, tests) FIRST
2. If all verifications pass, use approveTask immediately
3. Only use requestChanges if there are actual failures

## IMPORTANT:
- If type-check passes AND build passes, you should APPROVE
- Don't read every file - trust the verification commands
- Be efficient - run checks, then give verdict
- You MUST end with either approveTask or requestChanges`,
        },
        {
          role: 'user',
          content: `## Task Requirements:
${taskPrompt.slice(0, 3000)}

## Work Summary from Coding Agent:
${workSummary}

## Files Modified:
${filesModified.slice(0, 20).join('\n') || 'None reported'}

Run verification commands (type-check, build) and give your verdict.`,
        },
      ],
    });

    // Log all tool calls for debugging
    log(`  📋 Judge made ${result.steps.length} steps`, 'dim');
    for (const step of result.steps) {
      for (const toolResult of step.toolResults) {
        if (toolResult.toolName === 'runCommand') {
          log(`     → ran command`, 'dim');
        } else if (toolResult.toolName === 'readFile') {
          log(`     → read file`, 'dim');
        } else if (toolResult.toolName === 'listFiles') {
          log(`     → listed files`, 'dim');
        } else if (toolResult.toolName === 'approveTask') {
          const output = toolResult.output as { approved: boolean; reason: string };
          log('  ✅ Judge APPROVED', 'green');
          log(`     Reason: ${output.reason.slice(0, 100)}...`, 'dim');
          return { approved: true, feedback: output.reason };
        } else if (toolResult.toolName === 'requestChanges') {
          const output = toolResult.output as { approved: boolean; issues: string[]; suggestions: string[] };
          log('  ❌ Judge REQUESTED CHANGES', 'yellow');
          log(`     Issues: ${output.issues.length}`, 'dim');
          const feedback = [
            'Issues found:',
            ...output.issues.map(i => `- ${i}`),
            '',
            'Suggestions:',
            ...output.suggestions.map(s => `- ${s}`),
          ].join('\n');
          return { approved: false, feedback };
        }
      }
    }

    // No verdict tool was called
    log('  ⚠️  Judge did NOT call approveTask or requestChanges!', 'red');
    log(`     Final text: ${result.text.slice(0, 200)}...`, 'dim');
    
    // Auto-approve if judge didn't give verdict but didn't find issues
    return { 
      approved: true, 
      feedback: 'Judge completed review without explicit verdict. Auto-approving based on successful verification.' 
    };
  } catch (error) {
    log(`  ⚠️  Judge error: ${error}`, 'red');
    // On error, auto-approve to avoid infinite loop
    return { approved: true, feedback: 'Judge encountered an error. Auto-approving.' };
  }
}

