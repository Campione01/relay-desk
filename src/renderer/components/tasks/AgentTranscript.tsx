import { useEffect, useMemo, useRef, useState } from 'react';
import type { TranscriptItem } from '@shared/types';
import { useT } from '../../i18n';
import { buildBlocks } from '../../lib/toolActivity';
import { useController } from '../../state/context';
import { Markdown } from '../transcript/Markdown';
import { ResultRow, SystemRow, ThinkingRow, UserMessage } from '../transcript/Rows';
import { ToolGroup } from '../transcript/ToolGroup';
import { TRANSCRIPT_POLL_MS } from './taskModel';

type Loaded = { key: string; items?: TranscriptItem[]; error?: boolean };

/** Poll while running, with one trailing read when the native transcript finishes persisting. */
function useAgentTranscript(viewKey: string, agentId: string, running: boolean): { loaded: Loaded | null; retry(): void } {
  const controller = useController();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [attempt, setAttempt] = useState(0);
  const key = `${viewKey}\u0000${agentId}`;
  const previous = useRef<{ key: string; running: boolean } | null>(null);

  useEffect(() => {
    let finalRead = previous.current?.key === key && previous.current.running && !running;
    previous.current = { key, running };
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const run = (): void => {
      controller
        .subagentTranscript(viewKey, agentId)
        .then(
          (items) => {
            if (!cancelled) setLoaded({ key, items });
          },
          () => {
            if (!cancelled) setLoaded((prev) => ({ key, items: prev?.key === key ? prev.items : undefined, error: true }));
          },
        )
        .finally(() => {
          if (!cancelled && (running || finalRead)) {
            finalRead = false;
            timer = setTimeout(run, TRANSCRIPT_POLL_MS);
          }
        });
    };
    run();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [controller, viewKey, agentId, key, running, attempt]);

  return { loaded: loaded?.key === key ? loaded : null, retry: () => setAttempt((n) => n + 1) };
}

/** Read-only, compact rendering of one agent's own transcript with the conversation's building blocks. */
export function AgentTranscript({ viewKey, agentId, running }: { viewKey: string; agentId: string; running: boolean }) {
  const t = useT();
  const { loaded, retry } = useAgentTranscript(viewKey, agentId, running);
  const items = loaded?.items;
  const blocks = useMemo(() => (items ? buildBlocks(items).blocks : []), [items]);

  if (!loaded) return <p className="rd-tpane__note">{t('common.loading')}</p>;
  return (
    <div className="rd-tlog" data-testid="agent-transcript">
      {items && items.length === 0 ? <p className="rd-tpane__note">{t('tasks.transcriptEmpty')}</p> : null}
      {blocks.map((block) => {
        if (block.type === 'tools') {
          return <ToolGroup key={block.id} tools={block.tools} notes={block.notes} entries={block.entries} />;
        }
        const { item } = block;
        switch (item.kind) {
          case 'user':
            return <UserMessage key={item.id} item={item} viewKey={viewKey} running={false} />;
          case 'assistant':
            return (
              <div key={item.id} className="rd-assistant" data-testid="assistant-message">
                <Markdown text={item.text} />
              </div>
            );
          case 'thinking':
            return <ThinkingRow key={item.id} item={item} />;
          case 'system':
            return <SystemRow key={item.id} item={item} />;
          case 'result':
            return <ResultRow key={item.id} item={item} />;
          default:
            return null;
        }
      })}
      {loaded.error ? (
        <p className="rd-tpane__note rd-tpane__error" data-testid="transcript-error">
          <span>{t('tasks.transcriptError')}</span>
          <button type="button" className="rd-link" onClick={retry}>
            {t('common.retry')}
          </button>
        </p>
      ) : null}
    </div>
  );
}
