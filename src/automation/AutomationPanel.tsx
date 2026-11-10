import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Copy, LoaderCircle, Plug, Square } from 'lucide-react';
import { desktop } from '../platform';
import './automation.css';

interface Connection {
  running: boolean;
  endpoint?: string;
  token?: string;
  allowEdits: boolean;
}
export default function AutomationPanel() {
  const [connection, setConnection] = useState<Connection>({ running: false, allowEdits: false });
  const [allowEdits, setAllowEdits] = useState(false);
  const [busy, setBusy] = useState(false);
  const [mcpPath, setMcpPath] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [showToken, setShowToken] = useState(false);
  useEffect(() => {
    let active = true;
    if (desktop)
      void invoke<string>('automation_mcp_path')
        .then((path) => {
          if (active) setMcpPath(path);
        })
        .catch(() => {});
    if (desktop)
      void invoke<Connection>('automation_status')
        .then((status) => {
          if (active) {
            setConnection(status);
            setAllowEdits(status.allowEdits);
          }
        })
        .catch(() => {
          if (active) setError('API controls need the latest desktop test build.');
        });
    return () => {
      active = false;
    };
  }, []);
  const toggle = async () => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      if (connection.running) {
        await invoke('automation_stop');
        setConnection({ running: false, allowEdits: false });
        setMessage('Connection stopped. Its access token is no longer valid.');
      } else {
        const status = await invoke<Connection>('automation_start', { allowEdits });
        setConnection(status);
        setMessage(
          allowEdits
            ? 'Connected clients can inspect and edit this session.'
            : 'Connected clients can inspect and export this session.',
        );
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const copy = async (value: string, description: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setMessage(`${description} copied.`);
      setError('');
    } catch {
      setError('Copy was unavailable. Select and copy the connection field instead.');
    }
  };
  return (
    <section className="automation-panel" aria-labelledby="automation-heading">
      <h3 id="automation-heading">
        <Plug size={16} /> API &amp; AI connections
      </h3>
      <p>
        Connect a test client or an AI assistant to this editor. The connection is off until you
        start it.
      </p>
      {!desktop ? (
        <p className="help-text">
          Available in the desktop app. Browser preview does not open an API connection.
        </p>
      ) : (
        <>
          <label className="toggle-label">
            <input
              type="checkbox"
              checked={allowEdits}
              disabled={busy || connection.running}
              onChange={(event) => setAllowEdits(event.target.checked)}
            />{' '}
            Allow edits through the API
          </label>
          <p className="help-text">
            Off allows inspection and export. Sprite edits can be undone. Replacing a converter
            source resets its trim and anchors. Stop the connection to change access.
          </p>
          <button
            className={`button ${connection.running ? 'subtle' : 'primary'}`}
            onClick={() => void toggle()}
            disabled={busy}
          >
            {busy ? (
              <LoaderCircle size={14} className="spin" />
            ) : connection.running ? (
              <Square size={14} />
            ) : (
              <Plug size={14} />
            )}
            {connection.running ? 'Stop connection' : 'Start connection'}
          </button>
          {connection.running && (
            <div className="automation-connection">
              <p className="automation-state">
                Running · {connection.allowEdits ? 'Edits allowed' : 'Read only'} · this session
              </p>
              <label className="text-field">
                <span>API address</span>
                <input
                  aria-label="Automation API address"
                  readOnly
                  value={connection.endpoint ?? ''}
                />
              </label>
              <label className="text-field">
                <span>Access token</span>
                <input
                  aria-label="Automation access token"
                  type={showToken ? 'text' : 'password'}
                  readOnly
                  autoComplete="off"
                  value={connection.token ?? ''}
                />
              </label>
              <div className="automation-actions">
                <button
                  className="button subtle small"
                  aria-pressed={showToken}
                  onClick={() => setShowToken((value) => !value)}
                >
                  {showToken ? 'Hide token' : 'Show token'}
                </button>
                <button
                  className="button subtle small"
                  onClick={() => void copy(connection.endpoint ?? '', 'API address')}
                >
                  <Copy size={12} /> Copy address
                </button>
                <button
                  className="button subtle small"
                  onClick={() => void copy(connection.token ?? '', 'Access token')}
                >
                  <Copy size={12} /> Copy token
                </button>
              </div>
              {mcpPath && (
                <button
                  className="button subtle small"
                  onClick={() =>
                    void copy(
                      JSON.stringify(
                        {
                          mcpServers: {
                            'pixel-forge': {
                              command: 'node',
                              args: [mcpPath],
                              env: {
                                PIXEL_FORGE_API_URL: connection.endpoint,
                                PIXEL_FORGE_API_TOKEN: connection.token,
                              },
                            },
                          },
                        },
                        null,
                        2,
                      ),
                      'MCP configuration',
                    )
                  }
                >
                  <Copy size={12} /> Copy MCP configuration
                </button>
              )}
              <p className="help-text">
                Use the MCP adapter with this address and token. For another computer, forward the
                local port over SSH. Tokens expire when the connection stops.
              </p>
              <details>
                <summary>MCP setup</summary>
                <p>
                  Run <code>{mcpPath || 'scripts/pixel-forge-mcp.mjs'}</code> with Node.js 24 or
                  newer. Set <code>PIXEL_FORGE_API_URL</code> and <code>PIXEL_FORGE_API_TOKEN</code>{' '}
                  in your AI client’s MCP configuration.
                </p>
                <p>
                  Local API only. Remote clients connect through an SSH tunnel; the app does not
                  listen on your network.
                </p>
              </details>
            </div>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="automation-error">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="help-text">
          {message}
        </p>
      )}
    </section>
  );
}
