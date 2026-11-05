import { describe, expect, it } from 'vitest';
import { redactSecrets, StderrLines } from '../../src/main/engine/redaction';

describe('engine diagnostic redaction', () => {
  it('masks named API credentials, quoted OAuth fields and short bearer tokens', () => {
    const diagnostic = [
      'ANTHROPIC_API_KEY=synthetic-api-secret',
      '"ANTHROPIC_AUTH_TOKEN": "synthetic-auth-secret"',
      "CLAUDE_CODE_OAUTH_TOKEN='synthetic-oauth-secret'",
      "{'access_token': 'synthetic-access-secret'}",
      'x-api-key: synthetic-header-secret',
      'Authorization: Bearer abc',
    ].join('\n');
    const redacted = redactSecrets(diagnostic);
    expect(redacted).not.toMatch(/synthetic-\w+-secret|Bearer abc/);
    expect(redacted.match(/\[redacted\]/g)).toHaveLength(6);
  });

  it('masks the key fragment the CLI shows, also where its label is on another row or missing', () => {
    const tail = 'SyntheticKeyTail0123';
    for (const text of [`sk-ant-...${tail}`, `sk-ant-\u2026${tail}`, `ANTHROPIC_API_KEY\n  sk-ant-...${tail}`, `Found ${'x'.repeat(30)} sk-ant-...${tail} here`]) {
      const redacted = redactSecrets(text);
      expect(redacted).not.toContain(tail);
      expect(redacted).toContain('sk-ant-[redacted]');
    }
    expect(redactSecrets(`ANTHROPIC_API_KEY: sk-ant-...${tail}`)).toBe('ANTHROPIC_API_KEY: [redacted]');
    expect(redactSecrets('Set ANTHROPIC_API_KEY to a key that starts with sk-ant-.')).toBe('Set ANTHROPIC_API_KEY to a key that starts with sk-ant-.');
  });

  it('drops oversized incomplete and complete stderr records without logging credential suffixes', () => {
    const records: string[] = [];
    const stderr = new StderrLines((line) => records.push(redactSecrets(line)));
    stderr.write('sk-ant-'.padEnd(20_000, 'x'));
    expect(records).toEqual(['[stderr line omitted: exceeds safe diagnostic limit]']);
    stderr.write('SENSITIVE_SUFFIX\nnormal record\n');
    stderr.write(`access_token=${'y'.repeat(20_000)}\n`);
    stderr.write('last normal record');
    stderr.flush();
    expect(records).toEqual([
      '[stderr line omitted: exceeds safe diagnostic limit]',
      'normal record',
      '[stderr line omitted: exceeds safe diagnostic limit]',
      'last normal record',
    ]);
    expect(records.join('\n')).not.toContain('SENSITIVE_SUFFIX');
  });
});
