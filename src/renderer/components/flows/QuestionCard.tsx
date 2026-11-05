import { Fragment, useState } from 'react';
import type { Question, QuestionAnswer, QuestionRequest } from '@shared/types';
import { useT } from '../../i18n';
import { errorText } from '../../lib/format';
import { useController } from '../../state/context';
import { Markdown } from '../transcript/Markdown';

interface QuestionState {
  selected: string[];
  otherOn: boolean;
  other: string;
}

const EMPTY: QuestionState = { selected: [], otherOn: false, other: '' };

/** Builds the SDK AskUserQuestion answer for one question; '' when unanswered. */
export function answerFor(question: Question, state: QuestionState): string {
  const other = state.otherOn ? state.other.trim() : '';
  if (question.multiSelect) return [...state.selected, ...(other ? [other] : [])].join(', ');
  if (state.otherOn) return other;
  return state.selected[0] ?? '';
}

/** AskUserQuestion card: single choice as buttons, multi choice as checkboxes, plus free text. */
export function QuestionCard({ viewKey, request }: { viewKey: string; request: QuestionRequest }) {
  const controller = useController();
  const t = useT();
  const [states, setStates] = useState<QuestionState[]>(() => request.questions.map(() => EMPTY));
  const [focusedPreview, setFocusedPreview] = useState<Record<number, string | undefined>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const update = (index: number, next: (state: QuestionState) => QuestionState): void =>
    setStates((list) => list.map((state, i) => (i === index ? next(state) : state)));

  const answers = request.questions.map((q, i) => answerFor(q, states[i] ?? EMPTY));
  const complete = answers.every((a) => a.length > 0);

  const respond = async (answer: QuestionAnswer | null): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await controller.respondQuestion(viewKey, request.requestId, answer);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  const submit = (): void => {
    if (!complete) return;
    const answer: QuestionAnswer = {};
    request.questions.forEach((q, i) => {
      answer[q.question] = answers[i]!;
    });
    void respond(answer);
  };

  return (
    <section className="rd-question" aria-label={t('question.label')} data-testid="question-card">
      {request.questions.map((question, qi) => {
        const state = states[qi] ?? EMPTY;
        const groupName = `${request.requestId}-${qi}`;
        const preview = focusedPreview[qi];
        return (
          <Fragment key={qi}>
            {qi > 0 ? <div className="rd-question__sep" aria-hidden="true" /> : null}
            <fieldset className="rd-question__block">
              <legend className="rd-question__legend">
                {question.header ? <span className="rd-badge">{question.header}</span> : null}
                <span className="rd-question__text">{question.question}</span>
              </legend>
              <div className="rd-question__options" role={question.multiSelect ? 'group' : 'radiogroup'} aria-label={question.question}>
                {question.options.map((option) => {
                  const checked = state.selected.includes(option.label);
                  return (
                    <label key={option.label} className="rd-qopt" data-checked={checked || undefined}>
                      <input
                        type={question.multiSelect ? 'checkbox' : 'radio'}
                        name={groupName}
                        checked={checked}
                        onFocus={() => setFocusedPreview((p) => ({ ...p, [qi]: option.preview }))}
                        onChange={() =>
                          update(qi, (s) =>
                            question.multiSelect
                              ? {
                                  ...s,
                                  selected: checked ? s.selected.filter((l) => l !== option.label) : [...s.selected, option.label],
                                }
                              : { ...s, selected: [option.label], otherOn: false },
                          )
                        }
                      />
                      <span className="rd-qopt__text">
                        <span className="rd-qopt__label">{option.label}</span>
                        {option.description ? <span className="rd-qopt__desc">{option.description}</span> : null}
                      </span>
                    </label>
                  );
                })}
                <label className="rd-qopt" data-checked={state.otherOn || undefined}>
                  <input
                    type={question.multiSelect ? 'checkbox' : 'radio'}
                    name={groupName}
                    checked={state.otherOn}
                    onChange={() =>
                      update(qi, (s) =>
                        question.multiSelect ? { ...s, otherOn: !s.otherOn } : { ...s, otherOn: true, selected: [] },
                      )
                    }
                  />
                  <span className="rd-qopt__text">
                    <span className="rd-qopt__label">{t('question.other')}</span>
                  </span>
                </label>
                {state.otherOn ? (
                  <input
                    className="rd-input rd-question__other"
                    aria-label={t('question.otherLabel', { question: question.question })}
                    placeholder={t('question.otherPlaceholder')}
                    autoFocus
                    value={state.other}
                    onChange={(event) => update(qi, (s) => ({ ...s, other: event.target.value }))}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && !event.shiftKey) {
                        event.preventDefault();
                        submit();
                      }
                    }}
                  />
                ) : null}
              </div>
              {preview ? (
                <div className="rd-question__preview">
                  <Markdown text={preview} />
                </div>
              ) : null}
            </fieldset>
          </Fragment>
        );
      })}
      {error ? (
        <p className="rd-field__error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="rd-perm__actions">
        <button type="button" className="rd-btn rd-btn--secondary" disabled={busy} onClick={() => void respond(null)}>
          {t('question.skip')}
        </button>
        <span className="rd-perm__spacer" />
        <button type="button" className="rd-btn rd-btn--primary" disabled={!complete || busy} onClick={submit}>
          {t('question.submit')}
        </button>
      </div>
    </section>
  );
}
