import { describe, expect, it, vi } from 'vitest';
import { NativeUiController, NATIVE_UI_PINNED_SHA256 } from '../../src/main/native/controls';

function fixture(result: unknown = { text: 'No MCP servers configured.' }) {
  const request = vi.fn(async () => result), writeTerminal = vi.fn(async () => undefined);
  const ui = new NativeUiController({ sessionId: 'fixture', cliSha256: NATIVE_UI_PINNED_SHA256,
    port: { request }, writeTerminal, isIdle: () => true });
  return { ui, request, writeTerminal };
}
const options = { timeoutMs: 50, stableMs: 0, completedText: (value: unknown) =>
  (value as { text?: string })?.text === 'No MCP servers configured.' ? 'No MCP servers configured.' : undefined };

describe('native nonmodal control results', () => {
  it('accepts an actual empty-catalog command result without inventing a terminal frame or pressing keys', async () => {
    const f = fixture();
    const result = await f.ui.run('mcp.empty', (tx) => tx.open('mcp', '', (frame) => frame.text === 'No MCP servers configured.', options));
    expect(result.source).toBe('command-result');
    expect(f.ui.snapshot().text).toBe('');
    expect(f.request).toHaveBeenCalledOnce(); expect(f.writeTerminal).not.toHaveBeenCalled();
    expect(f.ui.active()).toBe(false); f.ui.close();
  });
  it('does not quarantine a healthy UI when an account-scope precondition fails before any command', async () => {
    const f = fixture();
    await expect(f.ui.run('scope', async () => { throw new Error('independent account required'); })).rejects.toThrow('independent');
    expect(f.request).not.toHaveBeenCalled(); expect(f.ui.active()).toBe(false);
    await expect(f.ui.run('still healthy', async () => 42)).resolves.toBe(42); f.ui.close();
  });
  it('does not treat returned text as permission to type into an unobserved modal', async () => {
    const f = fixture();
    await expect(f.ui.run('nonmodal', async (tx) => {
      await tx.open('mcp', '', (frame) => frame.text === 'No MCP servers configured.', options);
      await tx.key('\r', () => true, () => true);
    })).rejects.toThrow('no fresh native command panel');
    expect(f.writeTerminal).not.toHaveBeenCalled(); f.ui.close();
  });
});
