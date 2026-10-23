/**
 * ALDINE_AI_AUTOFIX turns on the Fix tab's diagnosis without a click, off by
 * default and only where a model is configured to answer it.
 */
import { check } from './assert.mjs';
import { aiAutoFix } from '../src/ai.ts';

for (const k of ['OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'ALDINE_AI_AUTOFIX']) delete process.env[k];
check(aiAutoFix() === false, 'off by default');

process.env.ANTHROPIC_API_KEY = 'test-ai-key';
check(aiAutoFix() === false, 'a key alone leaves it off');

process.env.ALDINE_AI_AUTOFIX = '1';
check(aiAutoFix() === true, 'the flag and a key turn it on');

delete process.env.ANTHROPIC_API_KEY;
check(aiAutoFix() === false, 'the flag without a key has nothing to run');

console.log('ai-autofix: ok');
