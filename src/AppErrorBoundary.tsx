'use client'

import { Component, type ErrorInfo, type ReactNode } from 'react'

type Props = { children: ReactNode }

type State = {
  error: Error | null
}

/**
 * Fängt Render-Fehler ab — ohne Boundary zeigt React oft nur eine leere Seite.
 */
export class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('AppErrorBoundary', error, info.componentStack)
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="app cloud-loading" role="alert">
          <div style={{ maxWidth: '40rem', padding: '1rem' }}>
            <h1 style={{ fontSize: '1.15rem', margin: '0 0 0.75rem' }}>
              Die App konnte nicht angezeigt werden.
            </h1>
            <p style={{ margin: '0 0 0.75rem', color: 'var(--text-muted)' }}>
              Details siehe Konsole (Entwicklertools). Nach einem Neuladen
              erneut versuchen; wenn es weiter passiert, die Fehlermeldung
              notieren.
            </p>
            <pre
              style={{
                margin: 0,
                whiteSpace: 'pre-wrap',
                fontSize: '0.85rem',
                color: 'var(--text)',
              }}
            >
              {this.state.error.message}
            </pre>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
