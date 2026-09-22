import { Component, type ReactNode } from 'react';

type State = { hasError: boolean; message: string };

export default class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { hasError: false, message: '' };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, message: error.message };
  }

  componentDidCatch(error: Error) {
    console.error('App crash:', error);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ minHeight: '100vh', background: '#020617', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'system-ui, sans-serif' }}>
          <div style={{ textAlign: 'center', maxWidth: 420, padding: 32 }}>
            <h2 style={{ color: '#f87171', fontSize: 20, fontWeight: 700, marginBottom: 12 }}>Erro ao carregar a aplicação</h2>
            <p style={{ color: '#94a3b8', fontSize: 14, marginBottom: 8 }}>{this.state.message}</p>
            <button
              onClick={() => window.location.reload()}
              style={{ marginTop: 16, background: '#f59e0b', color: '#020617', border: 'none', borderRadius: 12, padding: '10px 24px', fontWeight: 700, cursor: 'pointer' }}
            >
              Recarregar
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
