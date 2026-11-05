import { ChevronDown, ChevronRight, TriangleAlert } from 'lucide-react';
import { useId, useState } from 'react';
import type { PermissionRequest } from '@shared/types';
import { parseWorkflowMeta, workflowNameOf, type WorkflowMetaPhase } from '@shared/workflowMeta';
import { useT } from '../../i18n';
import { ICON_SM } from '../ui/primitives';

const MAX_ARGS = 1200;

export interface WorkflowLaunch {
  name?: string;
  description?: string;
  phases: WorkflowMetaPhase[];
  script?: string;
  /** The `args` value the script receives, as JSON. */
  args?: string;
  scriptPath?: string;
  resumeFromRunId?: string;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** What a Workflow permission request would start; the CLI sends the resolved script, also for a named or saved one. */
export function workflowLaunch(request: PermissionRequest): WorkflowLaunch | undefined {
  if (request.toolName !== 'Workflow') return undefined;
  const input =
    request.input && typeof request.input === 'object' && !Array.isArray(request.input)
      ? (request.input as Record<string, unknown>)
      : {};
  const script = typeof input.script === 'string' && input.script.trim() ? input.script : undefined;
  const meta = parseWorkflowMeta(script);
  const name = workflowNameOf(input);
  const json = input.args === undefined ? undefined : JSON.stringify(input.args, null, 2);
  const args = json === undefined ? undefined : json.length > MAX_ARGS ? `${json.slice(0, MAX_ARGS)}…` : json;
  const scriptPath = text(input.scriptPath);
  const resumeFromRunId = text(input.resumeFromRunId);
  return {
    ...(name ? { name } : {}),
    ...(meta?.description ? { description: meta.description } : {}),
    phases: meta?.phases ?? [],
    ...(script ? { script } : {}),
    ...(args ? { args } : {}),
    ...(scriptPath ? { scriptPath } : {}),
    ...(resumeFromRunId ? { resumeFromRunId } : {}),
  };
}

/**
 * Body of the workflow approval card (desktop parity): the phases, a usage caution, everything else the launch
 * receives (arguments, script file, resumed run, the CLI's reason) and the script on request.
 */
export function WorkflowApproval({ launch, note }: { launch: WorkflowLaunch; note?: string }) {
  const t = useT();
  const [showScript, setShowScript] = useState(false);
  const scriptId = useId();
  return (
    <div className="rd-perm__workflow" data-testid="workflow-approval">
      {note ? <p className="rd-perm__sub">{note}</p> : null}
      {launch.phases.length > 0 ? (
        <ol className="rd-perm__phases" aria-label={t('permission.workflow.phases')}>
          {launch.phases.map((phase, index) => (
            <li key={`${index}:${phase.title}`} className="rd-perm__phase">
              <span className="rd-perm__phase-index rd-tnum" aria-hidden="true">
                {index + 1}
              </span>
              <span className="rd-perm__phase-text">
                <span className="rd-perm__phase-title">{phase.title}</span>
                {phase.detail ? <span className="rd-perm__phase-detail">{phase.detail}</span> : null}
              </span>
            </li>
          ))}
        </ol>
      ) : null}
      {launch.scriptPath || launch.resumeFromRunId ? (
        <dl className="rd-perm__facts">
          {launch.scriptPath ? (
            <div className="rd-perm__fact">
              <dt>{t('permission.workflow.file')}</dt>
              <dd className="rd-mono rd-selectable">{launch.scriptPath}</dd>
            </div>
          ) : null}
          {launch.resumeFromRunId ? (
            <div className="rd-perm__fact">
              <dt>{t('permission.workflow.resume')}</dt>
              <dd className="rd-mono rd-selectable">{launch.resumeFromRunId}</dd>
            </div>
          ) : null}
        </dl>
      ) : null}
      {launch.args ? (
        <div className="rd-perm__args">
          <span className="rd-perm__label">{t('permission.workflow.args')}</span>
          <pre className="rd-perm__detail rd-mono rd-selectable">{launch.args}</pre>
        </div>
      ) : null}
      <p className="rd-perm__caution">
        <TriangleAlert {...ICON_SM} aria-hidden="true" />
        <span>{t('permission.workflow.caution')}</span>
      </p>
      {launch.script ? (
        <>
          <button
            type="button"
            className="rd-link rd-perm__script-toggle"
            aria-expanded={showScript}
            aria-controls={scriptId}
            onClick={() => setShowScript((shown) => !shown)}
          >
            {t('permission.workflow.script')}
            {showScript ? <ChevronDown {...ICON_SM} aria-hidden="true" /> : <ChevronRight {...ICON_SM} aria-hidden="true" />}
          </button>
          <pre id={scriptId} className="rd-perm__detail rd-perm__script rd-mono rd-selectable" hidden={!showScript}>
            {launch.script}
          </pre>
        </>
      ) : null}
    </div>
  );
}
