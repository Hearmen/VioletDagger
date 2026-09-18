import { useEffect, useRef, useState } from 'react';
import type { LogChunk } from '../api/types';
import type { SessionLog } from '../hooks/useSessionLog';
import { createAnsiFilter } from '../utils/ansi';

const MAX_WINDOW_BYTES = 1024 * 1024; // 浏览器日志窗口上限 1 MiB，按完整事件裁剪（08 §5）

// 纯文本只读日志：stdout/stderr 分色、自动跟随、回到底部、复制、内存窗口。
// 不解析 ANSI 控制序列为 HTML，不提供任何输入能力（08 §3）。
export function SessionLogView(props: {
  log: SessionLog;
  resetKey: string;
  className?: string;
}) {
  const { log, resetKey } = props;
  const [chunks, setChunks] = useState<LogChunk[]>([]);
  const [follow, setFollow] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);
  const { onData } = log;

  useEffect(() => {
    setChunks([]);
    setFollow(true);
    // ANSI/控制序列只做显示清理（08 §3），状态跨 chunk 保持以处理被切开的转义序列。
    const clean = createAnsiFilter();
    const off = onData((chunk) => {
      const text = clean(chunk.text);
      if (text === '') return;
      setChunks((prev) => {
        const next = [...prev, { ...chunk, text }];
        let bytes = 0;
        for (const item of next) bytes += item.text.length;
        // 按完整事件从队首裁剪，避免持续运行无限增长。
        let start = 0;
        while (bytes > MAX_WINDOW_BYTES && start < next.length - 1) {
          bytes -= next[start].text.length;
          start += 1;
        }
        return start > 0 ? next.slice(start) : next;
      });
    });
    return off;
  }, [onData, resetKey]);

  useEffect(() => {
    const container = containerRef.current;
    if (container && follow) container.scrollTop = container.scrollHeight;
  }, [chunks, follow]);

  const handleScroll = () => {
    const container = containerRef.current;
    if (!container) return;
    const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight <= 80;
    setFollow(nearBottom);
  };

  const text = chunks.map((chunk) => chunk.text).join('');

  return (
    <div className={`session-log ${props.className ?? ''}`}>
      {log.truncated && (
        <p className="session-log__notice">仅显示部分日志，完整记录请查看详情</p>
      )}
      {log.error && <p role="alert" className="session-log__notice">{log.error}</p>}
      {log.connectionState === 'disconnected' && !log.ended && (
        <p role="alert" className="session-log__notice">日志连接已断开，重新打开可获取最近快照</p>
      )}
      <div className="session-log__toolbar">
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(text).catch(() => {});
          }}
        >
          复制
        </button>
        {!follow && (
          <button type="button" onClick={() => setFollow(true)}>回到底部</button>
        )}
      </div>
      <div
        ref={containerRef}
        className="session-log__body"
        onScroll={handleScroll}
        aria-label="session log"
      >
        {chunks.length === 0 && <span className="placeholder">（暂无日志）</span>}
        {chunks.map((chunk) => (
          <span key={chunk.offset} className={`log-chunk log-chunk--${chunk.stream}`}>
            {chunk.text}
          </span>
        ))}
      </div>
    </div>
  );
}
