import type { ReactNode } from 'react';
import { TopBar } from './Wordmark';

export function StatusScreen({
  tone = 'neutral',
  title,
  children,
  action,
  busy,
}: {
  tone?: 'neutral' | 'warn' | 'good';
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  busy?: boolean;
}) {
  return (
    <div className="page">
      <TopBar />
      <main className={`status status-${tone}`}>
        {busy && <div className="pulse" aria-hidden="true" />}
        <h1 className="status-title">{title}</h1>
        {children && <div className="status-body">{children}</div>}
        {action && <div className="status-action">{action}</div>}
      </main>
    </div>
  );
}
