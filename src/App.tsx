import { useState, useEffect, useCallback } from 'react';

// ═══════════════════════════════════════════════════════════
// SOLANA MEV BOT — PRODUCTION DASHBOARD
// Connects to the backend engine via API.
// Flow: Connect Wallet → Start Bot → Monitor Trades
// ═══════════════════════════════════════════════════════════

interface WalletStatus {
  connected: boolean;
  publicKey: string | null;
  balanceSol: number;
  rpcConnected: boolean;
}

interface BotStats {
  status: string;
  uptime: number;
  totalScans: number;
  opportunitiesFound: number;
  tradesExecuted: number;
  tradesSuccessful: number;
  tradesFailed: number;
  totalProfitSol: number;
  totalProfitUsd: number;
  currentBalanceSol: number;
  currentSolPriceUsd: number;
  activeStrategies: string[];
  riskLevel: string;
}

interface Trade {
  trade_id: string;
  strategy: string;
  status: string;
  profit_sol: number | null;
  profit_usd: number | null;
  created_at: string;
  route_description: string | null;
}

function App() {
  // State
  const [privateKey, setPrivateKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [wallet, setWallet] = useState<WalletStatus>({ connected: false, publicKey: null, balanceSol: 0, rpcConnected: false });
  const [botRunning, setBotRunning] = useState(false);
  const [stats, setStats] = useState<BotStats | null>(null);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState('');
  const [riskLevel, setRiskLevel] = useState('BALANCED');

  // Poll wallet status and bot stats
  const pollStatus = useCallback(async () => {
    try {
      const [walletRes, healthRes] = await Promise.all([
        fetch('/api/wallet/status').then(r => r.json()).catch(() => null),
        fetch('/api/health').then(r => r.json()).catch(() => null),
      ]);
      if (walletRes) setWallet(walletRes);
      if (healthRes) setBotRunning(healthRes.wallet === 'connected');
    } catch { /* ignore */ }
  }, []);

  // Poll stats when bot is running
  const pollStats = useCallback(async () => {
    if (!wallet.connected) return;
    try {
      const token = localStorage.getItem('adminToken') || '';
      const headers: Record<string, string> = {};
      if (token) headers['x-admin-token'] = token;

      const [statusRes, tradesRes] = await Promise.all([
        fetch('/api/status', { headers }).then(r => r.ok ? r.json() : null).catch(() => null),
        fetch('/api/trades?limit=20', { headers }).then(r => r.ok ? r.json() : null).catch(() => null),
      ]);
      if (statusRes?.stats) setStats(statusRes.stats);
      if (tradesRes?.trades) setTrades(tradesRes.trades);
    } catch { /* ignore */ }
  }, [wallet.connected]);

  useEffect(() => {
    pollStatus();
    const interval = setInterval(pollStatus, 5000);
    return () => clearInterval(interval);
  }, [pollStatus]);

  useEffect(() => {
    if (wallet.connected) {
      pollStats();
      const interval = setInterval(pollStats, 3000);
      return () => clearInterval(interval);
    }
  }, [wallet.connected, pollStats]);

  // Connect wallet
  const handleConnect = async () => {
    const trimmed = privateKey.trim();
    if (!trimmed) { setError('Enter your private key'); return; }
    if (trimmed.length < 32) { setError('Key too short — expected bs58 format'); return; }

    setError('');
    setLoading('Connecting wallet...');

    try {
      const res = await fetch('/api/wallet/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ privateKey: trimmed }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || data.error);

      setWallet({ connected: true, publicKey: data.publicKey, balanceSol: data.balanceSol, rpcConnected: true });
      setPrivateKey(''); // Clear from state immediately
      setLoading('');
    } catch (err: any) {
      setError(err.message);
      setLoading('');
    }
  };

  // Disconnect
  const handleDisconnect = async () => {
    await fetch('/api/wallet/disconnect', { method: 'POST' }).catch(() => {});
    setWallet({ connected: false, publicKey: null, balanceSol: 0, rpcConnected: false });
    setBotRunning(false);
    setStats(null);
    setTrades([]);
  };

  // Start bot
  const handleStart = async () => {
    setError('');
    setLoading('Starting bot...');
    try {
      const token = localStorage.getItem('adminToken') || '';
      const res = await fetch('/api/start', {
        method: 'POST',
        headers: { 'x-admin-token': token },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || data.error);
      setBotRunning(true);
      setLoading('');
    } catch (err: any) {
      setError(err.message);
      setLoading('');
    }
  };

  // Stop bot
  const handleStop = async () => {
    setLoading('Stopping bot...');
    try {
      const token = localStorage.getItem('adminToken') || '';
      await fetch('/api/stop', { method: 'POST', headers: { 'x-admin-token': token } });
      setBotRunning(false);
      setLoading('');
    } catch { setLoading(''); }
  };

  // Emergency stop
  const handleEmergencyStop = async () => {
    const token = localStorage.getItem('adminToken') || '';
    await fetch('/api/emergency-stop', { method: 'POST', headers: { 'x-admin-token': token } });
    setBotRunning(false);
  };

  // Change risk level
  const handleRiskChange = async (level: string) => {
    const token = localStorage.getItem('adminToken') || '';
    await fetch('/api/config/risk-level', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-token': token },
      body: JSON.stringify({ level }),
    });
    setRiskLevel(level);
  };

  return (
    <div style={{ minHeight: '100vh', background: '#0a0a0f', color: '#e2e8f0', fontFamily: 'system-ui, -apple-system, sans-serif' }}>
      {/* Header */}
      <div style={{ background: '#111118', borderBottom: '1px solid #1e293b', padding: '16px 24px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h1 style={{ fontSize: '20px', fontWeight: 700, margin: 0 }}>Solana MEV Bot</h1>
          <span style={{ fontSize: '12px', color: '#64748b' }}>Production Engine</span>
        </div>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <span style={{ fontSize: '12px', padding: '4px 8px', borderRadius: '4px', background: wallet.rpcConnected ? '#064e3b' : '#7f1d1d', color: wallet.rpcConnected ? '#34d399' : '#fca5a5' }}>
            RPC {wallet.rpcConnected ? 'Connected' : 'Disconnected'}
          </span>
          <span style={{ fontSize: '12px', padding: '4px 8px', borderRadius: '4px', background: wallet.connected ? '#064e3b' : '#78350f', color: wallet.connected ? '#34d399' : '#fbbf24' }}>
            Wallet {wallet.connected ? 'Connected' : 'Not Connected'}
          </span>
        </div>
      </div>

      <div style={{ maxWidth: '960px', margin: '0 auto', padding: '24px' }}>
        {/* Error display */}
        {error && (
          <div style={{ background: '#7f1d1d', border: '1px solid #dc2626', borderRadius: '8px', padding: '12px 16px', marginBottom: '16px', color: '#fca5a5' }}>
            {error}
            <button onClick={() => setError('')} style={{ float: 'right', background: 'none', border: 'none', color: '#fca5a5', cursor: 'pointer' }}>x</button>
          </div>
        )}

        {/* Loading */}
        {loading && (
          <div style={{ background: '#1e3a5f', border: '1px solid #3b82f6', borderRadius: '8px', padding: '12px 16px', marginBottom: '16px', color: '#93c5fd' }}>
            {loading}
          </div>
        )}

        {/* WALLET CONNECTION */}
        {!wallet.connected ? (
          <div style={{ background: '#111118', border: '1px solid #1e293b', borderRadius: '12px', padding: '32px', marginBottom: '24px' }}>
            <h2 style={{ fontSize: '18px', fontWeight: 600, marginBottom: '4px' }}>Connect Your Wallet</h2>
            <p style={{ color: '#64748b', fontSize: '14px', marginBottom: '24px' }}>
              Paste your bs58-encoded Solana private key. It stays in server memory only — never saved to disk.
            </p>

            <div style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
              <input
                type={showKey ? 'text' : 'password'}
                value={privateKey}
                onChange={e => setPrivateKey(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleConnect()}
                placeholder="Enter your bs58 private key..."
                style={{ flex: 1, background: '#0a0a0f', border: '1px solid #334155', borderRadius: '8px', padding: '12px', color: '#e2e8f0', fontSize: '14px', fontFamily: 'monospace' }}
              />
              <button onClick={() => setShowKey(!showKey)} style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: '8px', padding: '0 12px', color: '#94a3b8', cursor: 'pointer' }}>
                {showKey ? 'Hide' : 'Show'}
              </button>
            </div>

            <button
              onClick={handleConnect}
              disabled={!!loading}
              style={{ width: '100%', background: '#2563eb', color: 'white', border: 'none', borderRadius: '8px', padding: '12px', fontSize: '16px', fontWeight: 600, cursor: loading ? 'not-allowed' : 'pointer', opacity: loading ? 0.5 : 1 }}
            >
              {loading || 'Connect Wallet'}
            </button>

            {!wallet.rpcConnected && (
              <p style={{ color: '#f59e0b', fontSize: '13px', marginTop: '12px' }}>
                RPC not connected. Make sure HELIUS_RPC_URL is set in your .env file and restart the server.
              </p>
            )}
          </div>
        ) : (
          <>
            {/* WALLET INFO */}
            <div style={{ background: '#111118', border: '1px solid #064e3b', borderRadius: '12px', padding: '20px', marginBottom: '16px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                <h2 style={{ fontSize: '16px', fontWeight: 600, color: '#34d399', margin: 0 }}>Wallet Connected</h2>
                <button onClick={handleDisconnect} style={{ background: '#7f1d1d', border: 'none', borderRadius: '6px', padding: '6px 12px', color: '#fca5a5', cursor: 'pointer', fontSize: '12px' }}>
                  Disconnect
                </button>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
                <div>
                  <div style={{ color: '#64748b', fontSize: '12px' }}>Public Key</div>
                  <div style={{ fontFamily: 'monospace', fontSize: '13px', wordBreak: 'break-all' }}>{wallet.publicKey}</div>
                </div>
                <div>
                  <div style={{ color: '#64748b', fontSize: '12px' }}>Balance</div>
                  <div style={{ fontSize: '24px', fontWeight: 700, color: '#34d399' }}>{wallet.balanceSol.toFixed(4)} SOL</div>
                </div>
              </div>
            </div>

            {/* RISK LEVEL + CONTROLS */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '16px' }}>
              {/* Risk Level */}
              <div style={{ background: '#111118', border: '1px solid #1e293b', borderRadius: '12px', padding: '20px' }}>
                <h3 style={{ fontSize: '14px', color: '#64748b', marginBottom: '12px' }}>Risk Level</h3>
                <div style={{ display: 'flex', gap: '8px' }}>
                  {['CONSERVATIVE', 'BALANCED', 'AGGRESSIVE'].map(level => (
                    <button
                      key={level}
                      onClick={() => handleRiskChange(level)}
                      style={{
                        flex: 1, padding: '8px', borderRadius: '6px', border: 'none', cursor: 'pointer', fontSize: '11px', fontWeight: 600,
                        background: (stats?.riskLevel || riskLevel) === level ? (level === 'CONSERVATIVE' ? '#064e3b' : level === 'BALANCED' ? '#1e3a5f' : '#7f1d1d') : '#1e293b',
                        color: (stats?.riskLevel || riskLevel) === level ? (level === 'CONSERVATIVE' ? '#34d399' : level === 'BALANCED' ? '#60a5fa' : '#f87171') : '#64748b',
                      }}
                    >
                      {level}
                    </button>
                  ))}
                </div>
              </div>

              {/* Bot Controls */}
              <div style={{ background: '#111118', border: '1px solid #1e293b', borderRadius: '12px', padding: '20px' }}>
                <h3 style={{ fontSize: '14px', color: '#64748b', marginBottom: '12px' }}>Bot Controls</h3>
                <div style={{ display: 'flex', gap: '8px' }}>
                  {!stats || stats.status !== 'running' ? (
                    <button onClick={handleStart} disabled={!!loading} style={{ flex: 1, background: '#059669', color: 'white', border: 'none', borderRadius: '6px', padding: '10px', fontSize: '14px', fontWeight: 600, cursor: 'pointer' }}>
                      Start Bot
                    </button>
                  ) : (
                    <>
                      <button onClick={handleStop} style={{ flex: 1, background: '#d97706', color: 'white', border: 'none', borderRadius: '6px', padding: '10px', fontSize: '14px', fontWeight: 600, cursor: 'pointer' }}>
                        Stop
                      </button>
                      <button onClick={handleEmergencyStop} style={{ background: '#dc2626', color: 'white', border: 'none', borderRadius: '6px', padding: '10px 16px', fontSize: '14px', fontWeight: 600, cursor: 'pointer' }}>
                        EMERGENCY
                      </button>
                    </>
                  )}
                </div>
              </div>
            </div>

            {/* LIVE STATS */}
            {stats && (
              <div style={{ background: '#111118', border: '1px solid #1e293b', borderRadius: '12px', padding: '20px', marginBottom: '16px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                  <h3 style={{ fontSize: '14px', color: '#64748b', margin: 0 }}>Live Performance</h3>
                  <span style={{
                    fontSize: '12px', padding: '4px 10px', borderRadius: '20px', fontWeight: 600,
                    background: stats.status === 'running' ? '#064e3b' : '#1e293b',
                    color: stats.status === 'running' ? '#34d399' : '#64748b',
                  }}>
                    {stats.status.toUpperCase()}
                  </span>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '16px' }}>
                  <StatBox label="Total Profit" value={`${stats.totalProfitSol >= 0 ? '+' : ''}${stats.totalProfitSol.toFixed(4)} SOL`} sub={`$${stats.totalProfitUsd.toFixed(2)}`} color={stats.totalProfitSol >= 0 ? '#34d399' : '#f87171'} />
                  <StatBox label="Trades" value={`${stats.tradesSuccessful}/${stats.tradesExecuted}`} sub={`${stats.tradesExecuted > 0 ? ((stats.tradesSuccessful / stats.tradesExecuted) * 100).toFixed(0) : 0}% win rate`} color="#60a5fa" />
                  <StatBox label="Scans" value={stats.totalScans.toString()} sub={`${stats.opportunitiesFound} opportunities`} color="#a78bfa" />
                  <StatBox label="Balance" value={`${stats.currentBalanceSol.toFixed(4)} SOL`} sub={`SOL $${stats.currentSolPriceUsd.toFixed(2)}`} color="#fbbf24" />
                </div>

                {stats.activeStrategies.length > 0 && (
                  <div style={{ marginTop: '16px' }}>
                    <div style={{ fontSize: '12px', color: '#64748b', marginBottom: '8px' }}>Active Strategies</div>
                    <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                      {stats.activeStrategies.map(s => (
                        <span key={s} style={{ fontSize: '11px', padding: '3px 8px', borderRadius: '4px', background: '#1e293b', color: '#94a3b8' }}>{s}</span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* RECENT TRADES */}
            {trades.length > 0 && (
              <div style={{ background: '#111118', border: '1px solid #1e293b', borderRadius: '12px', padding: '20px' }}>
                <h3 style={{ fontSize: '14px', color: '#64748b', marginBottom: '16px' }}>Recent Trades</h3>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                    <thead>
                      <tr style={{ borderBottom: '1px solid #1e293b', color: '#64748b', textAlign: 'left' }}>
                        <th style={{ padding: '8px' }}>Time</th>
                        <th style={{ padding: '8px' }}>Strategy</th>
                        <th style={{ padding: '8px' }}>Route</th>
                        <th style={{ padding: '8px', textAlign: 'right' }}>Profit</th>
                        <th style={{ padding: '8px', textAlign: 'right' }}>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {trades.map(t => (
                        <tr key={t.trade_id} style={{ borderBottom: '1px solid #0f172a' }}>
                          <td style={{ padding: '8px', color: '#94a3b8' }}>{new Date(t.created_at).toLocaleTimeString()}</td>
                          <td style={{ padding: '8px' }}>{t.strategy}</td>
                          <td style={{ padding: '8px', color: '#94a3b8', maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.route_description || '-'}</td>
                          <td style={{ padding: '8px', textAlign: 'right', color: (t.profit_sol ?? 0) >= 0 ? '#34d399' : '#f87171', fontFamily: 'monospace' }}>
                            {t.profit_sol !== null ? `${t.profit_sol >= 0 ? '+' : ''}${t.profit_sol.toFixed(6)}` : '-'}
                          </td>
                          <td style={{ padding: '8px', textAlign: 'right' }}>
                            <span style={{
                              fontSize: '11px', padding: '2px 6px', borderRadius: '4px',
                              background: t.status === 'completed' ? '#064e3b' : t.status === 'failed' ? '#7f1d1d' : '#1e293b',
                              color: t.status === 'completed' ? '#34d399' : t.status === 'failed' ? '#f87171' : '#94a3b8',
                            }}>{t.status}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function StatBox({ label, value, sub, color }: { label: string; value: string; sub: string; color: string }) {
  return (
    <div>
      <div style={{ fontSize: '12px', color: '#64748b', marginBottom: '4px' }}>{label}</div>
      <div style={{ fontSize: '18px', fontWeight: 700, color, fontFamily: 'monospace' }}>{value}</div>
      <div style={{ fontSize: '11px', color: '#475569', marginTop: '2px' }}>{sub}</div>
    </div>
  );
}

export default App;
