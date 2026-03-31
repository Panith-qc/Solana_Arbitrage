// PHASE 2 AUTO-TRADING — BACKEND-CONNECTED
// Same beautiful UI, powered by the backend engine via API.
// Flow: Enter Key → Connect Wallet (backend) → Start Bot (backend) → Poll Stats

import { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { RiskLevel, getAllRiskProfiles, getRiskProfile } from '../config/riskProfiles';
import { Loader2, CheckCircle2, AlertCircle, TrendingUp, Shield, Zap, Activity, Rocket } from 'lucide-react';

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
  tradesSkipped: number;
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
  signatures: string;
}

export default function Phase2AutoTrading() {
  const [privateKey, setPrivateKey] = useState('');
  const [selectedRisk, setSelectedRisk] = useState<RiskLevel>('BALANCED');
  const [isConfiguring, setIsConfiguring] = useState(false);
  const [wallet, setWallet] = useState<WalletStatus>({ connected: false, publicKey: null, balanceSol: 0, rpcConnected: false });
  const [isTrading, setIsTrading] = useState(false);
  const [error, setError] = useState<string>('');
  const [stats, setStats] = useState<BotStats | null>(null);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [activeStrategies, setActiveStrategies] = useState<string[]>([]);

  const profiles = getAllRiskProfiles();

  // ── Poll wallet status on mount ──────────────────────────
  useEffect(() => {
    const checkWallet = async () => {
      try {
        const res = await fetch('/api/wallet/status');
        const data = await res.json();
        setWallet(data);
      } catch { /* ignore */ }
    };
    checkWallet();
    const interval = setInterval(checkWallet, 10000);
    return () => clearInterval(interval);
  }, []);

  // ── Poll bot stats while trading ─────────────────────────
  const pollStats = useCallback(async () => {
    try {
      const [statusRes, tradesRes] = await Promise.all([
        fetch('/api/status', { headers: { 'x-admin-token': localStorage.getItem('adminToken') || '' } }).then(r => r.ok ? r.json() : null).catch(() => null),
        fetch('/api/trades?limit=20', { headers: { 'x-admin-token': localStorage.getItem('adminToken') || '' } }).then(r => r.ok ? r.json() : null).catch(() => null),
      ]);
      if (statusRes?.stats) {
        setStats(statusRes.stats);
        if (statusRes.stats.activeStrategies) setActiveStrategies(statusRes.stats.activeStrategies);
        setIsTrading(statusRes.stats.status === 'running');
      }
      if (statusRes?.running !== undefined) {
        setIsTrading(statusRes.running);
      }
      if (tradesRes?.trades) setTrades(tradesRes.trades);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    if (wallet.connected) {
      pollStats();
      const interval = setInterval(pollStats, 3000);
      return () => clearInterval(interval);
    }
  }, [wallet.connected, pollStats]);

  // ── Connect wallet via backend ───────────────────────────
  const handleConfigure = async () => {
    if (!privateKey.trim()) {
      setError('Please enter your wallet private key');
      return;
    }

    setError('');
    setIsConfiguring(true);

    try {
      const res = await fetch('/api/wallet/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ privateKey: privateKey.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || data.error);

      // Set risk level on backend
      await fetch('/api/config/risk-level', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-token': localStorage.getItem('adminToken') || '' },
        body: JSON.stringify({ level: selectedRisk }),
      });

      setWallet({ connected: true, publicKey: data.publicKey, balanceSol: data.balanceSol, rpcConnected: true });
      setPrivateKey(''); // Clear private key from memory
      setIsConfiguring(false);
    } catch (err) {
      setError('Failed to configure bot: ' + (err as Error).message);
      setIsConfiguring(false);
    }
  };

  // ── Start trading via backend ────────────────────────────
  const handleStartTrading = async () => {
    setError('');
    try {
      const res = await fetch('/api/start', {
        method: 'POST',
        headers: { 'x-admin-token': localStorage.getItem('adminToken') || '' },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || data.error);
      setIsTrading(true);
      pollStats();
    } catch (err) {
      setError('Failed to start: ' + (err as Error).message);
    }
  };

  // ── Stop trading ─────────────────────────────────────────
  const handleStopTrading = async () => {
    try {
      await fetch('/api/stop', {
        method: 'POST',
        headers: { 'x-admin-token': localStorage.getItem('adminToken') || '' },
      });
      setIsTrading(false);
      setActiveStrategies([]);
    } catch { /* ignore */ }
  };

  // ── Emergency stop ───────────────────────────────────────
  const handleEmergencyStop = async () => {
    await fetch('/api/emergency-stop', {
      method: 'POST',
      headers: { 'x-admin-token': localStorage.getItem('adminToken') || '' },
    }).catch(() => {});
    setIsTrading(false);
    setActiveStrategies([]);
  };

  // ── Reset ────────────────────────────────────────────────
  const handleReset = async () => {
    if (isTrading) await handleStopTrading();
    await fetch('/api/wallet/disconnect', { method: 'POST' }).catch(() => {});
    setWallet({ connected: false, publicKey: null, balanceSol: 0, rpcConnected: false });
    setStats(null);
    setTrades([]);
    setActiveStrategies([]);
  };

  // ── Helpers ──────────────────────────────────────────────
  const getRiskIcon = (level: RiskLevel) => {
    if (level === 'CONSERVATIVE') return <Shield className="w-5 h-5" />;
    if (level === 'BALANCED') return <TrendingUp className="w-5 h-5" />;
    return <Zap className="w-5 h-5" />;
  };

  const getRiskColor = (level: RiskLevel) => {
    if (level === 'CONSERVATIVE') return 'bg-green-500';
    if (level === 'BALANCED') return 'bg-blue-500';
    return 'bg-red-500';
  };

  const currentProfile = getRiskProfile(stats?.riskLevel as RiskLevel || selectedRisk);

  return (
    <div className="container mx-auto p-6 max-w-6xl">
      <Card>
        <CardHeader>
          <CardTitle className="text-3xl">Phase 2 Automated MEV Bot</CardTitle>
          <CardDescription>
            All advanced strategies. Auto-configured based on risk profile. One-click start.
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-6">
          {/* Step 1 & 2: Configuration — shown when wallet not connected */}
          {!wallet.connected && (
            <>
              <div className="space-y-2">
                <Label htmlFor="privateKey">Wallet Private Key</Label>
                <Input
                  id="privateKey"
                  type="password"
                  placeholder="Enter your Solana wallet private key (bs58)..."
                  value={privateKey}
                  onChange={(e) => setPrivateKey(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleConfigure()}
                  className="font-mono"
                />
                <p className="text-sm text-muted-foreground">
                  Your private key is sent to the server securely. It stays in memory only — never saved to disk or logged.
                </p>
              </div>

              {/* Risk Profile Selection */}
              <div className="space-y-3">
                <Label>Select Risk Profile</Label>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  {profiles.map((profile) => (
                    <Card
                      key={profile.level}
                      className={`cursor-pointer transition-all ${
                        selectedRisk === profile.level
                          ? 'ring-2 ring-primary shadow-lg'
                          : 'hover:bg-accent'
                      }`}
                      onClick={() => setSelectedRisk(profile.level)}
                    >
                      <CardContent className="pt-6">
                        <div className="flex items-center gap-3 mb-3">
                          <div className={`p-2 rounded-full ${getRiskColor(profile.level)}`}>
                            {getRiskIcon(profile.level)}
                          </div>
                          <h3 className="font-bold text-lg">{profile.name}</h3>
                        </div>

                        <p className="text-sm text-muted-foreground mb-4">
                          {profile.description}
                        </p>

                        <div className="space-y-2 text-sm">
                          <div className="flex justify-between">
                            <span className="text-muted-foreground">Position:</span>
                            <span className="font-medium">{profile.maxPositionPercent}%</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-muted-foreground">Daily Return:</span>
                            <span className="font-medium text-green-600">{profile.expectedDailyReturn}</span>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </div>

              {error && (
                <Alert variant="destructive">
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}

              <Button
                className="w-full"
                size="lg"
                onClick={handleConfigure}
                disabled={isConfiguring || !privateKey.trim()}
              >
                {isConfiguring ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Connecting & Configuring...
                  </>
                ) : (
                  'Auto-Configure Bot'
                )}
              </Button>
            </>
          )}

          {/* Step 3: Trading Dashboard — shown when wallet connected */}
          {wallet.connected && (
            <>
              {/* Config Summary */}
              <Alert className="border-green-500 bg-green-50">
                <CheckCircle2 className="h-4 w-4 text-green-500" />
                <AlertDescription>
                  Wallet connected! Bot configured with <strong>{currentProfile.name}</strong> profile. Ready to trade.
                </AlertDescription>
              </Alert>

              <Card className="bg-gradient-to-br from-blue-50 to-purple-50">
                <CardHeader>
                  <CardTitle>Configuration Summary</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                    <div>
                      <p className="text-muted-foreground">Risk Profile</p>
                      <p className="font-bold text-lg">{currentProfile.name}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Balance</p>
                      <p className="font-bold text-lg">{wallet.balanceSol.toFixed(4)} SOL</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Wallet</p>
                      <p className="font-mono text-xs">{wallet.publicKey?.slice(0, 8)}...{wallet.publicKey?.slice(-6)}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Max Position</p>
                      <p className="font-bold">{(wallet.balanceSol * currentProfile.maxPositionPercent / 100).toFixed(4)} SOL</p>
                    </div>
                  </div>

                  <div>
                    <p className="text-sm text-muted-foreground mb-2">Enabled Strategies:</p>
                    <div className="flex flex-wrap gap-2">
                      {Object.entries(currentProfile.enabledStrategies)
                        .filter(([, enabled]) => enabled)
                        .map(([name]) => (
                          <Badge key={name} variant="secondary" className="text-xs">
                            {name.replace(/([A-Z])/g, ' $1').trim()}
                          </Badge>
                        ))}
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* Control Buttons */}
              <div className="flex gap-4">
                {!isTrading ? (
                  <Button
                    className="flex-1"
                    size="lg"
                    onClick={handleStartTrading}
                  >
                    <Rocket className="mr-2 h-4 w-4" />
                    Start Phase 2 Trading
                  </Button>
                ) : (
                  <>
                    <Button
                      className="flex-1"
                      size="lg"
                      variant="destructive"
                      onClick={handleStopTrading}
                    >
                      Stop All Strategies
                    </Button>
                    <Button
                      variant="outline"
                      size="lg"
                      onClick={handleEmergencyStop}
                      className="border-red-500 text-red-600 hover:bg-red-50"
                    >
                      EMERGENCY
                    </Button>
                  </>
                )}

                <Button
                  variant="outline"
                  onClick={handleReset}
                  disabled={isTrading}
                >
                  Reset
                </Button>
              </div>

              {error && (
                <Alert variant="destructive">
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}

              {/* Live Trading Dashboard */}
              {isTrading && (
                <>
                  <Alert className="border-green-500 bg-green-50">
                    <Rocket className="h-4 w-4 text-green-500 animate-pulse" />
                    <AlertDescription>
                      <span className="font-bold">Phase 2 strategies active!</span> Bot is monitoring {activeStrategies.length} strategies and auto-executing profitable trades.
                    </AlertDescription>
                  </Alert>

                  <Card className="bg-gradient-to-br from-green-50 to-blue-50 border-2 border-green-300">
                    <CardHeader>
                      <CardTitle className="flex items-center gap-2">
                        <Activity className="w-5 h-5 text-green-600 animate-pulse" />
                        Live Phase 2 Trading
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      {/* Stats */}
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                        <Card>
                          <CardContent className="pt-4 text-center">
                            <p className="text-sm text-muted-foreground">Scans</p>
                            <p className="text-3xl font-bold text-blue-600">{stats?.totalScans || 0}</p>
                            <p className="text-xs text-muted-foreground">{stats?.opportunitiesFound || 0} opps found</p>
                          </CardContent>
                        </Card>
                        <Card>
                          <CardContent className="pt-4 text-center">
                            <p className="text-sm text-muted-foreground">Trades</p>
                            <p className="text-3xl font-bold text-purple-600">{stats?.tradesExecuted || 0}</p>
                            <p className="text-xs text-muted-foreground">{stats?.tradesSuccessful || 0} won / {stats?.tradesFailed || 0} lost</p>
                          </CardContent>
                        </Card>
                        <Card>
                          <CardContent className="pt-4 text-center">
                            <p className="text-sm text-muted-foreground">Profit</p>
                            <p className={`text-3xl font-bold ${(stats?.totalProfitSol || 0) >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                              {(stats?.totalProfitSol || 0) >= 0 ? '+' : ''}{(stats?.totalProfitSol || 0).toFixed(4)}
                            </p>
                            <p className="text-xs text-muted-foreground">${(stats?.totalProfitUsd || 0).toFixed(2)} USD</p>
                          </CardContent>
                        </Card>
                        <Card>
                          <CardContent className="pt-4 text-center">
                            <p className="text-sm text-muted-foreground">Balance</p>
                            <p className="text-3xl font-bold text-amber-600">{(stats?.currentBalanceSol || wallet.balanceSol).toFixed(4)}</p>
                            <p className="text-xs text-muted-foreground">SOL @ ${(stats?.currentSolPriceUsd || 0).toFixed(2)}</p>
                          </CardContent>
                        </Card>
                      </div>

                      {/* Active Strategies */}
                      {activeStrategies.length > 0 && (
                        <div>
                          <p className="text-sm font-semibold mb-2">Active Strategies:</p>
                          <div className="flex flex-wrap gap-2">
                            {activeStrategies.map(strategy => (
                              <Badge key={strategy} className="bg-green-100 text-green-700">
                                <Rocket className="w-3 h-3 mr-1 inline animate-pulse" />
                                {strategy}
                              </Badge>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Recent Trades */}
                      {trades.length > 0 ? (
                        <div>
                          <p className="text-sm font-semibold mb-2">Recent Trades ({trades.length}):</p>
                          <div className="space-y-2 max-h-80 overflow-y-auto">
                            {trades.slice(0, 15).map(trade => (
                              <div key={trade.trade_id} className="bg-white p-3 rounded-lg border shadow-sm">
                                <div className="flex justify-between items-start">
                                  <div className="flex-1">
                                    <div className="flex items-center gap-2 flex-wrap">
                                      <span className="font-semibold text-sm">{trade.route_description || trade.trade_id.slice(0, 12)}</span>
                                      <Badge className="bg-purple-100 text-purple-700 text-xs">
                                        {trade.strategy}
                                      </Badge>
                                    </div>
                                    <div className="flex gap-3 mt-1 text-xs text-muted-foreground">
                                      <span className={`font-semibold ${(trade.profit_sol ?? 0) >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                                        {trade.profit_sol !== null ? `${trade.profit_sol >= 0 ? '+' : ''}${trade.profit_sol.toFixed(6)} SOL` : 'pending'}
                                      </span>
                                      {trade.profit_usd !== null && (
                                        <span>${trade.profit_usd.toFixed(4)}</span>
                                      )}
                                      <span>{new Date(trade.created_at).toLocaleTimeString()}</span>
                                    </div>
                                  </div>
                                  <Badge className={`text-xs ${
                                    trade.status === 'completed' ? 'bg-green-500 text-white' :
                                    trade.status === 'failed' ? 'bg-red-100 text-red-700' :
                                    'bg-yellow-100 text-yellow-700'
                                  }`}>
                                    {trade.status === 'completed' ? 'Executed' : trade.status}
                                  </Badge>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      ) : (
                        <div className="text-center py-8 bg-white rounded-lg border">
                          <Activity className="w-16 h-16 mx-auto text-blue-400 animate-pulse mb-3" />
                          <p className="text-base font-semibold mb-2">Monitoring Market...</p>
                          <p className="text-sm text-muted-foreground mb-4">
                            Bot is actively scanning {activeStrategies.length} strategies for profitable opportunities
                          </p>
                          <div className="max-w-xs mx-auto space-y-1">
                            {activeStrategies.map(s => (
                              <div key={s} className="text-xs text-gray-600 flex items-center justify-center gap-2">
                                <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
                                {s}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </CardContent>
                  </Card>
                </>
              )}

              {/* Stats when NOT trading (but wallet connected) */}
              {!isTrading && stats && stats.tradesExecuted > 0 && (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-lg">Session Summary</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="grid grid-cols-3 gap-4 text-center">
                      <div>
                        <p className="text-sm text-muted-foreground">Trades</p>
                        <p className="text-2xl font-bold">{stats.tradesExecuted}</p>
                      </div>
                      <div>
                        <p className="text-sm text-muted-foreground">Win Rate</p>
                        <p className="text-2xl font-bold">{stats.tradesExecuted > 0 ? ((stats.tradesSuccessful / stats.tradesExecuted) * 100).toFixed(0) : 0}%</p>
                      </div>
                      <div>
                        <p className="text-sm text-muted-foreground">Net Profit</p>
                        <p className={`text-2xl font-bold ${stats.totalProfitSol >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                          {stats.totalProfitSol >= 0 ? '+' : ''}{stats.totalProfitSol.toFixed(4)} SOL
                        </p>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
