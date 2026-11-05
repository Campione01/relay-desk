import { Check, Copy } from 'lucide-react';
import { memo, useMemo, useRef, useState, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import { useT } from '../../i18n';
import { useController } from '../../state/context';
import { ICON_SM } from '../ui/primitives';

const REMARK_PLUGINS = [remarkGfm];
const REHYPE_PLUGINS: NonNullable<Parameters<typeof ReactMarkdown>[0]['rehypePlugins']> = [
  [rehypeHighlight, { detect: false }],
];

function CodeBlock({ children }: { children: ReactNode }) {
  const t = useT();
  const ref = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const copy = async (): Promise<void> => {
    const text = ref.current?.textContent ?? '';
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="rd-md__code">
      <pre ref={ref}>{children}</pre>
      <button
        type="button"
        className="rd-md__copy rd-iconbtn rd-iconbtn--sm rd-iconbtn--muted"
        aria-label={copied ? t('common.copied') : t('common.copy')}
        data-tip={copied ? t('common.copied') : t('common.copy')}
        onClick={() => void copy()}
      >
        {copied ? <Check {...ICON_SM} /> : <Copy {...ICON_SM} />}
      </button>
    </div>
  );
}

/** Assistant prose: GFM markdown with highlighted code; raw HTML is never rendered. */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const controller = useController();
  const components = useMemo<Components>(
    () => ({
      a: ({ href, children, node: _node, ...rest }) => (
        <a
          {...rest}
          href={href}
          rel="noreferrer"
          onClick={(event) => {
            event.preventDefault();
            if (href) void controller.openUrl(href);
          }}
        >
          {children}
        </a>
      ),
      pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
      table: ({ children, node: _node, ...rest }) => (
        <div className="rd-md__table">
          <table {...rest}>{children}</table>
        </div>
      ),
    }),
    [controller],
  );
  return (
    <div className="rd-md rd-selectable">
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
