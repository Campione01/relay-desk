import type { BridgeOutput } from '../hooks/protocol';
import { test, expect, mock } from 'claude-code/testing';

test('native middleware preserves the entire model stream without a real request', async ($, on) => {
  const chunks = [
    { kind: 'thinking' as const, index: 0, text: 'synthetic reasoning' },
    { kind: 'text' as const, index: 1, text: 'synthetic answer' },
    { kind: 'tool' as const, index: 2, id: 'synthetic-tool', name: 'Read' },
    { kind: 'input' as const, index: 2, json: '{"file_path":"fixture"}' },
    { kind: 'stop' as const, stopReason: 'tool_use' as const, usage: null },
  ];
  let calls = 0;
  on('turn.step', async function* ($, event) {
    calls++;
    for (const chunk of chunks) yield chunk;
    return { turnId: event.turnId, index: event.index, answer: 'synthetic answer',
      toolUses: [{ name: 'Read', input: { file_path: 'fixture' } }], stopReason: 'tool_use', usage: null };
  });
  const stream = $.turn.step({ turnId: 'fixture-turn', index: 0, model: 'fixture-model', messageCount: 1 });
  const received = [];
  let step = await stream.next();
  while (!step.done) {
    received.push(step.value);
    step = await stream.next();
  }
  expect(received).toEqual(chunks);
  expect(step.value).toMatchObject({ answer: 'synthetic answer', stopReason: 'tool_use' });
  expect(calls).toBe(1);
});

test('native bridge dispatches text and cancels a permission using only synthetic engine calls', async ($, on) => {
  const clock = mock.clock(on);
  const sent: BridgeOutput[] = [];
  const prompts: string[] = [];
  const incoming: string[] = [];
  const variables: Record<string, string> = {
    RELAY_NATIVE_PIPE: 'relay-native-' + 'a'.repeat(64),
    RELAY_NATIVE_NONCE: 'b'.repeat(64),
    RELAY_NATIVE_HELPER: 'C:\\fixture\\helper.exe',
  };
  let wake: (() => void) | undefined;
  let ended = false;
  const enqueue = (request: unknown) => {
    incoming.push(JSON.stringify(request) + '\n');
    wake?.();
    wake = undefined;
  };
  on('env.get', ($, event) => ({ value: variables[event.name] }));
  on('env.set', ($, event) => { variables[event.name] = event.value ?? ''; return { value: {} }; });
  on('session.id', () => ({ value: 'fixture-session' }));
  on('session.model', () => ({ value: 'fixture-model' }));
  on('session.cwd', () => ({ value: 'C:\\fixture' }));
  on('session.start', ($, event) => ({ cwd: event.cwd }));
  on('session.end', ($, event) => ({ sessionId: event.sessionId }));
  on('classic.PermissionRequest', () => ({}));
  on('process.run', ($, event) => {
    expect(event.argv).toEqual(['C:\\fixture\\helper.exe', 'send']);
    expect(event.init?.env?.RELAY_NATIVE_NONCE).toBe('b'.repeat(64));
    for (const line of (event.init?.stdin ?? '').trim().split('\n')) {
      if (line) sent.push(JSON.parse(line) as BridgeOutput);
    }
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } };
  });
  on('process.spawn', async function* ($, event) {
    expect(event.argv).toEqual(['C:\\fixture\\helper.exe', 'recv']);
    while (!ended) {
      const text = incoming.shift();
      if (text) yield { stream: 'stdout', text };
      else await new Promise<void>((resolve) => { wake = resolve; });
    }
    return { value: { code: 0, signal: null } };
  });
  on('prompt.submit', ($, event) => {
    prompts.push(event.text);
    return { text: event.text, origin: event.origin };
  });
  await $.session.start({ cwd: 'C:\\fixture', surface: 'terminal', isInteractive: true });
  expect(sent[0]).toMatchObject({ type: 'hello', isInteractive: true });
  expect(Object.values(variables)).toEqual(['', '', '']);
  enqueue({ type: 'request', id: 'text', method: 'prompt.submit', args: { text: 'fixture only', asUser: true } });
  await clock.settle();
  await clock.advance(25);
  expect(prompts).toEqual(['fixture only']);
  const approved = $.classic.PermissionRequest({ tool_name: 'Read', tool_input: { file_path: 'fixture' } });
  await clock.settle();
  await clock.advance(25);
  const ask = sent.filter((row) => row.type === 'event' && row.event === 'interaction.request').at(-1)!;
  const id = (ask.type === 'event' ? ask.data : {}) as { id: string };
  enqueue({ type: 'request', id: 'permission-answer', method: 'interaction.reply', args: { id: id.id, result: { behavior: 'allow' } } });
  await clock.settle();
  expect(await approved).toMatchObject({ decision: { behavior: 'allow' } });
  const canceled = $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'never executed' } });
  await clock.settle();
  await $.session.end({ reason: 'clear', sessionId: 'fixture-session', resume: { id: 'fixture-session' } });
  expect(await canceled).toMatchObject({ decision: { behavior: 'deny' } });
  await clock.advance(25);
  expect(sent.some((row) => row.type === 'event' && row.event === 'interaction.cancel')).toBe(true);
  ended = true;
  wake?.();
  await clock.settle();
});
