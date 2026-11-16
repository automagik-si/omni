import type { ChannelRegistry, HistorySyncMessage, HistorySyncMutation } from '@omni/channel-sdk';
import type { ChatCoverage } from '@omni/core/events';
import type { SyncJob, SyncJobProgress } from '@omni/db';
import type { Services } from '../services';
import { isStaleChatBackfill } from '../services/sync-jobs';

type WorkScope = <T>(fn: () => Promise<T>) => Promise<T>;

/** Serialize the shared coverage read for persisted job progress and events. */
export async function readBackfillCoverage(
  services: Services,
  chatId: string,
  from: string,
  to: string,
): Promise<ChatCoverage> {
  const coverage = await services.messages.getChatCoverage(chatId, { from: new Date(from), to: new Date(to) });
  return {
    ...coverage,
    oldest: coverage.oldest?.toISOString() ?? null,
    newest: coverage.newest?.toISOString() ?? null,
    lastInbound: coverage.lastInbound?.toISOString() ?? null,
    lastOutbound: coverage.lastOutbound?.toISOString() ?? null,
  };
}

/** Persistent pending rows determine order; this helper never owns a DB transaction while waiting. */
export async function waitForBackfillTurn(options: {
  get: () => Promise<SyncJob>;
  historyPushBlocking: () => Promise<boolean>;
  claim: () => Promise<SyncJob | null>;
  sleep?: () => Promise<void>;
}): Promise<SyncJob | null> {
  for (;;) {
    const current = await options.get();
    if (current.status !== 'pending' && !isStaleChatBackfill(current)) return null;
    if (!(await options.historyPushBlocking())) {
      const claimed = await options.claim();
      if (claimed) return claimed;
    }
    await (options.sleep?.() ?? new Promise((resolve) => setTimeout(resolve, 250)));
  }
}

const mediaTypes = new Set(['image', 'audio', 'video', 'document', 'sticker']);

async function storeBackfillMessage(
  services: Services,
  chatId: string,
  message: HistorySyncMessage,
  progress: SyncJobProgress,
): Promise<void> {
  const existing = await services.messages.getByExternalId(chatId, message.externalId);
  const type = message.content.type;
  if (mediaTypes.has(type)) {
    if (message.content.localPath) progress.mediaDownloaded++;
    else if (!existing?.mediaLocalPath) progress.mediaMissing = (progress.mediaMissing ?? 0) + 1;
  }
  if (existing) {
    progress.duplicates++;
    if (message.content.localPath && !existing.mediaLocalPath) {
      await services.messages.update(existing.id, {
        hasMedia: true,
        mediaLocalPath: message.content.localPath,
        mediaUrl: message.content.mediaUrl,
        mediaMimeType: message.content.mimeType,
      });
    }
    return;
  }
  await services.messages.create({
    chatId: chatId,
    externalId: message.externalId,
    source: 'sync',
    messageType: ['text', 'image', 'audio', 'video', 'document', 'sticker', 'contact', 'location', 'poll'].includes(
      type,
    )
      ? (type as 'text' | 'image' | 'audio' | 'video' | 'document' | 'sticker' | 'contact' | 'location' | 'poll')
      : 'text',
    textContent: message.content.text ?? message.content.caption,
    platformTimestamp: message.timestamp,
    hasMedia: mediaTypes.has(type),
    mediaMimeType: message.content.mimeType,
    mediaUrl: message.content.mediaUrl,
    mediaLocalPath: message.content.localPath,
    senderPlatformUserId: message.from,
    isFromMe: message.isFromMe,
    rawPayload: message.rawPayload as Record<string, unknown>,
  });
  progress.stored++;
}

function incrementMutationCount(progress: SyncJobProgress, kind: HistorySyncMutation['kind']): void {
  if (kind === 'reaction') progress.reactionsApplied = (progress.reactionsApplied ?? 0) + 1;
  else if (kind === 'edit') progress.editsApplied = (progress.editsApplied ?? 0) + 1;
  else progress.deletionsApplied = (progress.deletionsApplied ?? 0) + 1;
}

async function applyBackfillMutations(
  mutations: Map<string, HistorySyncMutation>,
  services: Services,
  scope: WorkScope,
  chatId: string,
  channel: SyncJob['channel'],
  progress: SyncJobProgress,
  cancelled: () => Promise<boolean>,
): Promise<void> {
  // Resolve after all message rows exist, oldest operation first. Missing targets never create rows.
  for (const mutation of [...mutations.values()].sort((a, b) => a.at.getTime() - b.at.getTime())) {
    if (await cancelled()) return;
    const result = await scope(() => services.messages.applyHistoryMutation(chatId, mutation, channel));
    if (result === 'unmatched') progress.unmatched = (progress.unmatched ?? 0) + 1;
    if (result === 'applied') incrementMutationCount(progress, mutation.kind);
  }
}

export async function processChatBackfill(options: {
  jobId: string;
  tenantId: string | null;
  services: Services;
  registry: ChannelRegistry;
  scope: WorkScope;
  assertAdmissible: () => Promise<void>;
}): Promise<void> {
  const { jobId, tenantId, services, registry, scope, assertAdmissible } = options;
  const jobs = services.syncJobs;
  const jobInstance = (await jobs.getById(jobId, tenantId)).instanceId;
  const job = await waitForBackfillTurn({
    get: () => jobs.getById(jobId, tenantId),
    historyPushBlocking: () => jobs.isHistoryPushBlocking(jobInstance, tenantId),
    claim: () => jobs.claimBackfill(jobId, tenantId),
  });
  if (!job) return;
  const config = job.config.backfill;
  if (!config) throw new Error('Missing chat backfill configuration');
  const progress: SyncJobProgress = { ...job.progress, state: 'fetching' };
  const cancelled = async () => {
    await assertAdmissible();
    return (await jobs.getById(jobId, tenantId)).status === 'cancelled';
  };
  const publishProgress = () => jobs.updateProgress(jobId, progress, tenantId);
  await publishProgress();
  const plugin = registry.get(job.channel);
  if (job.channel !== 'whatsapp-baileys' || !plugin?.fetchHistory) {
    progress.outcome = 'This channel does not provide chat history backfill';
    progress.state = 'done';
  } else {
    const [anchor] = await scope(() =>
      services.messages.getChatMessages(config.chatId, {
        before: new Date(config.to),
        limit: 1,
      }),
    );
    const mutations = new Map<string, HistorySyncMutation>();
    const seen = new Set<string>();
    const onMessage = async (message: HistorySyncMessage) => {
      if (message.chatId !== config.chatJid || (await cancelled())) return;
      if (message.timestamp < new Date(config.from) || message.timestamp > new Date(config.to)) return;
      progress.fetched++;
      if (seen.has(message.externalId)) {
        progress.duplicates++;
        return;
      }
      seen.add(message.externalId);
      await scope(() => storeBackfillMessage(services, config.chatId, message, progress));
    };
    // Structural extension avoids an API dependency on the channel implementation.
    const fetchOptions = {
      since: new Date(config.from),
      until: new Date(config.to),
      count: 50,
      channelId: config.chatJid,
      downloadMedia: true,
      anchors: [
        {
          chatJid: config.chatJid,
          messageKey: { remoteJid: config.chatJid, id: anchor?.externalId ?? '', fromMe: anchor?.isFromMe ?? false },
          timestamp: anchor ? new Date(anchor.platformTimestamp).getTime() : new Date(config.to).getTime(),
        },
      ],
      shouldCancel: cancelled,
      onMessage,
      onMutation: async (mutation: HistorySyncMutation) => {
        if (mutation.chatId !== config.chatJid || (await cancelled())) return;
        if (mutation.at < new Date(config.from) || mutation.at > new Date(config.to)) return;
        mutations.set(`${mutation.kind}:${mutation.id}:${mutation.actor}:${mutation.at.toISOString()}`, mutation);
      },
      onRound: async (round: { round: number; received: number; oldestReached: string | null }) => {
        progress.round = round.round;
        progress.oldestReached = round.oldestReached ?? progress.oldestReached;
        if (round.received === 0 && progress.stored === 0) {
          progress.state = 'phone-did-not-answer';
          progress.outcome = 'Phone did not answer the chat history request';
        }
        await publishProgress();
      },
    };
    await plugin.fetchHistory(job.instanceId, fetchOptions);
    if (await cancelled()) return;
    await applyBackfillMutations(mutations, services, scope, config.chatId, job.channel, progress, cancelled);
    if (progress.state !== 'phone-did-not-answer') {
      progress.state = 'done';
      progress.outcome = 'Finished requesting chat history';
    }
  }
  if (await cancelled()) return;
  progress.coverage = await scope(() => readBackfillCoverage(services, config.chatId, config.from, config.to));
  await publishProgress();
  await jobs.complete(jobId, tenantId);
}
