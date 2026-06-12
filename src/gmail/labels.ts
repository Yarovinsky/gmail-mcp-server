/**
 * Gmail label listing (HLD §12.2, §18). `users.labels.list` returns the FULL label
 * set (no pagination, §18) but omits the per-label counts; those are populated by
 * `users.labels.get`, so this module fetches each filtered label's detail to fill
 * the §12.2 count fields. Detail failures degrade gracefully to zero counts rather
 * than failing the whole listing. Lives in the `gmail` layer (no MCP SDK import).
 */

import { type AppResult, ok } from '../util/result.js';
import type { GmailClient } from './gmailClient.js';

export interface GmailLabel {
  id: string;
  name: string;
  type: string;
  messagesTotal: number;
  messagesUnread: number;
  threadsTotal: number;
  threadsUnread: number;
}

export interface ListLabelsOptions {
  includeSystem: boolean;
  includeUser: boolean;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' ? value : fallback;
}

/** Normalize a Gmail label `type` to 'system' or 'user' (defaults to 'user'). */
function normalizeType(type: string | null | undefined): string {
  return (type ?? 'user').toLowerCase() === 'system' ? 'system' : 'user';
}

/**
 * List Gmail labels, filtered by system/user, with counts populated from each
 * label's detail (§12.2). Returns the full set — Gmail does not paginate labels (§18).
 */
export async function listLabels(
  gmail: GmailClient,
  options: ListLabelsOptions,
): Promise<AppResult<GmailLabel[]>> {
  const listed = await gmail.execute({
    label: 'users.labels.list',
    run: (api) => api.users.labels.list({ userId: 'me' }).then((response) => response.data),
  });
  if (!listed.ok) return listed;

  const all = listed.value.labels ?? [];
  const filtered = all.filter((label) => {
    const isSystem = normalizeType(label.type) === 'system';
    return isSystem ? options.includeSystem : options.includeUser;
  });

  // labels.list omits counts; fetch each label's detail to fill them (§12.2).
  const details = await Promise.all(
    filtered.map((label) =>
      gmail.execute({
        label: 'users.labels.get',
        run: (api) =>
          api.users.labels.get({ userId: 'me', id: label.id ?? '' }).then((r) => r.data),
      }),
    ),
  );

  const labels: GmailLabel[] = filtered.map((base, index) => {
    const detail = details[index];
    const counts = detail.ok ? detail.value : {};
    return {
      id: base.id ?? '',
      name: base.name ?? '',
      type: normalizeType(base.type),
      messagesTotal: numberOr(counts.messagesTotal, 0),
      messagesUnread: numberOr(counts.messagesUnread, 0),
      threadsTotal: numberOr(counts.threadsTotal, 0),
      threadsUnread: numberOr(counts.threadsUnread, 0),
    };
  });

  return ok(labels);
}
