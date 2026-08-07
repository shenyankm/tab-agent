import { Component, type ReactNode } from 'react';

// render-error boundary: a crash inside the tree (markdown parser, lazy chunk
// load, dirty data) must not white-screen the UI — show a minimal fallback
// instead of nothing. Shared by the content Shadow UI and popup/options pages.
export class ErrorBoundary extends Component<{ children: ReactNode }, { crashed: boolean }> {
  state = { crashed: false };
  static getDerivedStateFromError() { return { crashed: true }; }
  componentDidCatch(err: unknown) { console.error('[tab-agent] render:', err); }
  render() {
    if (this.state.crashed)
      return <div style={{ padding: 16, fontSize: 13 }}>Tab Agent encountered an error. Reload the page to retry.</div>;
    return this.props.children;
  }
}
