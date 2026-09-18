// 只读日志的显示清理（见 docs/design/08-live-session-modal.md §3）：
// 只把 ANSI 控制序列与不可打印控制字符去掉，不执行任何控制序列、不渲染为 HTML、不解析内容。
// 后端保留原始日志；这里仅影响展示。

// OSC：ESC ] ... BEL 或 ST
const OSC = /\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g;
// CSI：ESC [ 参数 中间字节 终止字节
const CSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
// 两字符 ESC 序列（如 ESC ( B、ESC = 等）
const ESC_SHORT = /\u001b[@-Z\\-_]/g;
// 除 \t(09) / \n(0a) 以外的 C0/C1 控制字符与 DEL
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

export function stripAnsi(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(OSC, '')
    .replace(CSI, '')
    .replace(ESC_SHORT, '')
    .replace(CONTROL, '');
}

// 转义序列可能被底层按 write 切成多块（ESC 与 "[0m" 分属两次输出）。
// 把结尾处尚未完整、无法确定边界的序列暂存，拼到下一块再清理，避免残留 "[0m" 这类碎片。
function splitIncomplete(text: string): { ready: string; pending: string } {
  const esc = text.lastIndexOf('\u001b');
  if (esc === -1) return { ready: text, pending: '' };
  const tail = text.slice(esc);
  const complete =
    /^\u001b\[[0-9;?]*[ -/]*[@-~]/.test(tail) ||
    /^\u001b\][^\u0007]*(?:\u0007|\u001b\\)/.test(tail) ||
    /^\u001b[@-Z\\-_]/.test(tail);
  return complete ? { ready: text, pending: '' } : { ready: text.slice(0, esc), pending: tail };
}

export function createAnsiFilter(): (chunk: string) => string {
  let pending = '';
  return (chunk: string) => {
    const { ready, pending: next } = splitIncomplete(pending + chunk);
    pending = next;
    return stripAnsi(ready);
  };
}
