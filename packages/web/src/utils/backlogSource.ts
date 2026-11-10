// Source material for Backlog drafts (pages/BacklogPage.tsx):
// text files and Claude Code conversation logs (~/.claude/projects/<path>/
// <session>.jsonl), read in the browser from a file the user picks.

import { ImageChatContext } from './chatContext';
import { BacklogSourceMaterial } from '../prompts/backlogDraft';

// Longest source text sent to the model; longer material keeps its end
export const MAX_SOURCE_LENGTH = 120_000;
// Longest single tool input shown from a Claude Code log
const MAX_TOOL_INPUT_LENGTH = 300;

export type BacklogSourceText = {
  text: string;
  // Earlier material was dropped to fit MAX_SOURCE_LENGTH
  omitted: boolean;
};

/** Keep the end of `text` within `maxLength` (the latest part matters most). */
export const keepTail = (
  text: string,
  maxLength: number = MAX_SOURCE_LENGTH
): BacklogSourceText =>
  text.length <= maxLength
    ? { text, omitted: false }
    : { text: text.slice(-maxLength), omitted: true };

type LogBlock = {
  type?: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
};
type LogEntry = {
  type?: string;
  timestamp?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  message?: { role?: string; content?: string | LogBlock[] };
};

export type ClaudeCodeLog = BacklogSourceText & {
  // Messages kept after the `since` filter
  messageCount: number;
  // ISO 8601 of the first and last kept messages
  firstTimestamp?: string;
  lastTimestamp?: string;
};

const timeFormat = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Tokyo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

// Notes the tools add to the user's turn, not the user's own words
const isInjected = (text: string) =>
  /^<(system-reminder|command-|local-command|bash-|user-memory)/.test(
    text.trim()
  );

// Commands in a log can carry credentials (curl -H "Authorization: ...",
// TOKEN=... cmd). The summary goes to the drafting model and may end up in a
// Backlog comment, so the obvious ones are masked first.
const SECRET_PATTERNS: RegExp[] = [
  /\b(authorization|x-api-key|api-key|cookie)(["']?\s*[:=]\s*)(?:(?:bearer|basic)\s+)?[^\s"']+/gi,
  /\b([A-Za-z0-9_]*(?:token|secret|password|passwd|api_?key|access_?key)[A-Za-z0-9_]*)(\s*[:=]\s*)["']?[^\s"'&]+/gi,
];
const SECRET_VALUES =
  /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|A[KS]IA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+)/g;

export const maskSecrets = (text: string): string =>
  SECRET_PATTERNS.reduce(
    (masked, pattern) => masked.replace(pattern, '$1$2***'),
    text
  ).replace(SECRET_VALUES, '***');

const toolSummary = (block: LogBlock): string => {
  const input = block.input ?? {};
  const detail = ['description', 'command', 'file_path', 'pattern', 'url']
    .map((key) => input[key])
    .find((value): value is string => typeof value === 'string');
  const text = detail ? `: ${maskSecrets(detail.replace(/\s+/g, ' '))}` : '';
  return `(used ${block.name ?? 'a tool'}${text.slice(0, MAX_TOOL_INPUT_LENGTH)})`;
};

/** Whether the text looks like a Claude Code conversation log (JSON Lines). */
export const isClaudeCodeLog = (text: string): boolean => {
  const firstLine = text.split('\n').find((line) => line.trim());
  if (!firstLine) {
    return false;
  }
  try {
    const entry = JSON.parse(firstLine) as LogEntry;
    return typeof entry === 'object' && entry !== null && 'type' in entry;
  } catch {
    return false;
  }
};

/**
 * The user's and Claude's words (and which tools Claude used) from a Claude
 * Code log, one line per message, oldest first. With `since` (ISO 8601),
 * only messages after it are kept, e.g. after the last progress comment.
 */
export const parseClaudeCodeLog = (
  jsonl: string,
  since?: string
): ClaudeCodeLog => {
  const sinceTime = since ? Date.parse(since) : undefined;
  const lines: string[] = [];
  let firstTimestamp: string | undefined;
  let lastTimestamp: string | undefined;

  for (const raw of jsonl.split('\n')) {
    if (!raw.trim()) continue;
    let entry: LogEntry;
    try {
      entry = JSON.parse(raw) as LogEntry;
    } catch {
      continue;
    }
    if (
      typeof entry !== 'object' ||
      entry === null ||
      (entry.type !== 'user' && entry.type !== 'assistant') ||
      entry.isMeta ||
      entry.isSidechain ||
      !entry.message
    ) {
      continue;
    }
    const time = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
    if (sinceTime !== undefined && !(time > sinceTime)) {
      continue;
    }

    const content = entry.message.content;
    const blocks: LogBlock[] =
      typeof content === 'string'
        ? [{ type: 'text', text: content }]
        : Array.isArray(content)
          ? content
          : [];
    const parts = blocks.flatMap((block) => {
      if (typeof block !== 'object' || block === null) {
        return [];
      }
      if (block.type === 'text' && block.text && !isInjected(block.text)) {
        return [block.text.trim()];
      }
      if (block.type === 'tool_use' && entry.type === 'assistant') {
        return [toolSummary(block)];
      }
      // Tool results and thinking are left out
      return [];
    });
    if (parts.length === 0) continue;

    const stamp = Number.isNaN(time) ? '' : `[${timeFormat.format(time)}] `;
    lines.push(`${stamp}${entry.type}: ${parts.join('\n')}`);
    if (entry.timestamp) {
      firstTimestamp ??= entry.timestamp;
      lastTimestamp = entry.timestamp;
    }
  }

  return {
    ...keepTail(lines.join('\n')),
    messageCount: lines.length,
    firstTimestamp,
    lastTimestamp,
  };
};

// The chat transcript from ModalDialogSelectChat is framed for an image model
// (an order before <conversation> and an instruction after it). The draft
// model gets only the conversation itself.
const extractConversation = (framedTranscript: string): string => {
  const open = '<conversation>';
  const start = framedTranscript.indexOf(open);
  const end = framedTranscript.lastIndexOf('</conversation>');
  if (start >= 0 && end > start) {
    return framedTranscript.slice(start + open.length, end).trim();
  }
  return framedTranscript;
};

export type BacklogSources = {
  chat?: ImageChatContext;
  file?: { name: string; raw: string; isLog: boolean };
};

/**
 * The material for the model. A Claude Code log keeps only the messages
 * after `logSince` (ISO 8601) when it is given.
 */
export const toMaterial = (
  sources: BacklogSources,
  labels: { chat: string; log: string; file: string },
  logSince?: string
): BacklogSourceMaterial[] => {
  const material: BacklogSourceMaterial[] = [];
  if (sources.chat) {
    material.push({
      label: labels.chat,
      ...keepTail(extractConversation(sources.chat.transcript)),
    });
  }
  if (sources.file) {
    material.push(
      sources.file.isLog
        ? {
            label: labels.log,
            ...parseClaudeCodeLog(sources.file.raw, logSince),
          }
        : { label: labels.file, ...keepTail(sources.file.raw) }
    );
  }
  return material.filter((m) => m.text.trim().length > 0);
};

// What each kind of material is, as told to the model
export const MATERIAL_LABELS = {
  chat: 'a conversation between the user and an AI assistant',
  log: 'a Claude Code conversation log',
  file: 'a file the user attached',
};
