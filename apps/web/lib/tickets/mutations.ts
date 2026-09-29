'use client';

// TanStack Query mutations with optimistic updates (spec §1: replies, status, priority and
// assignee changes feel instant). Server answers and realtime pushes reconcile the caches.

import {
  isStaffRole,
  statusAfterMessage,
  type CreateTicketInput,
  type MessageAuthor,
  type TeamWithMembers,
  type TicketDetailDto,
  type TicketFormConfig,
  type TicketStatus,
  type TicketSummaryDto,
  type UpdateTicketInput,
} from '@loons/shared';
import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useCallback } from 'react';
import { toast } from 'sonner';
import { isApiRequestError } from '@/lib/api/errors';
import { acknowledgeTicket, createTicket, postMessage, updateTicket } from './api';
import {
  applyTicketDetail,
  applyTicketSummary,
  findCachedTicket,
  patchTicketEverywhere,
  queryHoldsTicket,
  setLocalMessageStatus,
  updateThread,
  upsertThreadMessage,
} from './cache';
import { useApiErrorText } from './i18n';
import { newClientTempId } from './ids';
import { ticketKeys } from './keys';
import type { AnyTicketDto, SendMessageInput, ThreadMessage } from './types';
import { useViewer } from './viewer';

/** The author of a message (`MessageDto.author`, the shared `MessageAuthor`). */
export type MessageAuthorRef = MessageAuthor;

function invalidateListsAndCounts(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: ticketKeys.lists() });
  void queryClient.invalidateQueries({ queryKey: ticketKeys.counts() });
}

/** Status side effects the API applies with a status change (solvedAt set / cleared). */
function withStatus<T extends AnyTicketDto>(ticket: T, status: TicketStatus, nowIso: string): T {
  if (ticket.status === status) return ticket;
  let solvedAt: string | null = null; // reopening clears it
  if (status === 'SOLVED') solvedAt = ticket.solvedAt ?? nowIso;
  else if (status === 'CLOSED') solvedAt = ticket.solvedAt;
  return { ...ticket, status, solvedAt };
}

// ───────────── Create ─────────────

/** POST /tickets. On success the new ticket is cached and lists / counts refetch. */
export function useCreateTicket() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: ['tickets', 'create'],
    mutationFn: (input: CreateTicketInput) => createTicket(input),
    onSuccess: (ticket) => {
      queryClient.setQueryData(ticketKeys.detail(ticket.ref), ticket);
      invalidateListsAndCounts(queryClient);
    },
  });
}

// ───────────── Send message ─────────────

type SendVariables = SendMessageInput & { clientTempId: string };

/**
 * Posts a reply / internal note with an optimistic bubble:
 * - `send(input)` appends a pending message (fresh `clientTempId`) and applies the status change
 *   `statusAfterMessage` predicts; the server message replaces it (deduplicated with realtime).
 * - On failure the bubble is marked failed; `retry(message)` resends it with the same
 *   clientTempId (idempotent), `discard(message)` removes it.
 * `author` defaults to the signed-in user from `ViewerProvider`.
 */
export function useSendMessage(ticketId: string, options: { author?: MessageAuthorRef } = {}) {
  const queryClient = useQueryClient();
  const viewer = useViewer();
  const t = useTranslations('tickets.toast');
  const errorText = useApiErrorText();

  const mutation = useMutation({
    mutationKey: ['tickets', 'send', ticketId],
    mutationFn: (vars: SendVariables) =>
      postMessage(ticketId, {
        type: vars.type,
        body: vars.body,
        clientTempId: vars.clientTempId,
        attachmentIds: vars.attachmentIds ?? [],
        andSolve: vars.andSolve ?? false,
      }),
    // The thread is never cancelled or replaced here: a load in flight merges the pending
    // message when it finishes, and a thread that hasn't loaded yet gets it then (updateThread).
    onMutate: (vars) => {
      const author: MessageAuthorRef | null =
        options.author ?? (viewer ? { id: viewer.id, name: viewer.name, role: viewer.role } : null);
      const nowIso = new Date().toISOString();
      const pending: ThreadMessage = {
        id: vars.clientTempId,
        ticketId,
        type: vars.type,
        body: vars.body.trim(),
        author,
        clientTempId: vars.clientTempId,
        attachments: vars.attachments ?? [],
        createdAt: nowIso,
        local: { status: 'pending', input: vars },
      };
      updateThread(queryClient, ticketId, (list) => upsertThreadMessage(list, pending));

      // Predict the status change so the header / lists move with the message.
      let rollback: (() => void) | undefined;
      const current = findCachedTicket(queryClient, ticketId);
      const role = author?.role ?? viewer?.role;
      if (current && role) {
        const next = statusAfterMessage({
          current: current.status,
          author: isStaffRole(role) ? 'staff' : 'client',
          type: vars.type,
          andSolve: vars.andSolve,
        });
        if (next) {
          rollback = patchTicketEverywhere(queryClient, ticketId, (tk) =>
            withStatus(tk, next, nowIso),
          );
        }
      }
      return { rollback };
    },
    onSuccess: ({ message, ticket }) => {
      updateThread(queryClient, ticketId, (list) => upsertThreadMessage(list, message));
      applyTicketSummary(queryClient, ticket);
    },
    onError: (error, vars, context) => {
      updateThread(queryClient, ticketId, (list) =>
        setLocalMessageStatus(list, vars.clientTempId, 'failed'),
      );
      context?.rollback?.();
      if (isApiRequestError(error) && error.code === 'CONFLICT') toast.error(t('closed'));
      else toast.error(t('sendFailed', { reason: errorText(error) }));
    },
    onSettled: () => invalidateListsAndCounts(queryClient),
  });

  const { mutate } = mutation;

  /** Sends a message; returns its clientTempId. */
  const send = useCallback(
    (input: SendMessageInput): string => {
      const clientTempId = input.clientTempId ?? newClientTempId();
      mutate({ ...input, clientTempId });
      return clientTempId;
    },
    [mutate],
  );

  const retry = useCallback(
    (message: ThreadMessage) => {
      if (!message.local || !message.clientTempId) return;
      mutate({ ...message.local.input, clientTempId: message.clientTempId });
    },
    [mutate],
  );

  const discard = useCallback(
    (message: ThreadMessage) => {
      if (!message.local) return;
      updateThread(queryClient, ticketId, (list) => list.filter((m) => m.id !== message.id));
    },
    [queryClient, ticketId],
  );

  return { ...mutation, send, retry, discard };
}

// ───────────── Update ticket ─────────────

export interface UpdateTicketVariables {
  ticketId: string;
  patch: UpdateTicketInput;
  /**
   * Display fields the hook can't derive from its caches (e.g. `site` for a `siteId` change, or
   * `assignee` when the teams list isn't loaded). Merged into the optimistic copy.
   */
  optimistic?: Partial<TicketSummaryDto> & Partial<Pick<TicketDetailDto, 'assetId'>>;
}

/**
 * Derives what the ticket will look like after `patch`, from cached config / teams. Fields it
 * can't resolve are left unchanged until the server answers.
 */
export function optimisticTicketPatch(
  queryClient: QueryClient,
  patch: UpdateTicketInput,
  nowIso: string = new Date().toISOString(),
): <T extends AnyTicketDto>(ticket: T) => T {
  const config = queryClient.getQueryData<TicketFormConfig>(ticketKeys.formConfig());
  const teams = queryClient.getQueryData<TeamWithMembers[]>(ticketKeys.teams());

  return <T extends AnyTicketDto>(input: T): T => {
    let ticket: T = input;
    if (patch.status) ticket = withStatus(ticket, patch.status, nowIso);
    if (patch.priority) ticket = { ...ticket, priority: patch.priority };
    if (patch.impact) ticket = { ...ticket, impact: patch.impact };
    if (patch.tags) ticket = { ...ticket, tags: [...new Set(patch.tags)] };
    if (patch.assigneeId !== undefined) {
      if (patch.assigneeId === null) ticket = { ...ticket, assignee: null };
      else {
        const member = teams
          ?.flatMap((team) => team.members)
          .find((m) => m.id === patch.assigneeId);
        if (member) ticket = { ...ticket, assignee: { id: member.id, name: member.name } };
      }
    }
    if (patch.categoryId) {
      const category = config?.categories.find((c) => c.id === patch.categoryId);
      if (category) {
        const { id, key, labelEn, labelAr, icon, team } = category;
        ticket = { ...ticket, category: { id, key, labelEn, labelAr, icon, isActive: true }, team };
      }
    }
    if (patch.subtypeId) {
      const subtype = config?.categories
        .flatMap((c) => c.subtypes)
        .find((s) => s.id === patch.subtypeId);
      if (subtype) {
        const { id, key, labelEn, labelAr } = subtype;
        ticket = { ...ticket, subtype: { id, key, labelEn, labelAr, isActive: true } };
      }
    }
    if (patch.assetId !== undefined && 'requesterCard' in ticket) {
      ticket = { ...ticket, assetId: patch.assetId || null };
    }
    return ticket;
  };
}

/**
 * PATCH /tickets/:id with an optimistic update of the detail and every cached list row; on error
 * the caches roll back and a toast explains why. `mutate({ ticketId, patch, optimistic? })`.
 */
export function useUpdateTicket() {
  const queryClient = useQueryClient();
  const t = useTranslations('tickets.toast');
  const errorText = useApiErrorText();

  return useMutation({
    mutationKey: ['tickets', 'update'],
    mutationFn: ({ ticketId, patch }: UpdateTicketVariables) => updateTicket(ticketId, patch),
    onMutate: async ({ ticketId, patch, optimistic }) => {
      // Only this ticket's copies: a refetch of them could overwrite the optimistic patch. Other
      // tickets' loads (e.g. the next ticket's first detail load) must never be cancelled.
      await queryClient.cancelQueries({
        queryKey: ticketKeys.all,
        predicate: (query) => queryHoldsTicket(query, ticketId),
      });
      const derive = optimisticTicketPatch(queryClient, patch);
      const rollback = patchTicketEverywhere(queryClient, ticketId, (ticket) => {
        const next = derive(ticket);
        if (!optimistic) return next;
        const { assetId, ...summaryFields } = optimistic;
        const merged = { ...next, ...summaryFields };
        return assetId !== undefined && 'requesterCard' in merged ? { ...merged, assetId } : merged;
      });
      return { rollback };
    },
    onError: (error, { ticketId }, context) => {
      // Undo only what this patch wrote, then reload the detail: the server's state wins.
      context?.rollback();
      void queryClient.invalidateQueries({
        queryKey: ticketKeys.details(),
        predicate: (query) => queryHoldsTicket(query, ticketId),
      });
      toast.error(t('updateFailed', { reason: errorText(error) }));
    },
    onSuccess: (detail) => applyTicketDetail(queryClient, detail),
    onSettled: () => invalidateListsAndCounts(queryClient),
  });
}

// ───────────── Acknowledge a P1 ─────────────

/**
 * POST /tickets/:id/acknowledge — server-confirmed, not optimistic (acknowledging stops the
 * escalation chain, so the UI only says "Acknowledged" once the API has stored it). On success
 * the returned detail (with `p1AckedBy` / `p1AckedAt`, the first acknowledger's on a repeat) is
 * written into every cached copy. Errors are left to the caller (the P1 banner shows them).
 */
export function useAcknowledgeTicket() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: ['tickets', 'acknowledge'],
    mutationFn: (ticketId: string) => acknowledgeTicket(ticketId),
    onSuccess: (result) => {
      applyTicketDetail(queryClient, result.ticket);
      invalidateListsAndCounts(queryClient);
    },
    onError: (_error, ticketId) => {
      // The ticket may have changed (no longer P1, acknowledged elsewhere): reload what's shown.
      void queryClient.invalidateQueries({
        queryKey: ticketKeys.details(),
        predicate: (query) => queryHoldsTicket(query, ticketId),
      });
    },
  });
}
