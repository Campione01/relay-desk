import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseWorkflowMeta, workflowNameOf } from '../../src/shared/workflowMeta';

describe('parseWorkflowMeta', () => {
  it('reads the meta block of the script the CLI really ran', () => {
    const messages = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'workflow-cli-2.1.302.json'), 'utf8')) as Array<
      Record<string, unknown>
    >;
    const started = messages.find((m) => m.subtype === 'task_started');
    expect(parseWorkflowMeta(started?.prompt)).toEqual({
      name: 'relay-probe',
      description: 'Two tiny agents in two phases',
      phases: [{ title: 'Ask' }, { title: 'Check', detail: 'Second phase' }],
    });
  });

  it('accepts what the CLI accepts: comments, a hashbang, quotes of every kind, escapes, negatives, trailing commas', () => {
    const script = [
      '#!/usr/bin/env node',
      '// Review every changed file',
      '/* block',
      '   comment */',
      'export const meta = {',
      '  "name": "review-changes", // trailing comment',
      "  description: 'It\\'s a \\u0052eview\\x21',",
      '  whenToUse: `after a change`,',
      '  version: 2.5e1,',
      '  draft: false, note: null, offset: -2, ratio: - .5,\u2028',
      '  naïve: "ünïcode key",',
      '  nested: { deep: [1, [2, { three: 3 }]] },',
      "  phases: [{ title: 'Review' }, { title: 'Verify', detail: 'Adversarial\\nchecks' }, { title: 'Fix', model: 'opus' },],",
      '}',
      "phase('Review')",
    ].join('\n');
    expect(parseWorkflowMeta(script)).toEqual({
      name: 'review-changes',
      description: "It's a Review!",
      phases: [{ title: 'Review' }, { title: 'Verify', detail: 'Adversarial checks' }, { title: 'Fix' }],
    });
  });

  it('keeps phases without a usable title out, as the CLI does, and caps long text', () => {
    const long = 'x'.repeat(400);
    const meta = parseWorkflowMeta(
      `export const meta = { name: '${long}', description: '  ', phases: [{ detail: 'no title' }, 7, '', { title: '\\t' }, 'Only'] }`,
    );
    expect(meta?.name).toHaveLength(300);
    expect(meta?.name?.endsWith('…')).toBe(true);
    expect(meta).not.toHaveProperty('description');
    // The CLI lists only objects with a title, so a plain string is no phase either.
    expect(meta?.phases).toEqual([]);
    expect(parseWorkflowMeta('export const meta = { name: "a" }')).toEqual({ name: 'a', phases: [] });
  });

  it('refuses the keys the CLI reserves and never changes a prototype', () => {
    for (const key of ['__proto__', '"__proto__"', 'constructor', 'prototype']) {
      expect(parseWorkflowMeta(`export const meta = { ${key}: { name: 'injected' }, name: 'safe', phases: [] }`)).toBeUndefined();
    }
    expect(({} as Record<string, unknown>).name).toBeUndefined();
  });

  it('never throws, whatever the escapes in a string (a \\u{-1} escape once crashed the session)', () => {
    for (const escape of ['\\u{-1}', '\\u{}', '\\u{110000}', '\\u{12345678}', '\\u{zz}', '\\u{41', '\\u12', '\\x4']) {
      const script = `export const meta = { name: 'x${escape}', phases: [] }`;
      expect(() => parseWorkflowMeta(script)).not.toThrow();
      expect(parseWorkflowMeta(script)).toBeUndefined();
    }
    expect(parseWorkflowMeta("export const meta = { name: 'A\\u{1F600}\\u{10FFFF}', phases: [] }")?.name).toBe('A\u{1F600}\u{10FFFF}');
    expect(workflowNameOf({ script: "export const meta = { name: 'x\\u{-1}' }", name: 'fallback' })).toBe('fallback');
  });

  it.each([
    ['not first', "const x = 1\nexport const meta = { name: 'a' }"],
    ['let instead of const', "export let meta = { name: 'a' }"],
    ['another name', "export const info = { name: 'a' }"],
    ['computed value', 'export const meta = { name: makeName() }'],
    ['identifier value', 'export const meta = { name: NAME }'],
    ['shorthand', 'export const meta = { name }'],
    ['method', "export const meta = { name() { return 'a' } }"],
    ['computed key', "export const meta = { ['name']: 'a' }"],
    ['spread', 'export const meta = { ...base }'],
    ['template with a placeholder', 'export const meta = { name: `a${b}` }'],
    ['array hole', "export const meta = { phases: ['a',, 'b'] }"],
    ['unterminated string', "export const meta = { name: 'a }"],
    ['unterminated comment', "/* export const meta = { name: 'a' }"],
    ['newline in a quoted string', "export const meta = { name: 'a\nb' }"],
    ['not an object', "export const meta = ['a']"],
    ['hex number', 'export const meta = { n: 0x10 }'],
    ['plus sign', 'export const meta = { n: +1 }'],
    ['minus without a number', "export const meta = { n: -'1' }"],
    ['numeric separator', 'export const meta = { n: 1_000 }'],
    ['undefined', 'export const meta = { n: undefined }'],
    ['too deep', `export const meta = { a: ${'['.repeat(12)}${']'.repeat(12)} }`],
    ['empty', ''],
  ])('gives up on a %s', (_name, script) => {
    expect(parseWorkflowMeta(script)).toBeUndefined();
  });

  it('gives up on anything that is not a string', () => {
    expect(parseWorkflowMeta(undefined)).toBeUndefined();
    expect(parseWorkflowMeta({ name: 'a' })).toBeUndefined();
  });

  it('reads only the start of a very long script', () => {
    const body = `export const meta = { name: 'big', phases: [] }\n${'x'.repeat(50_000)}`;
    expect(parseWorkflowMeta(body)?.name).toBe('big');
    expect(parseWorkflowMeta(`export const meta = { name: '${'y'.repeat(25_000)}' }`)).toBeUndefined();
  });
});

describe('workflowNameOf', () => {
  it('prefers the script meta, then the workflow name, then the saved script file', () => {
    expect(workflowNameOf({ script: "export const meta = { name: 'from-meta' }", name: 'named' })).toBe('from-meta');
    expect(workflowNameOf({ script: 'oops', name: 'named' })).toBe('named');
    expect(workflowNameOf({ scriptPath: 'C:\\x\\workflows\\scripts\\audit-wf_0a1b2c3d-4e5.js' })).toBe('audit');
    expect(workflowNameOf({ scriptPath: '/home/u/flows/check.JS' })).toBe('check');
    expect(workflowNameOf({ resumeFromRunId: 'wf_1' })).toBeUndefined();
    expect(workflowNameOf(null)).toBeUndefined();
    expect(workflowNameOf(['x'])).toBeUndefined();
  });
});
