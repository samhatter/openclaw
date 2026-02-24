import { resolveUserTimezone } from "../agents/date-time.js";
import { normalizeChatType } from "../channels/chat-type.js";
import { resolveSenderLabel, type SenderLabelParams } from "../channels/sender-label.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  resolveTimezone,
  formatUtcTimestamp,
  formatZonedTimestamp,
} from "../infra/format-time/format-datetime.ts";
import { formatTimeAgo } from "../infra/format-time/format-relative.ts";

export type AgentEnvelopeParams = {
  channel: string;
  from?: string;
  timestamp?: number | Date;
  host?: string;
  ip?: string;
  body: string;
  previousTimestamp?: number | Date;
  envelope?: EnvelopeFormatOptions;
};

export type EnvelopeFormatOptions = {
  /**
   * "local" (default), "utc", "user", or an explicit IANA timezone string.
   */
  timezone?: string;
  /**
   * Include absolute timestamps in the envelope (default: true).
   */
  includeTimestamp?: boolean;
  /**
   * Include elapsed time suffix when previousTimestamp is provided (default: true).
   */
  includeElapsed?: boolean;
  /**
   * Optional user timezone used when timezone="user".
   */
  userTimezone?: string;
  /**
   * Include system envelope line (e.g., "[iMessage +1555]") in formatted output (default: true).
   * When false, returns only the message body without the bracketed envelope prefix.
   */
  includeSystemEnvelope?: boolean;
};

type NormalizedEnvelopeOptions = {
  timezone: string;
  includeTimestamp: boolean;
  includeElapsed: boolean;
  userTimezone?: string;
};

type ResolvedEnvelopeTimezone =
  | { mode: "utc" }
  | { mode: "local" }
  | { mode: "iana"; timeZone: string };

function sanitizeEnvelopeHeaderPart(value: string): string {
  // Header parts are metadata and must not be able to break the bracketed prefix.
  // Keep ASCII; collapse newlines/whitespace; neutralize brackets.
  return value
    .replace(/\r\n|\r|\n/g, " ")
    .replaceAll("[", "(")
    .replaceAll("]", ")")
    .replace(/\s+/g, " ")
    .trim();
}

export function resolveEnvelopeFormatOptions(
  cfg?: OpenClawConfig,
  channelId?: string,
): EnvelopeFormatOptions {
  const defaults = cfg?.agents?.defaults;
  const inboundCtxOptions = resolveInboundContextOptions({ cfg, channelId });
  return {
    timezone: defaults?.envelopeTimezone,
    includeTimestamp: defaults?.envelopeTimestamp !== "off",
    includeElapsed: defaults?.envelopeElapsed !== "off",
    userTimezone: defaults?.userTimezone,
    includeSystemEnvelope: inboundCtxOptions.includeSystemEnvelope,
  };
}

/**
 * Resolve inbound context options with channel-specific overrides.
 * Precedence: channel override > channel defaults > agent defaults > true (default).
 */
export function resolveInboundContextOptions(params: {
  cfg?: OpenClawConfig;
  channelId?: string;
}): {
  includeSystemEnvelope: boolean;
  includeConversationInfo: boolean;
  includeSenderInfo: boolean;
} {
  const agentDefaults = params.cfg?.agents?.defaults?.inboundContext;
  const channelDefaults = params.cfg?.channels?.defaults?.inboundContext;
  const channelOverride = params.channelId
    ? (params.cfg?.channels?.[params.channelId] as { inboundContext?: Record<string, boolean> })
        ?.inboundContext
    : undefined;

  return {
    includeSystemEnvelope:
      channelOverride?.includeSystemEnvelope ??
      channelDefaults?.includeSystemEnvelope ??
      agentDefaults?.includeSystemEnvelope ??
      true,
    includeConversationInfo:
      channelOverride?.includeConversationInfo ??
      channelDefaults?.includeConversationInfo ??
      agentDefaults?.includeConversationInfo ??
      true,
    includeSenderInfo:
      channelOverride?.includeSenderInfo ??
      channelDefaults?.includeSenderInfo ??
      agentDefaults?.includeSenderInfo ??
      true,
  };
}

function normalizeEnvelopeOptions(options?: EnvelopeFormatOptions): NormalizedEnvelopeOptions {
  const includeTimestamp = options?.includeTimestamp !== false;
  const includeElapsed = options?.includeElapsed !== false;
  return {
    timezone: options?.timezone?.trim() || "local",
    includeTimestamp,
    includeElapsed,
    userTimezone: options?.userTimezone,
  };
}

function resolveEnvelopeTimezone(options: NormalizedEnvelopeOptions): ResolvedEnvelopeTimezone {
  const trimmed = options.timezone?.trim();
  if (!trimmed) {
    return { mode: "local" };
  }
  const lowered = trimmed.toLowerCase();
  if (lowered === "utc" || lowered === "gmt") {
    return { mode: "utc" };
  }
  if (lowered === "local" || lowered === "host") {
    return { mode: "local" };
  }
  if (lowered === "user") {
    return { mode: "iana", timeZone: resolveUserTimezone(options.userTimezone) };
  }
  const explicit = resolveTimezone(trimmed);
  return explicit ? { mode: "iana", timeZone: explicit } : { mode: "utc" };
}

function formatTimestamp(
  ts: number | Date | undefined,
  options?: EnvelopeFormatOptions,
): string | undefined {
  if (!ts) {
    return undefined;
  }
  const resolved = normalizeEnvelopeOptions(options);
  if (!resolved.includeTimestamp) {
    return undefined;
  }
  const date = ts instanceof Date ? ts : new Date(ts);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }
  const zone = resolveEnvelopeTimezone(resolved);
  // Include a weekday prefix so models do not need to derive DOW from the date
  // (small models are notoriously unreliable at that).
  const weekday = (() => {
    try {
      if (zone.mode === "utc") {
        return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short" }).format(date);
      }
      if (zone.mode === "local") {
        return new Intl.DateTimeFormat("en-US", { weekday: "short" }).format(date);
      }
      return new Intl.DateTimeFormat("en-US", { timeZone: zone.timeZone, weekday: "short" }).format(
        date,
      );
    } catch {
      return undefined;
    }
  })();

  const formatted =
    zone.mode === "utc"
      ? formatUtcTimestamp(date)
      : zone.mode === "local"
        ? formatZonedTimestamp(date)
        : formatZonedTimestamp(date, { timeZone: zone.timeZone });

  if (!formatted) {
    return undefined;
  }
  return weekday ? `${weekday} ${formatted}` : formatted;
}

export function formatAgentEnvelope(params: AgentEnvelopeParams): string {
  const channel = sanitizeEnvelopeHeaderPart(params.channel?.trim() || "Channel");
  const parts: string[] = [channel];
  const resolved = normalizeEnvelopeOptions(params.envelope);
  
  // Default includeSystemEnvelope to true (preserve current behavior)
  const includeSystemEnvelope = params.envelope?.includeSystemEnvelope !== false;
  
  let elapsed: string | undefined;
  if (resolved.includeElapsed && params.timestamp && params.previousTimestamp) {
    const currentMs =
      params.timestamp instanceof Date ? params.timestamp.getTime() : params.timestamp;
    const previousMs =
      params.previousTimestamp instanceof Date
        ? params.previousTimestamp.getTime()
        : params.previousTimestamp;
    const elapsedMs = currentMs - previousMs;
    elapsed =
      Number.isFinite(elapsedMs) && elapsedMs >= 0
        ? formatTimeAgo(elapsedMs, { suffix: false })
        : undefined;
  }
  if (params.from?.trim()) {
    const from = sanitizeEnvelopeHeaderPart(params.from.trim());
    parts.push(elapsed ? `${from} +${elapsed}` : from);
  } else if (elapsed) {
    parts.push(`+${elapsed}`);
  }
  if (params.host?.trim()) {
    parts.push(sanitizeEnvelopeHeaderPart(params.host.trim()));
  }
  if (params.ip?.trim()) {
    parts.push(sanitizeEnvelopeHeaderPart(params.ip.trim()));
  }
  const ts = formatTimestamp(params.timestamp, resolved);
  if (ts) {
    parts.push(ts);
  }
  
  // When includeSystemEnvelope is false, return only the body without the bracketed header
  if (!includeSystemEnvelope) {
    return params.body;
  }
  
  const header = `[${parts.join(" ")}]`;
  return `${header} ${params.body}`;
}

export function formatInboundEnvelope(params: {
  channel: string;
  from: string;
  body: string;
  timestamp?: number | Date;
  chatType?: string;
  senderLabel?: string;
  sender?: SenderLabelParams;
  previousTimestamp?: number | Date;
  envelope?: EnvelopeFormatOptions;
}): string {
  const chatType = normalizeChatType(params.chatType);
  const isDirect = !chatType || chatType === "direct";
  const resolvedSenderRaw = params.senderLabel?.trim() || resolveSenderLabel(params.sender ?? {});
  const resolvedSender = resolvedSenderRaw ? sanitizeEnvelopeHeaderPart(resolvedSenderRaw) : "";
  const body = !isDirect && resolvedSender ? `${resolvedSender}: ${params.body}` : params.body;
  return formatAgentEnvelope({
    channel: params.channel,
    from: params.from,
    timestamp: params.timestamp,
    previousTimestamp: params.previousTimestamp,
    envelope: params.envelope,
    body,
  });
}

export function formatInboundFromLabel(params: {
  isGroup: boolean;
  groupLabel?: string;
  groupId?: string;
  directLabel: string;
  directId?: string;
  groupFallback?: string;
}): string {
  // Keep envelope headers compact: group labels include id, DMs only add id when it differs.
  if (params.isGroup) {
    const label = params.groupLabel?.trim() || params.groupFallback || "Group";
    const id = params.groupId?.trim();
    return id ? `${label} id:${id}` : label;
  }

  const directLabel = params.directLabel.trim();
  const directId = params.directId?.trim();
  if (!directId || directId === directLabel) {
    return directLabel;
  }
  return `${directLabel} id:${directId}`;
}

export function formatThreadStarterEnvelope(params: {
  channel: string;
  author?: string;
  timestamp?: number | Date;
  body: string;
  envelope?: EnvelopeFormatOptions;
}): string {
  return formatAgentEnvelope({
    channel: params.channel,
    from: params.author,
    timestamp: params.timestamp,
    envelope: params.envelope,
    body: params.body,
  });
}
