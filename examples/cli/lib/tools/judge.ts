/**
 * Tools for the judge agent (read-only sandbox access + visual verification)
 */

import { tool, generateText } from 'ai';
import { z } from 'zod';
import { runInSandbox, readFromSandbox, getSandboxDomain, writeToSandbox } from '../sandbox.js';
import { log } from '../logger.js';

// Vision model for analyzing screenshots
const VISION_MODEL = 'anthropic/claude-sonnet-4-20250514';

export function createJudgeTools() {
  const sandboxDomain = getSandboxDomain();

  return {
    takeScreenshot: tool({
      description: 'Take a screenshot of the web app for visual verification. Returns an analysis of what is visible.',
      inputSchema: z.object({
        url: z.string().optional().describe('URL to screenshot (defaults to sandbox dev server)'),
        outputPath: z.string().optional().describe('Where to save the screenshot (defaults to judge-screenshot.png)'),
        fullPage: z.boolean().optional().describe('Capture full scrollable page'),
      }),
      execute: async ({ url, outputPath, fullPage }) => {
        try {
          const targetUrl = url?.replace('localhost:3000', sandboxDomain || 'localhost:3000') 
            || `https://${sandboxDomain}`;
          const output = outputPath || 'judge-screenshot.png';
          const fullPageOpt = fullPage ? 'fullPage: true,' : '';
          
          log(`  [judge] Taking screenshot of ${targetUrl}`, 'blue');
          
          const PLAYWRIGHT_CACHE = '/home/vercel-sandbox/.cache/ms-playwright';
          const GLOBAL_NODE_MODULES = '/home/vercel-sandbox/.global/npm/lib/node_modules';
          
          const script = `const { chromium } = require('playwright');
(async () => {
  try {
    const browser = await chromium.launch({ 
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    await page.goto(${JSON.stringify(targetUrl)}, { waitUntil: 'networkidle', timeout: 30000 });
    await page.screenshot({ path: ${JSON.stringify(output)}, ${fullPageOpt} });
    await browser.close();
  } catch (err) {
    console.error('Screenshot error:', err.message);
    process.exit(1);
  }
})();
`;
          
          await writeToSandbox('/tmp/judge-screenshot.js', script);
          
          const result = await runInSandbox(
            `NODE_PATH="${GLOBAL_NODE_MODULES}" PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_CACHE}" node /tmp/judge-screenshot.js 2>&1`
          );
          
          if (result.exitCode !== 0) {
            return { success: false, error: result.stdout || result.stderr, exitCode: result.exitCode };
          }
          
          // Read the screenshot as base64 for vision analysis
          const imageResult = await runInSandbox(`base64 -w 0 ${output} 2>&1`);
          if (imageResult.exitCode !== 0 || !imageResult.stdout) {
            return { success: true, path: output, url: targetUrl, analysis: 'Screenshot taken but could not read for analysis' };
          }
          
          const imageBase64 = imageResult.stdout.trim();
          
          // Analyze with vision model
          const analysisResult = await generateText({
            model: VISION_MODEL,
            messages: [{
              role: 'user',
              content: [
                { type: 'image', image: `data:image/png;base64,${imageBase64}` },
                { type: 'text', text: 'Describe what you see in this screenshot. Focus on: layout, UI elements, any visible errors, and overall appearance. Be concise but thorough.' }
              ]
            }]
          });
          
          log(`  [judge] Screenshot analyzed`, 'green');
          return { success: true, path: output, url: targetUrl, analysis: analysisResult.text };
        } catch (error: any) {
          return { success: false, error: error.message };
        }
      },
    }),

    browserInteract: tool({
      description: 'Interact with the running web app (navigate, click, fill forms). Returns a screenshot analysis after the action.',
      inputSchema: z.object({
        action: z.enum(['navigate', 'click', 'fill', 'getContent', 'getAccessibilityTree', 'waitForElement']).describe('Action to perform'),
        url: z.string().optional().describe('URL for navigate action'),
        selector: z.string().optional().describe('CSS selector for click/fill/wait actions'),
        text: z.string().optional().describe('Text for fill action'),
        timeout: z.number().optional().describe('Timeout in ms (default 5000)'),
      }),
      execute: async ({ action, url, selector, text, timeout }) => {
        try {
          const baseUrl = `https://${sandboxDomain}`;
          const targetUrl = url?.replace('localhost:3000', sandboxDomain || 'localhost:3000') || baseUrl;
          const timeoutMs = timeout || 5000;
          
          log(`  [judge] Browser: ${action}${selector ? ` on ${selector}` : ''}${url ? ` to ${targetUrl}` : ''}`, 'blue');
          
          const PLAYWRIGHT_CACHE = '/home/vercel-sandbox/.cache/ms-playwright';
          const GLOBAL_NODE_MODULES = '/home/vercel-sandbox/.global/npm/lib/node_modules';
          
          let actionCode = '';
          switch (action) {
            case 'navigate':
              actionCode = `await page.goto(${JSON.stringify(targetUrl)}, { waitUntil: 'networkidle', timeout: ${timeoutMs} });`;
              break;
            case 'click':
              actionCode = `await page.click(${JSON.stringify(selector)}, { timeout: ${timeoutMs} });`;
              break;
            case 'fill':
              actionCode = `await page.fill(${JSON.stringify(selector)}, ${JSON.stringify(text)}, { timeout: ${timeoutMs} });`;
              break;
            case 'getContent':
              actionCode = `const content = await page.textContent('body'); console.log('PAGE_CONTENT:', content?.slice(0, 5000));`;
              break;
            case 'getAccessibilityTree':
              actionCode = `const tree = await page.accessibility.snapshot(); console.log('A11Y_TREE:', JSON.stringify(tree, null, 2).slice(0, 5000));`;
              break;
            case 'waitForElement':
              actionCode = `await page.waitForSelector(${JSON.stringify(selector)}, { timeout: ${timeoutMs} }); console.log('ELEMENT_FOUND:', ${JSON.stringify(selector)});`;
              break;
          }
          
          const script = `const { chromium } = require('playwright');
(async () => {
  try {
    const browser = await chromium.launch({ 
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    await page.goto(${JSON.stringify(baseUrl)}, { waitUntil: 'networkidle', timeout: 30000 });
    ${actionCode}
    await page.screenshot({ path: 'judge-interact.png' });
    await browser.close();
  } catch (err) {
    console.error('Browser error:', err.message);
    process.exit(1);
  }
})();
`;
          
          await writeToSandbox('/tmp/judge-interact.js', script);
          
          const result = await runInSandbox(
            `NODE_PATH="${GLOBAL_NODE_MODULES}" PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_CACHE}" node /tmp/judge-interact.js 2>&1`
          );
          
          if (result.exitCode !== 0) {
            return { success: false, error: result.stdout || result.stderr, action };
          }
          
          // Extract any content from output
          let extractedContent: string | undefined;
          if (result.stdout.includes('PAGE_CONTENT:')) {
            extractedContent = result.stdout.split('PAGE_CONTENT:')[1]?.trim();
          } else if (result.stdout.includes('A11Y_TREE:')) {
            extractedContent = result.stdout.split('A11Y_TREE:')[1]?.trim();
          } else if (result.stdout.includes('ELEMENT_FOUND:')) {
            extractedContent = result.stdout.split('ELEMENT_FOUND:')[1]?.trim();
          }
          
          // Read and analyze screenshot as base64
          const imageResult = await runInSandbox(`base64 -w 0 judge-interact.png 2>&1`);
          if (imageResult.exitCode !== 0 || !imageResult.stdout) {
            return { success: true, action, content: extractedContent, note: 'Action completed but screenshot not available' };
          }
          
          const imageBase64 = imageResult.stdout.trim();
          
          const analysisResult = await generateText({
            model: VISION_MODEL,
            messages: [{
              role: 'user',
              content: [
                { type: 'image', image: `data:image/png;base64,${imageBase64}` },
                { type: 'text', text: `Describe what you see after performing: ${action}${selector ? ` on "${selector}"` : ''}. Focus on any visible changes, errors, or the current state.` }
              ]
            }]
          });
          
          log(`  [judge] Action completed and analyzed`, 'green');
          return { success: true, action, analysis: analysisResult.text, content: extractedContent };
        } catch (error: any) {
          return { success: false, error: error.message, action };
        }
      },
    }),

    listFiles: tool({
      description: 'List files in the sandbox',
      inputSchema: z.object({
        pattern: z.string().describe('Pattern like "**/*.js" or "src/"'),
      }),
      execute: async ({ pattern }) => {
        try {
          const result = await runInSandbox(`find . -type f -path "*${pattern}*" | grep -v node_modules | grep -v .git | head -100`);
          const files = result.stdout.split('\n').filter(f => f.trim()).map(f => f.replace(/^\.\//, ''));
          return { success: true, files };
        } catch (error) {
          return { success: false, error: String(error) };
        }
      },
    }),

    readFile: tool({
      description: 'Read the contents of a file to review changes',
      inputSchema: z.object({
        filePath: z.string().describe('Path to the file'),
        lineStart: z.number().optional().describe('Start line (1-indexed)'),
        lineEnd: z.number().optional().describe('End line (inclusive)'),
      }),
      execute: async ({ filePath, lineStart, lineEnd }) => {
        try {
          const content = await readFromSandbox(filePath);
          if (!content) {
            return { success: false, error: 'File not found' };
          }
          
          const lines = content.split('\n');
          const totalLines = lines.length;
          
          if (lineStart !== undefined || lineEnd !== undefined) {
            const start = Math.max(1, lineStart ?? 1);
            const end = Math.min(totalLines, lineEnd ?? totalLines);
            const selectedLines = lines.slice(start - 1, end);
            return { success: true, content: selectedLines.join('\n'), totalLines };
          }
          
          // Truncate for judge
          if (content.length > 15000) {
            return { 
              success: true, 
              content: content.slice(0, 15000) + '\n... [truncated]',
              totalLines,
              truncated: true,
            };
          }
          
          return { success: true, content, totalLines };
        } catch (error) {
          return { success: false, error: String(error) };
        }
      },
    }),

    runCommand: tool({
      description: 'Run a command to verify the code (e.g., tests, type-check, lint)',
      inputSchema: z.object({
        command: z.string().describe('The shell command to run'),
      }),
      execute: async ({ command }) => {
        try {
          const result = await runInSandbox(command);
          return { 
            success: result.exitCode === 0, 
            output: (result.stdout + result.stderr).slice(0, 5000),
            exitCode: result.exitCode,
          };
        } catch (error: any) {
          return { success: false, error: error.message };
        }
      },
    }),

    curl: tool({
      description: 'Test the running dev server',
      inputSchema: z.object({
        path: z.string().optional().describe('Path to request (e.g., "/api/health")'),
      }),
      execute: async ({ path }) => {
        try {
          const url = `${sandboxDomain}${path || '/'}`;
          const result = await runInSandbox(`curl -s "${url}"`);
          return { success: true, response: result.stdout.slice(0, 5000) };
        } catch (error) {
          return { success: false, error: String(error) };
        }
      },
    }),

    approveTask: tool({
      description: 'Approve the task as complete - all success criteria are met',
      inputSchema: z.object({
        reason: z.string().describe('Why the task is complete and meets all criteria'),
      }),
      execute: async ({ reason }) => {
        return { approved: true, reason };
      },
    }),

    requestChanges: tool({
      description: 'Request changes - the task is NOT complete or has issues',
      inputSchema: z.object({
        issues: z.array(z.string()).describe('List of specific issues that need to be fixed'),
        suggestions: z.array(z.string()).describe('Specific suggestions for the coding agent'),
      }),
      execute: async ({ issues, suggestions }) => {
        return { approved: false, issues, suggestions };
      },
    }),
  };
}

