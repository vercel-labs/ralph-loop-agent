import { search } from './search';

const prompt = process.argv.slice(2).join(' ').trim();
if (!prompt) {
  console.error('Usage: pnpm search "Your research question"');
  process.exitCode = 1;
} else {
  try {
    const result = await search({ prompt, abortSignal: AbortSignal.timeout(120_000) });
    console.log(result.text);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
