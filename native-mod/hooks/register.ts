import type { EngineInterface, Register } from 'claude-code';
import { createNativeBridge, type NativeBridge } from './bridge';
import { createProcessTransport, type BridgeTransport } from './transport';

export const STARTUP_FAILURE_NOTICE = 'Relay native startup failed. Close this session and reopen it.';

// The native hook loader only permits passing $ to top-level or imported helpers.
async function reportStartupFailure($: EngineInterface, transport?: BridgeTransport, bridge?: NativeBridge): Promise<void> {
    try {
      transport?.send({ type: 'startupError', protocol: 1, code: 'MOD_INIT_FAILED' });
      await transport?.flush();
    } catch { /* Only fixed diagnostic text crosses the boundary. */ }
    try { bridge?.close('Relay native startup failed'); } catch { /* The host still owns the child job. */ }
    try { transport?.close(); } catch { /* Keep the failure report free of exception payloads. */ }
    try { $.ui.toast(STARTUP_FAILURE_NOTICE, { timeoutMs: 30_000 }); }
    catch { /* The original native hook failure must not expose its data. */ }
}

export const register: Register = (on) => {
  let bridge: NativeBridge | undefined;
  let enabled = false;
  let startupTransport: BridgeTransport | undefined;

  on('session.start', async ($, event, next) => {
    if (!event.isInteractive || event.surface !== 'terminal') return next(event);
    enabled = true;
    const result = await next(event);
    try {
      startupTransport = await createProcessTransport($);
      bridge = createNativeBridge($, startupTransport);
      await bridge.start(event.isInteractive, event.surface);
      startupTransport = undefined;
    } catch {
      const failedTransport = startupTransport, failedBridge = bridge;
      startupTransport = undefined; bridge = undefined;
      await reportStartupFailure($, failedTransport, failedBridge);
    }
    return result;
  }).catch(async ($, event) => {
    if (event.isInteractive && event.surface === 'terminal') {
      enabled = true;
      const failedTransport = startupTransport, failedBridge = bridge;
      startupTransport = undefined; bridge = undefined;
      await reportStartupFailure($, failedTransport, failedBridge);
    }
    return { cwd: event.cwd };
  });

  on('turn.start', async ($, event, next) => {
    await bridge?.rebind();
    if (event.agentId === undefined) bridge?.setTurn(event.turnId);
    bridge?.emit('turn.start', event);
    return next(event);
  });

  on('prompt.submit', async ($, event, next) => {
    if (!enabled) return next(event);
    if (!bridge) return { drop: 'Relay native bridge is unavailable' };
    const reason = await bridge.promptBlockReason();
    const attachment = bridge.checkAttachmentPrompt(event, reason);
    if (attachment.reason) return { drop: attachment.reason };
    try {
      const result = await next(event);
      if (attachment.transactionId) bridge.completeAttachmentPrompt(attachment.transactionId, result);
      return result;
    } catch (error) {
      if (attachment.transactionId) bridge.rejectAttachmentPrompt(attachment.transactionId);
      throw error;
    }
  }).catch(() => ({ drop: 'Relay prompt guard failed' }));

  on('turn.step', async function* ($, event, next) {
    const stream = next(event);
    for await (const chunk of stream) {
      bridge?.emit('turn.step', { turnId: event.turnId, stepId: event.index, agentId: event.agentId, chunk });
      yield chunk;
    }
    return await stream.result;
  });

  on('turn.complete', async ($, event, next) => {
    const result = await next(event);
    if (event.agentId === undefined) bridge?.setTurn(undefined);
    bridge?.emit('turn.complete', event);
    return result;
  });

  on('session.append', async ($, event, next) => {
    const result = await next(event);
    bridge?.emit('session.append', event);
    if (event.origin.kind === 'task-notification' && result.message && result.uuid) {
      bridge?.emit('task.append', { origin: event.origin, message: result.message, uuid: result.uuid,
        ...(event.agentId !== undefined ? { agentId: event.agentId } : {}) });
    }
    return result;
  });

  on('tool.call', async ($, event, next) => {
    const result = await next(event);
    bridge?.emit('tool.call', { input: event, result });
    return result;
  });

  on('agent.spawn', async ($, event, next) => {
    const result = await next(event);
    bridge?.emit('agent.spawn', { input: event, result });
    return result;
  });

  on('ui.render', { component: 'UserMessage' }, async ($, event, next) => {
    const result = await next(event);
    if (event.component === 'UserMessage' && event.props.origin.kind === 'task-notification' && event.props.task) bridge?.emit('task.notification', event.props.task);
    return result;
  });

  on('classic.Stop', async ($, event, next) => {
    const result = await next(event);
    if (event.agent_id === undefined) bridge?.emit('classic.Stop', { background_tasks: event.background_tasks });
    return result;
  });

  on('session.measure', async ($, event, next) => {
    const result = await next(event);
    bridge?.emit('session.measure', event);
    return result;
  });

  on('classic.PermissionRequest', async ($, event, next) => {
    const prior = await next(event);
    if (!enabled) return prior;
    if (prior.decision || prior.preventContinuation || prior.block) return prior;
    if (!bridge) return { ...prior, decision: { behavior: 'deny', message: 'Relay native bridge is unavailable' } };
    const decision = await bridge.interact({ kind: 'permission', toolName: event.tool_name,
      input: event.tool_input, suggestions: event.permission_suggestions }, next.signal);
    return { ...prior, decision };
  }).catch(($, event, next) => {
    return { decision: { behavior: 'deny', message: 'Relay permission handler failed' } };
  });

  on('classic.PreToolUse', { tool: 'AskUserQuestion' }, async ($, event, next) => {
    const prior = await next(event);
    if (!enabled) return prior;
    if (prior.deny) return prior;
    const input = prior.updatedInput ?? Object.fromEntries(Object.entries(event).filter(([key]) => key !== 'tool' && key !== 'tool_use_id'));
    if (prior.allow && input.answers && typeof input.answers === 'object') return prior;
    if (!bridge) return { deny: 'Relay native bridge is unavailable' };
    const result = await bridge.interact({ kind: 'question', toolName: 'AskUserQuestion',
      input, toolUseId: event.tool_use_id }, next.signal);
    if (result.behavior !== 'allow') return { ...prior, allow: undefined, ask: undefined, deny: result.message ?? 'Question canceled' };
    const updatedInput = result.updatedInput;
    if (!updatedInput || !Array.isArray(updatedInput.questions) ||
        JSON.stringify(updatedInput.questions) !== JSON.stringify(input.questions) ||
        !updatedInput.answers || typeof updatedInput.answers !== 'object') {
      return { ...prior, allow: undefined, ask: undefined, deny: 'Question answer is missing its original questions or answers' };
    }
    return { ...prior, deny: undefined, ask: undefined, allow: true, updatedInput };
  }).catch(($, event, next) => {
    return { deny: 'Relay question handler failed' };
  });

  on('session.end', async ($, event, next) => {
    bridge?.cancelInteractions('The native session ended');
    bridge?.emit('session.end', event);
    if (event.reason !== 'clear' && event.reason !== 'resume') bridge?.close('The native session ended');
    return next(event);
  });
};
