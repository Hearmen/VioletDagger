import { describe, it, expect } from 'vitest';
import {
  ArgError, parseKeyValuePrefix, parseNewRoomArgs, parsePlainText, parsePostArgs, parsePositiveIntArg,
} from '../src/args';

describe('parseKeyValuePrefix', () => {
  it('splits leading key=value tokens from the content', () => {
    const { params, rest } = parseKeyValuePrefix('type=fact target=#3 the body text');
    expect([...params]).toEqual([['type', 'fact'], ['target', '#3']]);
    expect(rest).toBe('the body text');
  });

  it('supports quoted values with escaped quotes', () => {
    const { params, rest } = parseKeyValuePrefix('summary="a \\"quoted\\" one" body');
    expect(params.get('summary')).toBe('a "quoted" one');
    expect(rest).toBe('body');
  });

  it('keeps multi-line content intact', () => {
    expect(parseKeyValuePrefix('type=fact line1\nline2').rest).toBe('line1\nline2');
  });

  it('rejects duplicates and unclosed quotes', () => {
    expect(() => parseKeyValuePrefix('type=fact type=chain x')).toThrow(ArgError);
    expect(() => parseKeyValuePrefix('summary="oops x')).toThrow(/引号未闭合/);
  });
});

describe('parsePostArgs', () => {
  it('maps every key to postHumanMessage params', () => {
    expect(parsePostArgs('type=verify target=4 refs=1,2 verdict=false to=codex-1 summary="s s" content here')).toEqual({
      content: 'content here',
      type: 'verify',
      targetMessageId: 4,
      referencedMessageIds: [1, 2],
      verifyVerdict: false,
      targetAgentId: 'codex-1',
      summary: 's s',
    });
    expect(parsePostArgs('type=chain closes=true resolution=RESOLVED x')).toMatchObject({
      closesQuestion: true, chainResolution: 'RESOLVED',
    });
  });

  it('rejects unknown keys, bad values and empty content', () => {
    expect(() => parsePostArgs('foo=1 x')).toThrow(/未知参数/);
    expect(() => parsePostArgs('type=nope x')).toThrow(/type/);
    expect(() => parsePostArgs('target=0 x')).toThrow(/target/);
    expect(() => parsePostArgs('refs=1,,2 x')).toThrow(/refs/);
    expect(() => parsePostArgs('verdict=yes x')).toThrow(/verdict/);
    expect(() => parsePostArgs('resolution=DONE x')).toThrow(/resolution/);
    expect(() => parsePostArgs('type=fact   ')).toThrow(/为空/);
  });
});

describe('parsePlainText', () => {
  it('treats a leading @agent as the directed target', () => {
    expect(parsePlainText('@claude look at #3')).toEqual({ content: 'look at #3', targetAgentId: 'claude' });
    expect(parsePlainText('hello @claude')).toEqual({ content: 'hello @claude' });
    expect(() => parsePlainText('@claude   ')).toThrow(/为空/);
  });
});

describe('parseNewRoomArgs', () => {
  it('builds the create-room body, allowing repeated agents', () => {
    expect(parseNewRoomArgs('name="bug hunt" agents=codex,codex,claude mode=parallel max=30 workdir=~/x')).toEqual({
      name: 'bug hunt', agentIds: ['codex', 'codex', 'claude'], schedulingMode: 'parallel', maxSessions: 30, workdir: '~/x',
    });
  });

  it('requires name, agents and mode and rejects trailing text', () => {
    expect(() => parseNewRoomArgs('name=a agents=codex')).toThrow(/mode/);
    expect(() => parseNewRoomArgs('name=a agents=codex mode=parallel extra')).toThrow(/无法解析/);
    expect(() => parseNewRoomArgs('name=a agents=codex, mode=parallel')).toThrow(/agents/);
    expect(() => parseNewRoomArgs('name=a agents=codex mode=parallel max=x')).toThrow(/max/);
  });
});

describe('parsePositiveIntArg', () => {
  it('accepts an optional # prefix', () => {
    expect(parsePositiveIntArg('roomId', ' #12 ')).toBe(12);
    expect(() => parsePositiveIntArg('roomId', '')).toThrow(/roomId/);
  });
});
