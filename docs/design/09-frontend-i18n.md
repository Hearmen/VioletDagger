# Web 前端界面语言（中文 / English）

Web 前端提供中文与英文两套界面文案，用户通过页面顶栏的一个按钮在两者之间切换。本文档定义语言模块的数据结构、对组件暴露的接口、切换入口、持久化、翻译范围与组件改造约定。前端整体设计见 `07-frontend.md`。

## 1. 目标与范围

- 支持两种界面语言：`zh`（中文，默认）与 `en`（英文）。
- 切换即时生效：不刷新页面、不断开 WebSocket、不丢失任何面板状态（滚动位置、展开/折叠、输入框草稿、打开的 modal、面板尺寸、事件树当前标签页）。
- 选择在浏览器内持久化，下次打开沿用。
- **不新增运行时依赖**（与 `07-frontend.md` 开头的约束一致）：不引入 i18next / react-intl 等库，用 React Context + 静态字典实现。
- 后端接口、WebSocket 协议、存储均不变。

### 1.1 界面文案与中文字典的取值

**界面文案**指前端自己写死或自己派生、展示给用户的文字，无论当前写的是中文还是英文。所有界面文案都进入字典，经 `t()` 输出。

**中文字典的值与当前界面上显示的文字逐字一致**，包括当前已经是英文的部分（如顶栏按钮 `Pause`、`Resume`、`Confirm Completion`、`Delete Room`，`Loading…`，事件树标签页 `Session`，`aria-label="Close"` 等）。因此默认语言下的界面与现在完全相同；英文字典给出这些文案的英文版本（已是英文的保持原文）。

界面文案包括：

- 按钮、标题、面板名、标签页名、占位符、空状态、提示条、确认弹窗、`window.confirm` / `window.prompt` 的提示文字、表单标签与校验提示、`title` / `aria-label` 等无障碍文案。
- 前端派生的展示文案：作者标识（`人类`/`系统`）、头像首字、相对时间、用量行（`输入`/`输出`/`缓存读`/`缓存写`）、`verify` 结果文案（`成立/不成立`、`通过/驳回`）、`propose_completion` 的类型徽标文案、session 结束/开始标记中的`结束`/`开始`、状态迁移条目中的`类型`/`状态`、记忆分组名、Composer 的发送要求提示、session 生命周期事件文案、session 结束原因文案、前端自己生成的错误与提示（如日志连接断开提示、`unknown error`）。

### 1.2 不翻译的内容

| 内容 | 原因 |
|---|---|
| 消息正文、agent 产出、`summary` | 用户与 agent 的数据 |
| 服务端返回的 `error.message`（RPC/REST 失败的 toast 与内联错误、`loadError`） | 来自后端，前端原样展示 |
| `authorId === 'system'` 消息的正文 | 服务端写入的数据 |
| session 日志内容 | 原始 CLI 输出 |
| 协议标识符：`MessageType` 值（`fact`、`hypothesis`…；`propose_completion` 的徽标文案除外，见 1.1）、消息状态值（`OPEN`、`CANDIDATE`、`VERIFIED`…）、状态迁移中的 type/status 值、`agentId`、`sessionId`、`#N`、session outcome 值（`stopping`、`completed`、`passed`、`error`、`terminated`）及其展示文案 `done` | 两种语言下都以英文标识符展示。session outcome 标签表中唯一的非标识符项 `running: '运行中'` 属于界面文案，进字典（英文 `running`） |
| 单位缩写 `tok`（`formatTokens`）、费用 `$` | 两种语言通用 |
| 品牌名 `VioletDagger`、`<title>` | 品牌名不翻译 |
| 代码注释、CSS 注释 | 不属于界面 |

## 2. 数据结构

### 2.1 Locale

```typescript
// src/i18n/types.ts
export type Locale = 'zh' | 'en';
export const LOCALES: readonly Locale[] = ['zh', 'en'];
export const DEFAULT_LOCALE: Locale = 'zh';
export const LOCALE_STORAGE_KEY = 'vd.locale';   // 与 vd.dashboard.layout、vd.eventTree.tab 同一命名前缀
```

### 2.2 字典

每种语言一个字典模块，扁平的 key → 文案映射。key 用 `区域.含义` 的点分命名，区域取值：`common`、`header`、`roomList`、`agentRail`、`messages`、`composer`、`memory`、`eventTree`、`session`、`log`、`format`。

```typescript
// src/i18n/zh.ts —— 中文字典是 key 的唯一来源
export const zh = {
  'common.close': 'Close',
  'common.loading': 'Loading…',
  'common.unknownError': 'unknown error',
  'header.pause': 'Pause',
  'header.readonly': '已结束 · 只读',
  'header.disconnected': '连接已断开，正在重连…',
  'header.disabledAgents': '（{count} 个 agent 已停用派发）',
  'format.minutesAgo': '{n} 分钟前',
  // …
} as const;

export type MessageKey = keyof typeof zh;
```

```typescript
// src/i18n/en.ts —— 类型约束保证 key 与中文字典完全一致：缺 key 或多 key 都编译失败
import type { MessageKey } from './zh';
export const en: Record<MessageKey, string> = {
  'common.close': 'Close',
  'common.loading': 'Loading…',
  'common.unknownError': 'unknown error',
  'header.pause': 'Pause',
  'header.readonly': 'Ended · read-only',
  'header.disconnected': 'Connection lost, reconnecting…',
  'header.disabledAgents': ' (agents with dispatch disabled: {count})',
  'format.minutesAgo': '{n} min ago',
  // …
};
```

- **插值**：文案中的 `{name}` 占位符由 `t(key, { name: value })` 替换，值按 `String(value)` 转换。未提供的占位符原样保留，便于测试发现遗漏。
- **数量与复数**：不实现复数规则。英文文案一律写成与数量无关的形式（如 `agents with dispatch disabled: {count}`、`{n} min ago`），不出现 `1 agents` 这类错误。
- **数字格式**：数字的千分位格式由 `formatNumber(n, locale)` 统一输出，内部为 `n.toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US')`，替换现有的无参 `toLocaleString()`。时间仍统一展示为 `HH:mm:ss`（`07-frontend.md` §2），与语言无关。

### 2.3 翻译函数

```typescript
// src/i18n/translate.ts
export type TParams = Record<string, string | number>;
export type TFunction = (key: MessageKey, params?: TParams) => string;
export function interpolate(template: string, params?: TParams): string;
export function createT(locale: Locale): TFunction;
```

`interpolate` 按 2.2 规则替换占位符。`createT` 是纯函数，查对应语言字典后交给 `interpolate`。由于 2.2 的类型约束，任何 `MessageKey` 在两种字典中都有值，不需要运行时回退。

### 2.4 状态中保存的文案

组件或 hook 状态中**不保存已翻译的字符串**，而是保存可延迟翻译的描述，渲染时再调用 `t`，这样切换语言后已显示的提示也会立即变为新语言：

```typescript
// src/i18n/types.ts
export type LocalizedText =
  | { kind: 'key'; key: MessageKey; params?: TParams }   // 前端自己生成的文案
  | { kind: 'raw'; text: string };                         // 服务端 error.message 等原样展示的文字
export function renderText(text: LocalizedText, t: TFunction): string;
// 捕获到的异常转为 LocalizedText：Error 的 message 原样保存为 raw，其余情况为 common.unknownError。
export function errorText(err: unknown): LocalizedText;
```

适用位置：toast 栈的条目、`loadError`、`useSessionLog` 返回的 `error`、表单内联错误。`err instanceof Error ? err.message : 'unknown error'` 改为 `errorText(err)`。`useSessionLog` 的 `error` 只来自日志 WS 的 `error` 帧（服务端消息），因此总是 `{ kind: 'raw' }`。

## 3. 接口：LocaleProvider 与 useI18n

这是语言模块对所有组件暴露的唯一接口。

```typescript
// src/i18n/LocaleProvider.tsx
export interface I18nContextValue {
  locale: Locale;
  setLocale(next: Locale): void;
  toggleLocale(): void;   // zh ↔ en
  t: TFunction;
}
export function LocaleProvider(props: { children: ReactNode }): JSX.Element;
export function useI18n(): I18nContextValue;
```

- `LocaleProvider` 包在 `App` 最外层（`BrowserRouter` 外），两个页面共享同一状态。
- 初始值：读 `localStorage[LOCALE_STORAGE_KEY]`，值属于 `LOCALES` 时采用，否则（不存在、非法值、读取抛异常）使用 `DEFAULT_LOCALE`。不根据浏览器语言自动选择。
- `setLocale` 更新状态并写回 `localStorage`；写入抛异常（隐私模式等）时忽略，本次会话内切换仍然生效。读写都包 `try/catch`，与 `useDashboardLayout` 一致。
- 每次 `locale` 变化时设置 `document.documentElement.lang`（`zh` → `zh-CN`，`en` → `en`）。`index.html` 中的初始值由 `lang="en"` 改为 `lang="zh-CN"`，与默认语言一致，避免首屏渲染前语言属性错误。
- `t` 用 `useMemo` 按 `locale` 缓存，`locale` 不变时引用稳定。
- 在 Provider 外调用 `useI18n()` 返回默认中文上下文（`setLocale` / `toggleLocale` 为空操作），使单独渲染组件的测试无需包 Provider 也能得到当前的中文文案。

## 4. 切换按钮 LocaleToggle

```typescript
// src/components/LocaleToggle.tsx
export function LocaleToggle(): JSX.Element;
```

- 一个小按钮，文字显示**切换目标**语言：当前为中文时显示 `EN`，当前为英文时显示 `中`。点击调用 `toggleLocale()`。
- `aria-label` / `title` 走字典：中文"切换到英文"，英文 "Switch to Chinese"。
- 样式：沿用顶栏次要按钮（描边、`--text-muted` 文字、hover 时 `--border-strong`），文字用 `--mono`，固定最小宽度，两种文字切换时按钮不跳动。不新增设计令牌。
- 放置位置（所有页面状态下都可见）：
  - `RoomHeader`（`07-frontend.md` §4）：右侧控制区的最右端，在 pause/resume/confirm/delete 之后；`completed` 房间同样显示。
  - `app-bar`（`RoomListPage`，以及 `RoomDashboardPage` 在房间/状态尚未加载完成或加载失败时显示的 `app-bar`）：品牌名右侧、`app-bar` 右端。
- 切换只是 React 状态变化，所有文案在同一次渲染中更新；组件不重新挂载，`LocaleProvider` 不以 `key={locale}` 等方式强制重挂，第 1 节的"不丢失状态"由此满足。

## 5. 组件与工具函数改造约定

### 5.1 组件

组件内一律通过 `const { t, locale } = useI18n()` 取文案，JSX 文本与属性中不再出现界面文案字面量（1.2 列出的标识符除外）。

### 5.2 utils/format.ts

返回界面文案的函数改为接收 `t`（需要数字格式时再接收 `locale`），保持纯函数、不读 Context：

| 函数 | 新签名 | 说明 |
|---|---|---|
| `authorLabel` | `authorLabel(authorId, t)` | `human`/`system` 查字典，其余原样返回 |
| `authorInitial` | `authorInitial(authorId, t)` | 中文 `人`/`系`，英文 `H`/`S` |
| `formatRelative` | `formatRelative(iso, t)` | `刚刚`/`N 分钟前`… 查字典 |
| `typeLabel` | `typeLabel(type, t)` | 只有 `propose_completion` 查字典（中文"提议完成"，英文 "propose completion"），其余原样返回 type 值 |
| `formatUsageParts`（新增） | `formatUsageParts(usage, t, locale): string[]` | 收拢 `RoomHeader` 与 `AgentRail` 中重复的 `输入/输出/缓存读/缓存写` 片段构造，规则保持现状（缓存项 `> 0` 才出现） |

`SessionDetailModal` 的用量行（`输入 N · 输出 N`，判断条件为 `!= null`）规则与上表不同，保持其自身规则，仅把文字改为 `t('session.inputTokens', …)` 等、数字改用 `formatNumber`。

不含界面文案的函数不变：`colorForAgent`、`sessionTagLabel`、`sessionDurationSuffix`、`sessionUsageSuffix`、`formatTokens`、`formatCostUsd`、`truncate`、`isTriggeringNewMessageType`。

### 5.3 常量表

写死在模块级常量表中的界面文案改为存 `MessageKey`，渲染时 `t(key)`：

| 位置 | 改造 |
|---|---|
| `SessionDetailModal` / `LiveSessionModal` 的 `OUTCOME_LABELS` | 两份合并为 `utils/format.ts` 中一份 `outcomeLabel(outcome, t)`：`running` 查字典（`session.outcomeRunning`），其余原样返回 outcome 值 |
| `SessionDetailModal` 的 `LIFECYCLE_LABELS` | 值改为 `MessageKey`（`session.lifecycle.*`） |
| `MemoryPanel` 的 `GROUPS` | `[groupKey, MessageKey]`；中文字典值为当前分组名（如 `open questions`、`完成提议`），英文对应 `open questions`、`completion proposals` |
| `MemoryPanel` 的 `END_REASON_LABELS` | 值改为 `MessageKey` |
| `Composer` 的 `SEND_REQUIREMENTS` | 值改为 `MessageKey`（`composer.requirement.*`）；英文字典给出完整英文提示 |
| 其余组件内的同类表 | 同上规则 |

### 5.4 带拼接的派生文案

- `endMarkerLabel(meta, agentId, seq, t)`：插入的`结束`改为 `t('eventTree.end')`；开始标记的`开始`同样走字典（`eventTree.start`）。
- 事件树状态迁移条目中的 `类型 X → Y` / `状态 X → Y` 改为 `t('eventTree.typeChange', { from, to })` / `t('eventTree.statusChange', { from, to })`；X、Y 是标识符，不翻译。`MemoryPanel` 的 `transitionText` 只拼接标识符，不变。
- `RoomHeader` 的 `sessions` 计数后缀、`window.prompt('additionalSessions (required)')`、各确认弹窗文字一律走字典。
- `RoomListPage` 中未实现项的 `title="v1 未实现"` 走字典（`roomList.notImplemented`，英文 `Not implemented in v1`）。

## 6. 文件落点

```
src/i18n/
├── types.ts            # Locale、LOCALES、DEFAULT_LOCALE、LOCALE_STORAGE_KEY、LocalizedText、renderText、errorText
├── zh.ts               # 中文字典（key 的唯一来源）+ MessageKey
├── en.ts               # 英文字典
├── translate.ts        # createT、interpolate、TFunction
└── LocaleProvider.tsx  # LocaleProvider、useI18n
src/components/LocaleToggle.tsx
index.html              # lang="zh-CN"
```

## 7. 测试

- `translate`：插值替换；缺参数时占位符原样保留；两种语言返回对应文案。
- `LocaleProvider`：默认 `zh`；`localStorage` 中为 `en` 时初始为英文；非法值/读取抛异常回退 `zh`；`toggleLocale` 后写回 `localStorage`、`document.documentElement.lang` 更新；写入抛异常时切换仍生效。
- `LocaleToggle`：中文界面显示 `EN`，点击后文案变为英文、按钮显示 `中`。
- 集成：在 `RoomDashboardPage` 中切换语言后，Composer 输入框草稿、已打开的 modal、事件树当前标签页保持不变，顶栏/面板标题变为英文；已显示的前端生成 toast 随之变为英文，服务端 `error.message` 保持原文。
- 字典完整性：TypeScript 类型保证两份字典 key 一致（2.2）；另加一条测试断言两份字典的 key 集合相同、英文字典中不含中文字符；唯一例外是 `common.localeToggleTarget`，它在英文界面下的值 `中` 本身就是指向中文的切换目标。
- 测试隔离：`test/setup.ts` 在每个用例后清空 `localStorage[LOCALE_STORAGE_KEY]` 并把 `document.documentElement.lang` 复位，防止切换语言的用例影响后续用例。
- 现有测试的调整：
  - `test/utils/format.test.ts` 按 5.2 的新签名改为传入 `createT('zh')`，断言的中文文案不变；新增各函数在 `createT('en')` 下的断言。
  - 其余组件测试默认运行在中文下，由于中文字典值与现有界面文字逐字一致（1.1），断言保持有效。

## 8. 对 07-frontend.md 的相应修改

- 开头"不新增运行时依赖"段落后增加一句：界面语言（中文/English）见 `09-frontend-i18n.md`。
- §4 RoomHeader：右侧控制区末尾增加语言切换按钮 `LocaleToggle`（见 `09-frontend-i18n.md` §4）；并注明本节列出的按钮与提示文字为中文界面下的文案。
- §11 RoomListPage：`app-bar` 右端增加 `LocaleToggle`。
- §15 错误、加载与连接状态：toast 与错误条的文字按 `09-frontend-i18n.md` §2.4 保存为 `LocalizedText`。
- §16 组件与文件落点：加入 `src/i18n/` 目录与 `components/LocaleToggle.tsx`，`utils/format.ts` 说明补充 `formatUsageParts`、`outcomeLabel`、`formatNumber`。
- §14 对外依赖：不变（语言模块不依赖后端）。
