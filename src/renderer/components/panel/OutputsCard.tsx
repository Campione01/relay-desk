import { CodeXml, File } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useT } from '../../i18n';
import { outputsOf, type OutputFile } from '../../lib/outputs';
import { useController, useCurrentView } from '../../state/context';
import { ICON } from '../ui/primitives';
import { PanelCard } from './PanelCard';

/** Rows the desktop shows before "Show more". */
const OUTPUTS_SHOWN = 5;

function OutputRow({ file }: { file: OutputFile }) {
  const controller = useController();
  const t = useT();
  const Icon = file.kind === 'code' ? CodeXml : File;
  return (
    <li>
      <button
        type="button"
        className="rd-output"
        data-testid="output-row"
        data-kind={file.kind}
        data-tip={`${file.path}\n${t('outputs.reveal')}`}
        data-tip-place="left"
        aria-description={t('outputs.reveal')}
        onClick={() => void controller.revealFile(file.path)}
      >
        <span className="rd-output__icon">
          <Icon {...ICON} />
        </span>
        <span className="rd-output__name">{file.name}</span>
      </button>
    </li>
  );
}

function OutputList({ outputs }: { outputs: readonly OutputFile[] }) {
  const t = useT();
  const [all, setAll] = useState(false);
  const shown = all ? outputs : outputs.slice(0, OUTPUTS_SHOWN);
  return (
    <>
      <ul className="rd-card__rows" aria-label={t('outputs.title')}>
        {shown.map((file) => (
          <OutputRow key={file.path} file={file} />
        ))}
      </ul>
      {outputs.length > OUTPUTS_SHOWN ? (
        <button type="button" className="rd-link rd-output__more" aria-expanded={all} onClick={() => setAll(!all)}>
          {all ? t('outputs.showLess') : t('outputs.showMore')}
        </button>
      ) : null}
    </>
  );
}

/**
 * Files Claude wrote in the session in view, newest first; a click selects the file in Explorer and never opens or
 * runs it. Hidden while there are none, as in the desktop. The desktop's drag handle is left out: Relay cards keep
 * a fixed order.
 */
export function OutputsCard() {
  const t = useT();
  const view = useCurrentView();
  const items = view?.items;
  const outputs = useMemo(() => (items ? outputsOf(items) : []), [items]);
  if (!view || outputs.length === 0) return null;
  return (
    <PanelCard id="outputs" title={t('outputs.title')} summary={<span className="rd-tnum">{outputs.length}</span>}>
      <OutputList key={view.key} outputs={outputs} />
    </PanelCard>
  );
}
