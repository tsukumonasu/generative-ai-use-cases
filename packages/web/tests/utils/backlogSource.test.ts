import { describe, expect, it } from 'vitest';
import {
  isClaudeCodeLog,
  keepTail,
  maskSecrets,
  parseClaudeCodeLog,
  toMaterial,
} from '../../src/utils/backlogSource';

const line = (entry: Record<string, unknown>) => JSON.stringify(entry);

// A Claude Code session log (~/.claude/projects/<path>/<session>.jsonl)
const LOG = [
  line({ type: 'summary', summary: 'Backlog work' }),
  line({
    type: 'user',
    timestamp: '2026-11-07T01:00:00.000Z',
    message: { role: 'user', content: 'Add the weekly task list' },
  }),
  line({
    type: 'assistant',
    timestamp: '2026-11-07T01:01:00.000Z',
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'secret reasoning' },
        { type: 'text', text: 'Done. Added GET /backlog/tasks.' },
        {
          type: 'tool_use',
          name: 'Bash',
          input: { command: 'git commit -m "feat"', description: 'Commit' },
        },
      ],
    },
  }),
  line({
    type: 'user',
    timestamp: '2026-11-07T01:02:00.000Z',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', content: 'tool output' }],
    },
  }),
  line({
    type: 'user',
    isMeta: true,
    timestamp: '2026-11-07T01:03:00.000Z',
    message: { role: 'user', content: 'meta note' },
  }),
  line({
    type: 'assistant',
    isSidechain: true,
    timestamp: '2026-11-07T01:04:00.000Z',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'subagent' }],
    },
  }),
  line({
    type: 'user',
    timestamp: '2026-11-08T02:00:00.000Z',
    message: {
      role: 'user',
      content: '<system-reminder>injected</system-reminder>',
    },
  }),
  line({
    type: 'user',
    timestamp: '2026-11-08T02:01:00.000Z',
    message: { role: 'user', content: 'Now the activity summary' },
  }),
  'not json',
].join('\n');

describe('backlogSource', () => {
  it('recognizes a Claude Code log', () => {
    expect(isClaudeCodeLog(LOG)).toBe(true);
    expect(isClaudeCodeLog('# Minutes\n- item')).toBe(false);
  });

  it("keeps the user's and Claude's words and the tools Claude used", () => {
    const log = parseClaudeCodeLog(LOG);
    expect(log.text.split('\n')).toEqual([
      '[2026-11-07 10:00] user: Add the weekly task list',
      '[2026-11-07 10:01] assistant: Done. Added GET /backlog/tasks.',
      '(used Bash: Commit)',
      '[2026-11-08 11:01] user: Now the activity summary',
    ]);
    expect(log.messageCount).toBe(3);
    expect(log.firstTimestamp).toBe('2026-11-07T01:00:00.000Z');
    expect(log.lastTimestamp).toBe('2026-11-08T02:01:00.000Z');
    expect(log.text).not.toContain('secret reasoning');
    expect(log.text).not.toContain('tool output');
  });

  it('keeps only the messages after the last comment', () => {
    const log = parseClaudeCodeLog(LOG, '2026-11-07T01:00:00.000Z');
    expect(log.messageCount).toBe(2);
    expect(log.text).not.toContain('Add the weekly task list');
  });

  it('keeps the end of long material', () => {
    expect(keepTail('abcdef', 4)).toEqual({ text: 'cdef', omitted: true });
    expect(keepTail('abc', 4)).toEqual({ text: 'abc', omitted: false });
  });

  it('turns a chat and a file into material for the model', () => {
    const labels = { chat: 'chat', log: 'log', file: 'file' };
    const material = toMaterial(
      {
        chat: {
          chatId: 'c1',
          title: 'Weekly',
          messageCount: 2,
          transcript:
            'Generate one image.\n<conversation>\nuser: hi\nassistant: hello\n</conversation>\nInstruction:',
        },
        file: { name: 'session.jsonl', raw: LOG, isLog: true },
      },
      labels,
      '2026-11-08T00:00:00.000Z'
    );
    expect(material).toEqual([
      { label: 'chat', text: 'user: hi\nassistant: hello', omitted: false },
      expect.objectContaining({
        label: 'log',
        text: '[2026-11-08 11:01] user: Now the activity summary',
      }),
    ]);
  });

  it('skips lines that are not log entries without failing', () => {
    const log = [
      'null',
      '42',
      line({ type: 'user', message: { role: 'user', content: 7 } }),
      line({
        type: 'assistant',
        message: { role: 'assistant', content: [null] },
      }),
      line({ type: 'user', message: { role: 'user', content: 'still here' } }),
    ].join('\n');
    expect(parseClaudeCodeLog(log).text).toBe('user: still here');
  });

  it('masks credentials in tool commands', () => {
    expect(
      maskSecrets('curl -H "Authorization: Bearer abc.def-123" https://x')
    ).toBe('curl -H "Authorization: ***" https://x');
    expect(maskSecrets('API_TOKEN=abcd1234 npm run deploy')).toBe(
      'API_TOKEN=*** npm run deploy'
    );
    expect(maskSecrets('aws configure set aws_secret_access_key wJalr')).toBe(
      'aws configure set aws_secret_access_key wJalr'
    );
    expect(maskSecrets('export KEY=AKIAABCDEFGHIJKLMNOP')).toBe(
      'export KEY=***'
    );
    expect(maskSecrets('git status && npm run lint')).toBe(
      'git status && npm run lint'
    );
  });
});
