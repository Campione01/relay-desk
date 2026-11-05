import type { ProfileId } from '@shared/types';

/** A group of the user's own in the sidebar ("Move to"), as the desktop's sidebar groups. */
export interface SidebarGroup {
  id: string;
  name: string;
}

/** What the sidebar's session menu changes, per account (desktop parity). */
export interface SidebarMarks {
  /** Session ids, the newest pin first. */
  pinned: string[];
  unread: string[];
  archived: string[];
  groups: SidebarGroup[];
  /** Session id -> id of the own group it was moved to. */
  placement: Record<string, string>;
}

export const SIDEBAR_MARKS_KEY = 'relay.sidebarMarks';
export const MAX_PINNED = 50;
export const MAX_MARKED = 1000;
export const MAX_GROUPS = 50;
const MAX_ID_LENGTH = 100;
const MAX_GROUP_NAME = 80;

export const EMPTY_MARKS: SidebarMarks = { pinned: [], unread: [], archived: [], groups: [], placement: {} };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const isId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH;

function ids(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(isId).map((id) => id.toLowerCase()))].slice(0, limit);
}

/** Keeps only well-formed entries: the store is user-editable local data. */
export function sanitizeMarks(value: unknown): SidebarMarks {
  if (!isObject(value)) return EMPTY_MARKS;
  const groups: SidebarGroup[] = [];
  for (const group of Array.isArray(value.groups) ? value.groups : []) {
    if (!isObject(group) || !isId(group.id) || typeof group.name !== 'string') continue;
    const name = group.name.trim().slice(0, MAX_GROUP_NAME);
    if (name && !groups.some((g) => g.id === group.id)) groups.push({ id: group.id, name });
    if (groups.length >= MAX_GROUPS) break;
  }
  const placement: Record<string, string> = Object.create(null) as Record<string, string>;
  if (isObject(value.placement)) {
    for (const [session, group] of Object.entries(value.placement).slice(0, MAX_MARKED)) {
      if (isId(session) && typeof group === 'string' && groups.some((g) => g.id === group)) placement[session.toLowerCase()] = group;
    }
  }
  return {
    pinned: ids(value.pinned, MAX_PINNED),
    unread: ids(value.unread, MAX_MARKED),
    archived: ids(value.archived, MAX_MARKED),
    groups,
    placement: { ...placement },
  };
}

export function readMarks(): Record<ProfileId, SidebarMarks> {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(SIDEBAR_MARKS_KEY) ?? '{}');
    if (!isObject(value)) return {};
    return Object.fromEntries(Object.entries(value).map(([profileId, marks]) => [profileId, sanitizeMarks(marks)]));
  } catch {
    return {};
  }
}

export function writeMarks(all: Readonly<Record<ProfileId, SidebarMarks>>): void {
  try {
    window.localStorage.setItem(SIDEBAR_MARKS_KEY, JSON.stringify(all));
  } catch {
    // The marks still apply for this run when storage is unavailable.
  }
}

const without = (list: readonly string[], id: string): string[] => list.filter((entry) => entry !== id);

export function withPin(marks: SidebarMarks, sessionId: string, pinned: boolean): SidebarMarks {
  const id = sessionId.toLowerCase();
  const rest = without(marks.pinned, id);
  return { ...marks, pinned: pinned ? [id, ...rest].slice(0, MAX_PINNED) : rest };
}

export function withUnread(marks: SidebarMarks, sessionId: string, unread: boolean): SidebarMarks {
  const id = sessionId.toLowerCase();
  if (marks.unread.includes(id) === unread) return marks;
  return { ...marks, unread: unread ? [id, ...marks.unread].slice(0, MAX_MARKED) : without(marks.unread, id) };
}

/** Archiving takes a session off the list, its pin and unread mark included; unarchiving brings it back unpinned. */
export function withArchived(marks: SidebarMarks, sessionId: string, archived: boolean): SidebarMarks {
  const id = sessionId.toLowerCase();
  const rest = without(marks.archived, id);
  if (!archived) return { ...marks, archived: rest };
  return { ...marks, archived: [id, ...rest].slice(0, MAX_MARKED), pinned: without(marks.pinned, id), unread: without(marks.unread, id) };
}

/** Moves a session into one of the user's groups, or back to its folder with null. */
export function withPlacement(marks: SidebarMarks, sessionId: string, groupId: string | null): SidebarMarks {
  const id = sessionId.toLowerCase();
  const placement = { ...marks.placement };
  delete placement[id];
  if (groupId && marks.groups.some((g) => g.id === groupId)) placement[id] = groupId;
  return { ...marks, placement };
}

export function withGroup(marks: SidebarMarks, group: SidebarGroup): SidebarMarks {
  const name = group.name.trim().slice(0, MAX_GROUP_NAME);
  if (!name) return marks;
  const exists = marks.groups.some((g) => g.id === group.id);
  if (!exists && marks.groups.length >= MAX_GROUPS) return marks;
  const groups = exists ? marks.groups.map((g) => (g.id === group.id ? { ...g, name } : g)) : [...marks.groups, { id: group.id, name }];
  return { ...marks, groups };
}

/** Removing a group sends its sessions back to their folders. */
export function withoutGroup(marks: SidebarMarks, groupId: string): SidebarMarks {
  const placement = Object.fromEntries(Object.entries(marks.placement).filter(([, group]) => group !== groupId));
  return { ...marks, groups: marks.groups.filter((g) => g.id !== groupId), placement };
}

/** A deleted session leaves no marks behind. */
export function forgetSession(marks: SidebarMarks, sessionId: string): SidebarMarks {
  const id = sessionId.toLowerCase();
  const placement = { ...marks.placement };
  delete placement[id];
  return {
    ...marks,
    pinned: without(marks.pinned, id),
    unread: without(marks.unread, id),
    archived: without(marks.archived, id),
    placement,
  };
}
