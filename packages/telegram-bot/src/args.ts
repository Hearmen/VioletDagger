import { MESSAGE_TYPES, type CreateRoomBody, type MessageType, type PostHumanMessageParams } from './types';

// 命令参数语法（11-telegram-bot.md §7.1、§7.2）：正文前连续的 key=value token 为参数，
// 值含空格时用双引号包住，\" 转义引号；第一个不符合该形式的 token 起为正文。

export class ArgError extends Error {}

export function parseKeyValuePrefix(input: string): { params: Map<string, string>; rest: string } {
  const params = new Map<string, string>();
  let pos = 0;
  for (;;) {
    while (pos < input.length && /\s/.test(input[pos])) pos += 1;
    const match = /^([A-Za-z]+)=/.exec(input.slice(pos));
    if (!match) break;
    const key = match[1];
    let i = pos + match[0].length;
    let value = '';
    if (input[i] === '"') {
      i += 1;
      let closed = false;
      while (i < input.length) {
        const ch = input[i];
        if (ch === '\\' && input[i + 1] === '"') {
          value += '"';
          i += 2;
        } else if (ch === '"') {
          closed = true;
          i += 1;
          break;
        } else {
          value += ch;
          i += 1;
        }
      }
      if (!closed) throw new ArgError(`参数 ${key} 的引号未闭合`);
      if (i < input.length && !/\s/.test(input[i])) throw new ArgError(`参数 ${key} 的引号后必须是空白`);
    } else {
      while (i < input.length && !/\s/.test(input[i])) {
        value += input[i];
        i += 1;
      }
    }
    if (params.has(key)) throw new ArgError(`重复参数：${key}`);
    params.set(key, value);
    pos = i;
  }
  return { params, rest: input.slice(pos) };
}

function positiveInt(key: string, value: string): number {
  if (!/^\d+$/.test(value) || Number(value) <= 0) throw new ArgError(`${key} 须为正整数`);
  return Number(value);
}

function bool(key: string, value: string): boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new ArgError(`${key} 须为 true 或 false`);
}

// 普通文本：开头的 @<agentId>（后接空白）作为定向 agent，其余为正文。
export function parsePlainText(text: string): PostHumanMessageParams {
  const match = /^@(\S+)\s+([\s\S]*)$/.exec(text);
  const params: PostHumanMessageParams = match
    ? { content: match[2], targetAgentId: match[1] }
    : { content: text };
  if (params.content.trim() === '') throw new ArgError('消息内容为空');
  return params;
}

export function parsePostArgs(input: string): PostHumanMessageParams {
  const { params, rest } = parseKeyValuePrefix(input);
  const result: PostHumanMessageParams = { content: rest };
  for (const [key, value] of params) {
    switch (key) {
      case 'type':
        if (!(MESSAGE_TYPES as readonly string[]).includes(value)) {
          throw new ArgError(`type 须为 ${MESSAGE_TYPES.join(' / ')} 之一`);
        }
        result.type = value as MessageType;
        break;
      case 'target':
        result.targetMessageId = positiveInt('target', value.replace(/^#/, ''));
        break;
      case 'refs':
        if (!/^\d+(,\d+)*$/.test(value)) throw new ArgError('refs 须为逗号分隔的正整数');
        result.referencedMessageIds = value.split(',').map((v) => positiveInt('refs', v));
        break;
      case 'verdict':
        result.verifyVerdict = bool('verdict', value);
        break;
      case 'closes':
        result.closesQuestion = bool('closes', value);
        break;
      case 'resolution':
        if (value !== 'RESOLVED' && value !== 'UNRESOLVED') throw new ArgError('resolution 须为 RESOLVED 或 UNRESOLVED');
        result.chainResolution = value;
        break;
      case 'summary':
        result.summary = value;
        break;
      case 'to':
        if (value === '') throw new ArgError('to 不能为空');
        result.targetAgentId = value;
        break;
      default:
        throw new ArgError(`未知参数：${key}`);
    }
  }
  if (result.content.trim() === '') throw new ArgError('消息内容为空');
  return result;
}

export function parseNewRoomArgs(input: string): CreateRoomBody {
  const { params, rest } = parseKeyValuePrefix(input);
  if (rest.trim() !== '') throw new ArgError(`无法解析的参数：${rest.trim()}`);
  const body: Partial<CreateRoomBody> = {};
  for (const [key, value] of params) {
    switch (key) {
      case 'name':
        body.name = value;
        break;
      case 'agents': {
        const agents = value.split(',').map((a) => a.trim());
        if (agents.some((a) => a === '')) throw new ArgError('agents 须为逗号分隔的 agent key');
        body.agentIds = agents;
        break;
      }
      case 'mode':
        body.schedulingMode = value;
        break;
      case 'max':
        body.maxSessions = positiveInt('max', value);
        break;
      case 'workdir':
        body.workdir = value;
        break;
      default:
        throw new ArgError(`未知参数：${key}`);
    }
  }
  for (const key of ['name', 'agents', 'mode'] as const) {
    if (!params.has(key) || params.get(key) === '') throw new ArgError(`缺少参数：${key}`);
  }
  return body as CreateRoomBody;
}

export function parsePositiveIntArg(name: string, input: string): number {
  const value = input.trim().replace(/^#/, '');
  if (!/^\d+$/.test(value) || Number(value) <= 0) throw new ArgError(`${name} 须为正整数`);
  return Number(value);
}
