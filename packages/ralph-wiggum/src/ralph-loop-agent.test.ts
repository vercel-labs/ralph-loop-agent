import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import { RalphLoopAgent, iterationCountIs } from './ralph-loop-agent';

// Helper to create mock usage object with all required fields
const createMockUsage = () => ({
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 20, text: 20, reasoning: undefined },
});

describe('RalphLoopAgent', () => {
  describe('loop', () => {
    it('should complete on first iteration when verifyCompletion returns complete', async () => {
      const mockModel = new MockLanguageModelV3({
        doGenerate: async () => ({
          content: [{ type: 'text', text: 'Task completed!' }],
          finishReason: { unified: 'stop', raw: 'stop' },
          usage: createMockUsage(),
          warnings: [],
        }),
      });

      const agent = new RalphLoopAgent({
        model: mockModel,
        verifyCompletion: () => ({ complete: true, reason: 'Done!' }),
      });

      const result = await agent.loop({ prompt: 'Do something' });

      expect(result.completionReason).toBe('verified');
      expect(result.iterations).toBe(1);
      expect(result.text).toBe('Task completed!');
      expect(result.reason).toBe('Done!');
    });

    it('should run multiple iterations until verifyCompletion returns complete', async () => {
      let callCount = 0;
      const mockModel = new MockLanguageModelV3({
        doGenerate: async () => {
          callCount++;
          return {
            content: [{ type: 'text', text: `Attempt ${callCount}` }],
            finishReason: { unified: 'stop', raw: 'stop' },
            usage: createMockUsage(),
            warnings: [],
          };
        },
      });

      const agent = new RalphLoopAgent({
        model: mockModel,
        stopWhen: iterationCountIs(10),
        verifyCompletion: ({ iteration }) => ({
          complete: iteration >= 3,
          reason: iteration >= 3 ? 'Complete after 3' : 'Not yet',
        }),
      });

      const result = await agent.loop({ prompt: 'Do something' });

      expect(result.completionReason).toBe('verified');
      expect(result.iterations).toBe(3);
      expect(result.allResults).toHaveLength(3);
    });

    it('should stop at max iterations if never complete', async () => {
      const mockModel = new MockLanguageModelV3({
        doGenerate: async () => ({
          content: [{ type: 'text', text: 'Still working...' }],
          finishReason: { unified: 'stop', raw: 'stop' },
          usage: createMockUsage(),
          warnings: [],
        }),
      });

      const agent = new RalphLoopAgent({
        model: mockModel,
        stopWhen: iterationCountIs(3),
        verifyCompletion: () => ({ complete: false }),
      });

      const result = await agent.loop({ prompt: 'Do something' });

      expect(result.completionReason).toBe('max-iterations');
      expect(result.iterations).toBe(3);
    });

    it('should pass instructions as system message', async () => {
      let capturedPrompt: unknown;
      const mockModel = new MockLanguageModelV3({
        doGenerate: async options => {
          capturedPrompt = options.prompt;
          return {
            content: [{ type: 'text', text: 'Done' }],
            finishReason: { unified: 'stop', raw: 'stop' },
            usage: createMockUsage(),
            warnings: [],
          };
        },
      });

      const agent = new RalphLoopAgent({
        model: mockModel,
        instructions: 'You are a helpful assistant.',
        verifyCompletion: () => ({ complete: true }),
      });

      await agent.loop({ prompt: 'Hello' });

      expect(capturedPrompt).toEqual([
        { role: 'system', content: 'You are a helpful assistant.' },
        {
          role: 'user',
          content: [{ type: 'text', text: 'Hello' }],
        },
      ]);
    });

    it('should call onIterationStart and onIterationEnd callbacks', async () => {
      const onIterationStart = vi.fn();
      const onIterationEnd = vi.fn();

      const mockModel = new MockLanguageModelV3({
        doGenerate: async () => ({
          content: [{ type: 'text', text: 'Done' }],
          finishReason: { unified: 'stop', raw: 'stop' },
          usage: createMockUsage(),
          warnings: [],
        }),
      });

      const agent = new RalphLoopAgent({
        model: mockModel,
        stopWhen: iterationCountIs(5),
        verifyCompletion: ({ iteration }) => ({ complete: iteration >= 2 }),
        onIterationStart,
        onIterationEnd,
      });

      await agent.loop({ prompt: 'Do something' });

      expect(onIterationStart).toHaveBeenCalledTimes(2);
      expect(onIterationStart).toHaveBeenNthCalledWith(1, { iteration: 1 });
      expect(onIterationStart).toHaveBeenNthCalledWith(2, { iteration: 2 });

      expect(onIterationEnd).toHaveBeenCalledTimes(2);
      expect(onIterationEnd).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ iteration: 1, duration: expect.any(Number) }),
      );
      expect(onIterationEnd).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ iteration: 2, duration: expect.any(Number) }),
      );
    });

    it('should include feedback reason in next iteration', async () => {
      const capturedPrompts: unknown[] = [];
      let callCount = 0;

      const mockModel = new MockLanguageModelV3({
        doGenerate: async options => {
          capturedPrompts.push(options.prompt);
          callCount++;
          return {
            content: [{ type: 'text', text: `Response ${callCount}` }],
            finishReason: { unified: 'stop', raw: 'stop' },
            usage: createMockUsage(),
            warnings: [],
          };
        },
      });

      const agent = new RalphLoopAgent({
        model: mockModel,
        stopWhen: iterationCountIs(5),
        verifyCompletion: ({ iteration }) => {
          if (iteration === 1) {
            return { complete: false, reason: 'Please try harder!' };
          }
          return { complete: true };
        },
      });

      await agent.loop({ prompt: 'Do something' });

      // Second call should include the feedback
      const secondPrompt = capturedPrompts[1] as Array<{
        role: string;
        content: unknown;
      }>;
      const feedbackMessage = secondPrompt.find(
        msg =>
          msg.role === 'user' &&
          Array.isArray(msg.content) &&
          msg.content.some(
            (c: { type: string; text: string }) =>
              c.text === 'Feedback: Please try harder!',
          ),
      );
      expect(feedbackMessage).toBeDefined();
    });

    it('should work without verifyCompletion (runs to max iterations)', async () => {
      const mockModel = new MockLanguageModelV3({
        doGenerate: async () => ({
          content: [{ type: 'text', text: 'Response' }],
          finishReason: { unified: 'stop', raw: 'stop' },
          usage: createMockUsage(),
          warnings: [],
        }),
      });

      const agent = new RalphLoopAgent({
        model: mockModel,
        stopWhen: iterationCountIs(2),
        // No verifyCompletion
      });

      const result = await agent.loop({ prompt: 'Do something' });

      expect(result.iterations).toBe(2);
      expect(result.completionReason).toBe('max-iterations');
    });
  });

  describe('verifyCompletion', () => {
    it('should support async verification', async () => {
      const mockModel = new MockLanguageModelV3({
        doGenerate: async () => ({
          content: [{ type: 'text', text: 'Done' }],
          finishReason: { unified: 'stop', raw: 'stop' },
          usage: createMockUsage(),
          warnings: [],
        }),
      });

      const agent = new RalphLoopAgent({
        model: mockModel,
        verifyCompletion: async ({ result }) => {
          await new Promise(resolve => setTimeout(resolve, 10));
          return { complete: result.text.includes('Done') };
        },
      });

      const result = await agent.loop({ prompt: 'Do something' });

      expect(result.completionReason).toBe('verified');
    });

    it('should receive full context in verifyCompletion', async () => {
      let receivedContext: unknown;
      const mockModel = new MockLanguageModelV3({
        doGenerate: async () => ({
          content: [{ type: 'text', text: 'Response' }],
          finishReason: { unified: 'stop', raw: 'stop' },
          usage: createMockUsage(),
          warnings: [],
        }),
      });

      const agent = new RalphLoopAgent({
        model: mockModel,
        stopWhen: iterationCountIs(5),
        verifyCompletion: context => {
          receivedContext = context;
          return { complete: context.iteration >= 2 };
        },
      });

      await agent.loop({ prompt: 'Test prompt' });

      expect(receivedContext).toMatchObject({
        originalPrompt: 'Test prompt',
        iteration: 2,
      });
    });
  });

  describe('iterationCountIs', () => {
    it('should create a stop condition function', () => {
      const condition = iterationCountIs(5);
      expect(typeof condition).toBe('function');
    });

    it('should stop at the specified iteration count', () => {
      const condition = iterationCountIs(5);
      
      // Should not stop before reaching count
      expect(condition({ iteration: 4, allResults: [], totalUsage: {} as any, model: 'test' })).toBe(false);
      // Should stop at count
      expect(condition({ iteration: 5, allResults: [], totalUsage: {} as any, model: 'test' })).toBe(true);
      // Should stop after count
      expect(condition({ iteration: 6, allResults: [], totalUsage: {} as any, model: 'test' })).toBe(true);
    });

    it('should control max iterations in agent', async () => {
      const mockModel = new MockLanguageModelV3({
        doGenerate: async () => ({
          content: [{ type: 'text', text: 'Response' }],
          finishReason: { unified: 'stop', raw: 'stop' },
          usage: createMockUsage(),
          warnings: [],
        }),
      });

      const agent = new RalphLoopAgent({
        model: mockModel,
        stopWhen: iterationCountIs(7),
        verifyCompletion: () => ({ complete: false }),
      });

      const result = await agent.loop({ prompt: 'Test' });
      expect(result.iterations).toBe(7);
    });
  });

  describe('stream', () => {
    it('should stream the final iteration', async () => {
      const mockModel = new MockLanguageModelV3({
        doGenerate: async () => ({
          content: [{ type: 'text', text: 'Non-streaming response' }],
          finishReason: { unified: 'stop', raw: 'stop' },
          usage: createMockUsage(),
          warnings: [],
        }),
        doStream: async () => ({
          stream: convertArrayToReadableStream([
            { type: 'stream-start', warnings: [] },
            {
              type: 'response-metadata',
              id: 'id-0',
              modelId: 'mock-model-id',
              timestamp: new Date(0),
            },
            { type: 'text-start', id: '1' },
            { type: 'text-delta', id: '1', delta: 'Streamed ' },
            { type: 'text-delta', id: '1', delta: 'response' },
            { type: 'text-end', id: '1' },
            {
              type: 'finish',
              finishReason: { unified: 'stop', raw: 'stop' },
              usage: createMockUsage(),
            },
          ]),
        }),
      });

      const agent = new RalphLoopAgent({
        model: mockModel,
        stopWhen: iterationCountIs(3),
        verifyCompletion: ({ iteration }) => ({ complete: iteration >= 2 }),
      });

      const stream = await agent.stream({ prompt: 'Do something' });
      const chunks: string[] = [];

      for await (const chunk of stream.textStream) {
        chunks.push(chunk);
      }

      expect(chunks.join('')).toBe('Streamed response');
    });
  });

  describe('properties', () => {
    it('should expose id', () => {
      const mockModel = new MockLanguageModelV3();
      const agent = new RalphLoopAgent({
        id: 'test-agent',
        model: mockModel,
      });

      expect(agent.id).toBe('test-agent');
    });

    it('should expose tools', () => {
      const mockModel = new MockLanguageModelV3();
      // Tools are tested via verifyCompletion context, not directly exposed
      const agent = new RalphLoopAgent({
        model: mockModel,
      });

      expect(agent.tools).toBeUndefined();
    });

    it('should default to 10 iterations when no stopWhen is provided', async () => {
      let callCount = 0;
      const mockModel = new MockLanguageModelV3({
        doGenerate: async () => {
          callCount++;
          return {
            content: [{ type: 'text', text: 'Response' }],
            finishReason: { unified: 'stop', raw: 'stop' },
            usage: createMockUsage(),
            warnings: [],
          };
        },
      });

      const agent = new RalphLoopAgent({
        model: mockModel,
        // No stopWhen, should default to 10 iterations
        verifyCompletion: () => ({ complete: false }),
      });

      const result = await agent.loop({ prompt: 'Test' });
      expect(result.iterations).toBe(10);
    });
  });
});
