import type { ReactNode } from 'react';

export function Panel(props: {
  title: string;
  count?: number;
  actions?: ReactNode;
  className?: string;
  bodyClassName?: string;
  bodyRef?: React.Ref<HTMLDivElement>;
  children: ReactNode;
}) {
  return (
    <section className={`panel ${props.className ?? ''}`}>
      <header className="panel__head">
        <h2 className="panel__title">{props.title}</h2>
        {props.count != null && <span className="panel__count mono">{props.count}</span>}
        {props.actions && <div className="panel__actions">{props.actions}</div>}
      </header>
      <div ref={props.bodyRef} className={`panel__body ${props.bodyClassName ?? ''}`}>
        {props.children}
      </div>
    </section>
  );
}
