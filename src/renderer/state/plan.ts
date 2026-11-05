import type { AuthStatus, PlanUsage, WorkflowsSetting } from '@shared/types';
import { planLabel } from '../lib/format';
import type { AccountLabelState, PlanEvidence } from './types';

/**
 * Plan shown for an account: the stored auth status, unless a live session or a usage fetch reported a plan after
 * the status first reported its own. The CLI keeps the plan from the last sign-in, so a re-check that repeats the
 * same plan is not newer evidence. Undefined when the account is not logged in.
 */
export function currentPlan(
  status: AuthStatus | undefined,
  evidence: PlanEvidence | undefined,
  usage: PlanUsage | undefined,
): string | undefined {
  if (!status?.loggedIn) return undefined;
  let plan = status.subscriptionType;
  let at = evidence?.authSince ?? status.checkedAt;
  const reports = [evidence?.session, usage?.subscriptionType ? { subscriptionType: usage.subscriptionType, at: usage.fetchedAt } : undefined];
  for (const report of reports) {
    if (report?.subscriptionType && report.at > at) {
      plan = report.subscriptionType;
      at = report.at;
    }
  }
  return plan;
}

/**
 * The plan Claude Code itself works with: the plan stored at sign-in, which auth status and usage report. A live session
 * reports the profile's plan name when the CLI has one (CLI 2.1.302), which may already name a newer plan, so it is not
 * evidence here. Undefined when the account is not logged in.
 */
export function cliWorkingPlan(
  status: AuthStatus | undefined,
  evidence: PlanEvidence | undefined,
  usage: PlanUsage | undefined,
): string | undefined {
  if (!status?.loggedIn) return undefined;
  const since = evidence?.authSince ?? status.checkedAt;
  return usage?.subscriptionType && usage.fetchedAt > since ? usage.subscriptionType : status.subscriptionType;
}

/** PlanEvidence.authSince after a new auth status: kept while the status repeats the same plan. */
export function nextAuthSince(before: AuthStatus | undefined, since: number | undefined, next: AuthStatus): number {
  const same = before?.loggedIn && next.loggedIn && before.subscriptionType === next.subscriptionType;
  return same ? (since ?? before.checkedAt) : next.checkedAt;
}

/** "pro" from auth status, "Claude Pro" from a live session: both "pro"; "Claude Max 20x" is "max". */
export function normalizePlan(plan: string | undefined): string | undefined {
  return plan?.trim().toLowerCase().replace(/^claude\s+/, '').replace(/\s+\d{1,3}x$/, '') || undefined;
}

/** The CLI's plan check. */
export function isProPlan(plan: string | undefined): boolean {
  return normalizePlan(plan) === 'pro';
}

/** "default_claude_max_20x" -> "20x". */
export function tierLabel(rateLimitTier: string | undefined): string | undefined {
  return /_(\d{1,3})x$/.exec(rateLimitTier ?? '')?.[1]?.concat('x');
}

export interface PlanDisplay {
  /** The plan to show, e.g. "Max 20x". */
  label?: string;
  /** The plan without its tier, e.g. "Max": the sidebar chip, like the desktop's, has no room for more beside the name. */
  plan?: string;
  /** The plan Claude Code still works with, when it differs from the shown one. */
  cliPlan?: string;
}

/**
 * The plan to show for an account. Claude Code keeps the plan from the sign-in after an upgrade (cliWorkingPlan); the
 * profile it fetched later (AuthStatus.profilePlan) has the current one and wins, unless the shared settings may now
 * belong to another account (label drift, or a changed label not decided yet). Behaviour that follows Claude Code, such
 * as the workflows default, uses cliWorkingPlan.
 */
export function planDisplay(
  status: AuthStatus | undefined,
  evidence: PlanEvidence | undefined,
  usage: PlanUsage | undefined,
  label: AccountLabelState | undefined,
): PlanDisplay {
  const profile = status?.loggedIn && !label?.drift && !label?.undecided ? status.profilePlan : undefined;
  if (!profile) {
    const shown = planLabel(currentPlan(status, evidence, usage));
    return shown ? { label: shown, plan: shown } : {};
  }
  const cli = cliWorkingPlan(status, evidence, usage);
  const tier = tierLabel(profile.rateLimitTier);
  const shown = planLabel(profile.subscriptionType);
  const differs = cli !== undefined && normalizePlan(cli) !== normalizePlan(profile.subscriptionType);
  return {
    ...(shown ? { label: tier ? `${shown} ${tier}` : shown, plan: shown } : {}),
    ...(differs ? { cliPlan: planLabel(normalizePlan(cli)) } : {}),
  };
}

/** Dynamic workflows for an account: the Relay setting, else the CLI's plan default (off on Pro, on otherwise). */
export function workflowsEnabled(setting: WorkflowsSetting | undefined, plan: string | undefined): boolean {
  return setting ? setting === 'on' : !isProPlan(plan);
}
