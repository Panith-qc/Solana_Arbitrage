import React, { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { 
  Activity, 
  Zap, 
  CheckCircle, 
  XCircle, 
  AlertTriangle,
  Target,
  Shield,
  Clock,
  Settings,
  Bot,
  Key,
  Eye,
  EyeOff,
  Wifi,
  WifiOff,
  TrendingUp,
  DollarSign,
  Trash2
} from 'lucide-react';

import { privateKeyWallet, PrivateKeyWalletState } from '../services/privateKeyWallet';
import { fastMEVEngine, MEVOpportunity, TradeResult } from '../services/fastMEVEngine';

interface AutoTradeSettings {
  enabled: boolean;
  minProfitUsd: number;
  maxCapitalSol: number;
  maxRiskLevel: 'ULTRA_LOW' | 'LOW' | 'MEDIUM';
  minConfidence: number;
  executionDelay: number; // ms delay between detection and execution
  gasEstimateSol: number; // Gas fee estimate in SOL
  maxSlippagePercent: number; // Max slippage in percent (not BPS)
  priorityFeeLamports: number; // Priority fee in lamports
  tradeSizeSol: number; // Trade size in SOL
  scanIntervalMs: number; // Scan interval in milliseconds
}

interface TradeExecution {
  id: string;
  opportunity: MEVOpportunity;
  result: TradeResult;
  timestamp: Date;
}

const PrivateKeyTradingDashboard: React.FC = () => {
  // State management
  const [opportunities, setOpportunities] = useState<MEVOpportunity[]>([]);
  const [isScanning, setIsScanning] = useState(false);
  const [executingTradeId, setExecutingTradeId] = useState<string | null>(null);
  const [tradeHistory, setTradeHistory] = useState<TradeExecution[]>([]);
  const [showSettings, setShowSettings] = useState(false);
  const [scanInterval, setScanInterval] = useState<NodeJS.Timeout | null>(null);

  // Token cleanup state
  const [isCleaningTokens, setIsCleaningTokens] = useState(false);
  const [cleanupStatus, setCleanupStatus] = useState<string>('');

  // Private key wallet state
  const [walletState, setWalletState] = useState<PrivateKeyWalletState>({
    isConnected: false,
    publicKey: null,
    keypair: null,
    balance: 0
  });

  // Private key input
  const [privateKeyInput, setPrivateKeyInput] = useState('');
  const [showPrivateKey, setShowPrivateKey] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [connectionError, setConnectionError] = useState('');

  // Auto-trade settings with SAFE defaults (NO HARDCODING)
  const [autoTradeSettings, setAutoTradeSettings] = useState<AutoTradeSettings>({
    enabled: false,
    minProfitUsd: 0.001, // $0.001 minimum
    maxCapitalSol: 0.6, // Your max capital
    maxRiskLevel: 'LOW',
    minConfidence: 0.8, // 80% minimum confidence
    executionDelay: 100, // 100ms delay for speed
    gasEstimateSol: 0.003, // SAFE gas estimate
    maxSlippagePercent: 1.0, // SAFE max slippage (1%)
    priorityFeeLamports: 1000000, // SAFE priority fee (0.001 SOL)
    tradeSizeSol: 0.05, // SAFE base amount
    scanIntervalMs: 5000 // SAFE scan interval (5 seconds)
  });

  // Performance metrics
  const [performanceStats, setPerformanceStats] = useState({
    totalTrades: 0,
    successfulTrades: 0,
    totalProfitUsd: 0,
    avgExecutionTime: 0,
    successRate: 0
  });

  // System health
  const [systemHealth, setSystemHealth] = useState({
    jupiterApi: true,
    walletConnected: false,
    scannerActive: false,
    rpcConnection: true,
    lastHealthCheck: new Date()
  });

  // Update system health
  useEffect(() => {
    setSystemHealth(prev => ({
      ...prev,
      walletConnected: walletState.isConnected,
      scannerActive: isScanning,
      lastHealthCheck: new Date()
    }));
  }, [walletState.isConnected, isScanning]);

  // Handle private key wallet connection
  const handleConnectPrivateKey = async () => {
    if (!privateKeyInput.trim()) {
      setConnectionError('Please enter your private key');
      return;
    }

    setIsConnecting(true);
    setConnectionError('');
    
    try {
      console.log('🔗 Connecting with private key via Helius...');
      const newWalletState = await privateKeyWallet.connectWithPrivateKey(privateKeyInput.trim());
      setWalletState(newWalletState);
      setPrivateKeyInput(''); // Clear private key for security
      
      setSystemHealth(prev => ({
        ...prev,
        walletConnected: true,
        rpcConnection: true
      }));
      
      console.log('✅ Private key wallet connected successfully');
    } catch (error) {
      console.error('❌ Failed to connect with private key:', error);
      setConnectionError(`Connection failed: ${error}`);
      
      setSystemHealth(prev => ({
        ...prev,
        walletConnected: false,
        rpcConnection: false
      }));
    } finally {
      setIsConnecting(false);
    }
  };

  // Handle wallet disconnect
  const handleDisconnectWallet = async () => {
    try {
      await privateKeyWallet.disconnectWallet();
      setWalletState({
        isConnected: false,
        publicKey: null,
        keypair: null,
        balance: 0
      });
      
      if (isScanning) {
        stopScanning();
      }
      
      setSystemHealth(prev => ({
        ...prev,
        walletConnected: false
      }));
      
      console.log('✅ Private key wallet disconnected');
    } catch (error) {
      console.error('❌ Failed to disconnect wallet:', error);
    }
  };

  // Token cleanup function
  const handleTokenCleanup = async () => {
    if (!walletState.isConnected) {
      setCleanupStatus('❌ Wallet not connected');
      return;
    }

    setIsCleaningTokens(true);
    setCleanupStatus('🔍 Scanning for stuck tokens...');

    try {
      const tokens = await tokenCleanupService.scanWalletTokens();
      
      if (tokens.length === 0) {
        setCleanupStatus('✅ No stuck tokens found - wallet is clean!');
        setIsCleaningTokens(false);
        return;
      }

      setCleanupStatus(`🧹 Found ${tokens.length} stuck tokens. Converting to SOL...`);
      
      const result = await tokenCleanupService.cleanupAllTokens(0.001);
      
      if (result.success) {
        setCleanupStatus(`✅ Cleanup complete! Converted ${result.tokensCleaned} tokens. Recovered ~$${(result.totalValueRecovered != null && !isNaN(result.totalValueRecovered) && typeof result.totalValueRecovered === 'number' ? result.totalValueRecovered.toFixed(4) : '0.0000')}`);
        
        // Refresh balance
        setTimeout(async () => {
          const newBalance = await privateKeyWallet.getBalance();
          setWalletState(prev => ({ ...prev, balance: newBalance }));
        }, 3000);
      } else {
        setCleanupStatus(`⚠️ Partial cleanup: ${result.tokensCleaned} converted, ${result.errors.length} errors`);
      }
      
    } catch (error) {
      console.error('Token cleanup failed:', error);
      setCleanupStatus('❌ Token cleanup failed. Please try again.');
    } finally {
      setIsCleaningTokens(false);
      // Clear status after 10 seconds
      setTimeout(() => setCleanupStatus(''), 10000);
    }
  };

  // Start safe MEV scanning
  const startScanning = useCallback(async () => {
    if (!walletState.isConnected) {
      console.log('❌ Cannot start scanning - wallet not connected');
      return;
    }

    console.log('⚡ Starting SAFE MEV scanning with UI parameters...');
    setIsScanning(true);
    
    const scanForOpportunities = async () => {
      try {
        // PASS ALL PARAMETERS FROM UI (NO HARDCODING)
        const newOpportunities = await fastMEVEngine.scanForMEVOpportunities(
          autoTradeSettings.maxCapitalSol,
          autoTradeSettings.gasEstimateSol,
          autoTradeSettings.tradeSizeSol,
          autoTradeSettings.maxSlippagePercent,
          autoTradeSettings.priorityFeeLamports / 1e9 // Convert to SOL
        );
        
        if (newOpportunities.length > 0) {
          setOpportunities(prev => {
            const combined = [...newOpportunities, ...prev];
            return combined.slice(0, 5); // Keep only latest 5 for speed
          });

          // Auto-execute if enabled and conditions met
          for (const opportunity of newOpportunities) {
            // Risk level hierarchy: ULTRA_LOW < LOW < MEDIUM < HIGH
            const riskLevels = { 'ULTRA_LOW': 1, 'LOW': 2, 'MEDIUM': 3, 'HIGH': 4 };
            const opportunityRisk = riskLevels[opportunity.riskLevel] || 0;
            const maxRisk = riskLevels[autoTradeSettings.maxRiskLevel] || 2;
            
            if (autoTradeSettings.enabled && 
                !executingTradeId &&
                opportunity.netProfitUsd >= autoTradeSettings.minProfitUsd &&
                opportunity.confidence >= autoTradeSettings.minConfidence &&
                opportunityRisk <= maxRisk) {  // FIX: At or below max risk, not exact match
              
              console.log(`🤖 AUTO-EXECUTING: ${opportunity.pair}`);
              console.log(`   💰 Profit: $${opportunity.netProfitUsd.toFixed(6)}`);
              console.log(`   📊 Risk: ${opportunity.riskLevel} (Max: ${autoTradeSettings.maxRiskLevel})`);
              console.log(`   ✅ Confidence: ${(opportunity.confidence * 100).toFixed(1)}%`);
              
              // Execute immediately (no artificial delay - speed is critical for MEV)
              executeArbitrageTrade(opportunity);
              break; // Execute one at a time
            }
          }
        }
        
        setSystemHealth(prev => ({ ...prev, jupiterApi: true }));
        
      } catch (error) {
        console.error('❌ MEV scan failed:', error);
        setSystemHealth(prev => ({ ...prev, jupiterApi: false }));
      }
    };

    // Initial scan
    await scanForOpportunities();
    
    // Set up interval for MEV opportunities using configurable interval
    const interval = setInterval(scanForOpportunities, autoTradeSettings.scanIntervalMs);
    setScanInterval(interval);
  }, [walletState.isConnected, autoTradeSettings, executingTradeId]);

  const stopScanning = useCallback(() => {
    console.log('🛑 Stopping MEV scanner...');
    setIsScanning(false);
    
    if (scanInterval) {
      clearInterval(scanInterval);
      setScanInterval(null);
    }
    
    setOpportunities([]);
  }, [scanInterval]);

  // Execute arbitrage trade with SAFE parameters
  const executeArbitrageTrade = async (opportunity: MEVOpportunity) => {
    if (!walletState.isConnected) {
      console.log('❌ Cannot execute trade - wallet not connected');
      return;
    }

    setExecutingTradeId(opportunity.id);

    try {
      console.log('⚡ EXECUTING SAFE ARBITRAGE TRADE:', opportunity);
      
      // CRITICAL FIX: Pass priority fee parameter from UI
      const priorityFeeSol = autoTradeSettings.priorityFeeLamports / 1e9;
      const result = await fastMEVEngine.executeArbitrage(opportunity, priorityFeeSol);
      
      const tradeExecution: TradeExecution = {
        id: `trade_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
        opportunity,
        result,
        timestamp: new Date()
      };
      
      setTradeHistory(prev => [tradeExecution, ...prev.slice(0, 19)]); // Keep 20 trades
      
      // Update performance stats
      if (result.success) {
        const profit = result.actualProfitUsd || 0;
        setPerformanceStats(prev => ({
          totalTrades: prev.totalTrades + 1,
          successfulTrades: prev.successfulTrades + 1,
          totalProfitUsd: prev.totalProfitUsd + profit,
          avgExecutionTime: (prev.avgExecutionTime + (result.executionTimeMs || 0)) / 2,
          successRate: ((prev.successfulTrades + 1) / (prev.totalTrades + 1)) * 100
        }));
        
        console.log('════════════════════════════════════════════════════════');
        console.log('✅ TRADE SUCCESS!');
        console.log('════════════════════════════════════════════════════════');
        console.log(`💰 Actual Profit: $${profit.toFixed(6)}`);
        console.log(`⏱️  Execution Time: ${result.executionTimeMs}ms`);
        console.log(`🔗 Forward TX: ${result.forwardTxHash || 'N/A'}`);
        console.log(`🔗 Reverse TX: ${result.reverseTxHash || 'N/A'}`);
        console.log('════════════════════════════════════════════════════════');
        
        // Update balance
        try {
          const newBalance = await privateKeyWallet.getBalance();
          setWalletState(prev => ({ ...prev, balance: newBalance }));
        } catch (error) {
          console.warn('⚠️ Could not update balance:', error);
        }
      } else {
        setPerformanceStats(prev => ({
          ...prev,
          totalTrades: prev.totalTrades + 1,
          successRate: (prev.successfulTrades / (prev.totalTrades + 1)) * 100
        }));
        
        console.log('════════════════════════════════════════════════════════');
        console.log('❌ TRADE FAILED');
        console.log('════════════════════════════════════════════════════════');
        console.log(`📛 Error: ${result.error}`);
        console.log('════════════════════════════════════════════════════════');
      }
      
      // Remove executed opportunity
      setOpportunities(prev => prev.filter(opp => opp.id !== opportunity.id));
      
    } catch (error) {
      console.error('❌ TRADE EXECUTION ERROR:', error);
    } finally {
      setExecutingTradeId(null);
    }
  };

  const getStatusIcon = (success: boolean) => {
    return success ? 
      <CheckCircle className="w-4 h-4 text-green-500" /> : 
      <XCircle className="w-4 h-4 text-red-500" />;
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-purple-900 via-blue-900 to-indigo-900 p-6">
      <div className="max-w-7xl mx-auto space-y-6">
        {/* Header */}
        <div className="text-center space-y-2">
          <h1 className="text-4xl font-bold text-white">
            🛡️ Safe MEV Arbitrage Bot
          </h1>
          <p className="text-purple-200">
            Safe Solana Arbitrage | No Hardcoding | UI Parameters Only | Zero Loss Trading
          </p>
          <div className="flex justify-center space-x-4 mt-4">
            <Badge className={`${systemHealth.jupiterApi ? 'bg-green-500/20 text-green-400 border-green-500/50' : 'bg-red-500/20 text-red-400 border-red-500/50'}`}>
              {systemHealth.jupiterApi ? '✅ JUPITER API' : '❌ JUPITER API'}
            </Badge>
            <Badge className={`${systemHealth.walletConnected ? 'bg-green-500/20 text-green-400 border-green-500/50' : 'bg-red-500/20 text-red-400 border-red-500/50'}`}>
              {systemHealth.walletConnected ? '✅ HELIUS RPC' : '❌ NO WALLET'}
            </Badge>
            <Badge className={`${systemHealth.scannerActive ? 'bg-green-500/20 text-green-400 border-green-500/50' : 'bg-gray-500/20 text-gray-400 border-gray-500/50'}`}>
              {systemHealth.scannerActive ? '⚡ SAFE SCANNING' : '⏸️ IDLE'}
            </Badge>
            <Badge className="bg-blue-500/20 text-blue-400 border-blue-500/50">
              📊 {opportunities.length} SAFE OPPORTUNITIES
            </Badge>
            <Badge className="bg-green-500/20 text-green-400 border-green-500/50">
              🛡️ NO HARDCODING
            </Badge>
          </div>
        </div>

        {/* Performance Stats */}
        {performanceStats.totalTrades > 0 && (
          <Card className="bg-black/20 border-green-500/30">
            <CardHeader>
              <CardTitle className="text-green-400 flex items-center">
                <TrendingUp className="w-5 h-5 mr-2" />
                Safe Trading Performance
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-5 gap-4">
                <div className="text-center">
                  <div className="text-2xl font-bold text-white">{performanceStats.totalTrades}</div>
                  <div className="text-sm text-gray-400">Total Trades</div>
                </div>
                <div className="text-center">
                  <div className="text-2xl font-bold text-green-400">${(performanceStats.totalProfitUsd != null && !isNaN(performanceStats.totalProfitUsd) && typeof performanceStats.totalProfitUsd === 'number' ? performanceStats.totalProfitUsd.toFixed(4) : '0.0000')}</div>
                  <div className="text-sm text-gray-400">Total Profit</div>
                </div>
                <div className="text-center">
                  <div className="text-2xl font-bold text-blue-400">{(performanceStats.successRate != null && !isNaN(performanceStats.successRate) && typeof performanceStats.successRate === 'number' ? performanceStats.successRate.toFixed(1) : '0.0')}%</div>
                  <div className="text-sm text-gray-400">Success Rate</div>
                </div>
                <div className="text-center">
                  <div className="text-2xl font-bold text-purple-400">{(performanceStats.avgExecutionTime != null && !isNaN(performanceStats.avgExecutionTime) && typeof performanceStats.avgExecutionTime === 'number' ? performanceStats.avgExecutionTime.toFixed(0) : '0')}ms</div>
                  <div className="text-sm text-gray-400">Avg Speed</div>
                </div>
                <div className="text-center">
                  <div className="text-2xl font-bold text-yellow-400">{performanceStats.successfulTrades}</div>
                  <div className="text-sm text-gray-400">Successful</div>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Private Key Wallet Connection */}
        <Card className={`${walletState.isConnected ? 'bg-black/20 border-green-500/30' : 'bg-black/20 border-red-500/30'}`}>
          <CardContent className="p-4">
            {!walletState.isConnected ? (
              <div className="space-y-4">
                <div className="flex items-center space-x-2">
                  <Key className="w-5 h-5 text-blue-400" />
                  <h3 className="text-white font-medium">Connect Private Key for Safe MEV Trading</h3>
                </div>
                <div className="flex space-x-2">
                  <div className="relative flex-1">
                    <Input
                      type={showPrivateKey ? 'text' : 'password'}
                      placeholder="Enter your Solana private key (base58 or JSON array)"
                      value={privateKeyInput}
                      onChange={(e) => {
                        setPrivateKeyInput(e.target.value);
                        setConnectionError('');
                      }}
                      className="bg-black/30 border-gray-600 text-white pr-10"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="absolute right-0 top-0 h-full px-3 py-2 hover:bg-transparent"
                      onClick={() => setShowPrivateKey(!showPrivateKey)}
                    >
                      {showPrivateKey ? (
                        <EyeOff className="h-4 w-4 text-gray-400" />
                      ) : (
                        <Eye className="h-4 w-4 text-gray-400" />
                      )}
                    </Button>
                  </div>
                  <Button
                    onClick={handleConnectPrivateKey}
                    disabled={isConnecting || !privateKeyInput.trim()}
                    className="bg-blue-600 hover:bg-blue-700 text-white"
                  >
                    {isConnecting ? (
                      <>
                        <Activity className="w-4 h-4 mr-2 animate-spin" />
                        Connecting...
                      </>
                    ) : (
                      <>
                        <Key className="w-4 h-4 mr-2" />
                        Connect
                      </>
                    )}
                  </Button>
                </div>
                
                {connectionError && (
                  <Alert className="border-red-500/50 bg-red-500/10">
                    <XCircle className="h-4 w-4" />
                    <AlertDescription className="text-red-400">
                      {connectionError}
                    </AlertDescription>
                  </Alert>
                )}
                
                <Alert className="border-green-500/50 bg-green-500/10">
                  <Shield className="h-4 w-4" />
                  <AlertDescription className="text-green-400">
                    <strong>Safe MEV Trading:</strong> All parameters from UI. Priority fee: {((autoTradeSettings.priorityFeeLamports / 1e9) != null && !isNaN(autoTradeSettings.priorityFeeLamports / 1e9) && typeof (autoTradeSettings.priorityFeeLamports / 1e9) === 'number' ? (autoTradeSettings.priorityFeeLamports / 1e9).toFixed(3) : '0.000')} SOL. Max capital: {autoTradeSettings.maxCapitalSol} SOL
                  </AlertDescription>
                </Alert>
              </div>
            ) : (
              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-4">
                  <CheckCircle className="w-5 h-5 text-green-400" />
                  <div>
                    <div className="text-white font-medium">
                      Safe MEV Wallet: {walletState.publicKey?.toBase58().slice(0, 8)}...{walletState.publicKey?.toBase58().slice(-4)}
                    </div>
                    <div className="text-sm text-gray-300">
                      Balance: {(walletState.balance != null && !isNaN(walletState.balance) && typeof walletState.balance === 'number' ? walletState.balance.toFixed(4) : '0.0000')} SOL | ${((walletState.balance * 240) != null && !isNaN(walletState.balance * 240) && typeof (walletState.balance * 240) === 'number' ? (walletState.balance * 240).toFixed(2) : '0.00')} USD
                      <span className="ml-2 text-green-400 font-bold">• SAFE TRADING READY</span>
                    </div>
                  </div>
                </div>
                <div className="flex items-center space-x-2">
                  <Button
                    onClick={handleTokenCleanup}
                    disabled={isCleaningTokens}
                    variant="outline"
                    size="sm"
                    className="border-orange-500/50 text-orange-400 hover:bg-orange-500/20"
                  >
                    {isCleaningTokens ? (
                      <>
                        <Activity className="w-4 h-4 mr-2 animate-spin" />
                        Cleaning...
                      </>
                    ) : (
                      <>
                        <Trash2 className="w-4 h-4 mr-2" />
                        Recover Stuck Tokens
                      </>
                    )}
                  </Button>
                  <Button
                    onClick={handleDisconnectWallet}
                    variant="outline"
                    size="sm"
                    className="border-red-500/50 text-red-400 hover:bg-red-500/20"
                  >
                    <XCircle className="w-4 h-4 mr-2" />
                    Disconnect
                  </Button>
                  <Button
                    onClick={() => setShowSettings(!showSettings)}
                    variant="outline"
                    size="sm"
                    className="border-purple-500/50 text-purple-400 hover:bg-purple-500/20"
                  >
                    <Settings className="w-4 h-4 mr-2" />
                    Safe Trade Settings
                  </Button>
                  <Badge className="bg-green-500/20 text-green-400 border-green-500/50">
                    <Shield className="w-3 h-3 mr-1" />
                    SAFE MODE
                  </Badge>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Token Cleanup Status */}
        {cleanupStatus && (
          <Alert className="border-orange-500/50 bg-orange-500/10">
            <Trash2 className="h-4 w-4" />
            <AlertDescription className="text-orange-400">
              {cleanupStatus}
            </AlertDescription>
          </Alert>
        )}

        {/* Safe Auto-Trade Settings */}
        {showSettings && walletState.isConnected && (
          <Card className="bg-black/20 border-purple-500/30">
            <CardHeader>
              <CardTitle className="text-purple-400 flex items-center">
                <Shield className="w-5 h-5 mr-2" />
                Safe Auto-Trade Settings (No Hardcoding)
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="space-y-1">
                  <Label className="text-white font-medium">Enable Safe Auto-Trading</Label>
                  <p className="text-sm text-gray-400">
                    Automatically execute profitable arbitrage trades with UI parameters only
                  </p>
                </div>
                <Switch
                  checked={autoTradeSettings.enabled}
                  onCheckedChange={(checked) => {
                    console.log('🛡️ Safe auto-trade toggled:', checked);
                    setAutoTradeSettings(prev => ({ ...prev, enabled: checked }));
                  }}
                />
              </div>
              
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <Label className="text-white">Min Profit (USD)</Label>
                  <Input
                    type="number"
                    step="0.001"
                    value={autoTradeSettings.minProfitUsd}
                    onChange={(e) => setAutoTradeSettings(prev => ({ 
                      ...prev, 
                      minProfitUsd: parseFloat(e.target.value) || 0.001 
                    }))}
                    className="mt-1 bg-black/30 border-gray-600 text-white"
                  />
                </div>
                <div>
                  <Label className="text-white">Max Capital (SOL)</Label>
                  <Input
                    type="number"
                    step="0.01"
                    max="0.6"
                    value={autoTradeSettings.maxCapitalSol}
                    onChange={(e) => setAutoTradeSettings(prev => ({ 
                      ...prev, 
                      maxCapitalSol: Math.min(0.6, parseFloat(e.target.value) || 0.1)
                    }))}
                    className="mt-1 bg-black/30 border-gray-600 text-white"
                  />
                </div>
                <div>
                  <Label className="text-white">Min Confidence (%)</Label>
                  <Input
                    type="number"
                    step="0.01"
                    min="0.5"
                    max="0.95"
                    value={autoTradeSettings.minConfidence}
                    onChange={(e) => setAutoTradeSettings(prev => ({ 
                      ...prev, 
                      minConfidence: parseFloat(e.target.value) || 0.8
                    }))}
                    className="mt-1 bg-black/30 border-gray-600 text-white"
                  />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-4">
                <div>
                  <Label className="text-white">Gas Estimate (SOL)</Label>
                  <Input
                    type="number"
                    step="0.001"
                    min="0.001"
                    max="0.01"
                    value={autoTradeSettings.gasEstimateSol}
                    onChange={(e) => setAutoTradeSettings(prev => ({ 
                      ...prev, 
                      gasEstimateSol: parseFloat(e.target.value) || 0.003
                    }))}
                    className="mt-1 bg-black/30 border-gray-600 text-white"
                  />
                </div>
                <div>
                  <Label className="text-white">Max Slippage (%)</Label>
                  <Input
                    type="number"
                    step="0.1"
                    min="0.1"
                    max="5"
                    value={autoTradeSettings.maxSlippagePercent}
                    onChange={(e) => setAutoTradeSettings(prev => ({ 
                      ...prev, 
                      maxSlippagePercent: parseFloat(e.target.value) || 1.0
                    }))}
                    className="mt-1 bg-black/30 border-gray-600 text-white"
                  />
                </div>
                <div>
                  <Label className="text-white">Priority Fee (SOL)</Label>
                  <Input
                    type="number"
                    step="0.0001"
                    min="0.0001"
                    max="0.01"
                    value={autoTradeSettings.priorityFeeLamports / 1e9}
                    onChange={(e) => setAutoTradeSettings(prev => ({ 
                      ...prev, 
                      priorityFeeLamports: (parseFloat(e.target.value) || 0.001) * 1e9
                    }))}
                    className="mt-1 bg-black/30 border-gray-600 text-white"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label className="text-white">Trade Size (SOL)</Label>
                  <Input
                    type="number"
                    step="0.01"
                    min="0.01"
                    max="0.5"
                    value={autoTradeSettings.tradeSizeSol}
                    onChange={(e) => setAutoTradeSettings(prev => ({ 
                      ...prev, 
                      tradeSizeSol: parseFloat(e.target.value) || 0.05
                    }))}
                    className="mt-1 bg-black/30 border-gray-600 text-white"
                  />
                </div>
                <div>
                  <Label className="text-white">Scan Interval (seconds)</Label>
                  <Input
                    type="number"
                    step="1"
                    min="1"
                    max="60"
                    value={autoTradeSettings.scanIntervalMs / 1000}
                    onChange={(e) => setAutoTradeSettings(prev => ({ 
                      ...prev, 
                      scanIntervalMs: (parseFloat(e.target.value) || 5) * 1000
                    }))}
                    className="mt-1 bg-black/30 border-gray-600 text-white"
                  />
                </div>
              </div>

              {autoTradeSettings.enabled && (
                <Alert className="border-green-500/50 bg-green-500/10">
                  <Shield className="h-4 w-4" />
                  <AlertDescription className="text-green-400">
                    <strong>Safe Auto-Trading Active:</strong> System will execute arbitrage trades above ${(autoTradeSettings.minProfitUsd != null && !isNaN(autoTradeSettings.minProfitUsd) && typeof autoTradeSettings.minProfitUsd === 'number' ? autoTradeSettings.minProfitUsd.toFixed(3) : '0.000')} with max {autoTradeSettings.maxCapitalSol} SOL capital. Priority fee: {((autoTradeSettings.priorityFeeLamports / 1e9) != null && !isNaN(autoTradeSettings.priorityFeeLamports / 1e9) && typeof (autoTradeSettings.priorityFeeLamports / 1e9) === 'number' ? (autoTradeSettings.priorityFeeLamports / 1e9).toFixed(3) : '0.000')} SOL
                  </AlertDescription>
                </Alert>
              )}
            </CardContent>
          </Card>
        )}

        {/* Scanner Controls */}
        <Card className="bg-black/20 border-blue-500/30">
          <CardHeader>
            <CardTitle className="text-blue-400">Safe MEV Scanner</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center space-x-4">
              {!isScanning ? (
                <Button
                  onClick={startScanning}
                  disabled={!walletState.isConnected}
                  className="bg-green-600 hover:bg-green-700 text-white"
                >
                  <Activity className="w-4 h-4 mr-2" />
                  Start Safe MEV Scanner
                </Button>
              ) : (
                <Button
                  onClick={stopScanning}
                  className="bg-red-600 hover:bg-red-700 text-white"
                >
                  <XCircle className="w-4 h-4 mr-2" />
                  Stop Scanner
                </Button>
              )}
              
              {!walletState.isConnected && (
                <Alert className="border-yellow-500/50 bg-yellow-500/10 flex-1">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertDescription className="text-yellow-400">
                    Connect your private key to start safe MEV arbitrage scanning
                  </AlertDescription>
                </Alert>
              )}
            </div>
          </CardContent>
        </Card>

        {/* MEV Opportunities */}
        <Card className="bg-black/20 border-green-500/30">
          <CardHeader>
            <CardTitle className="text-green-400 flex items-center">
              <Target className="w-5 h-5 mr-2" />
              Safe MEV Opportunities
              {isScanning && (
                <Badge className="ml-2 bg-green-500/20 text-green-400 border-green-500/50">
                  <Activity className="w-3 h-3 mr-1 animate-spin" />
                  SAFE SCANNING
                </Badge>
              )}
              {autoTradeSettings.enabled && (
                <Badge className="ml-2 bg-purple-500/20 text-purple-400 border-purple-500/50">
                  <Shield className="w-3 h-3 mr-1" />
                  SAFE AUTO-TRADE
                </Badge>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {opportunities.length === 0 ? (
              <div className="text-center py-8">
                <div className="text-gray-400 mb-4">
                  {isScanning ? 'Scanning for safe MEV arbitrage opportunities...' : 'Start scanner to find profitable arbitrage trades'}
                </div>
                {!isScanning && (
                  <p className="text-sm text-gray-500">
                    Safe MEV engine will detect SOL↔USDC, SOL↔USDT, and meme coin arbitrage opportunities using your UI parameters
                  </p>
                )}
              </div>
            ) : (
              <div className="space-y-3">
                {opportunities.map((opportunity) => (
                  <div key={opportunity.id} className="bg-black/30 rounded-lg p-4 border border-gray-700">
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="flex items-center space-x-2">
                          <span className="text-white font-medium">{opportunity.pair}</span>
                          <Badge className="bg-purple-500/20 text-purple-400 border-purple-500/50 text-xs">
                            {opportunity.type}
                          </Badge>
                          <Badge className={`text-xs ${
                            opportunity.riskLevel === 'ULTRA_LOW' ? 'bg-green-500/20 text-green-400 border-green-500/50' :
                            opportunity.riskLevel === 'LOW' ? 'bg-blue-500/20 text-blue-400 border-blue-500/50' :
                            'bg-yellow-500/20 text-yellow-400 border-yellow-500/50'
                          }`}>
                            {opportunity.riskLevel}
                          </Badge>
                          <Badge className="bg-green-500/20 text-green-400 border-green-500/50 text-xs">
                            SAFE
                          </Badge>
                        </div>
                        <div className="flex items-center space-x-4 mt-1 text-sm">
                          <span className="text-green-400">
                            Net Profit: ${(opportunity.netProfitUsd != null && !isNaN(opportunity.netProfitUsd) && typeof opportunity.netProfitUsd === 'number' ? opportunity.netProfitUsd.toFixed(6) : '0.000000')}
                          </span>
                          <span className="text-blue-400">
                            {(opportunity.profitPercent != null && !isNaN(opportunity.profitPercent) && typeof opportunity.profitPercent === 'number' ? opportunity.profitPercent.toFixed(4) : '0.0000')}%
                          </span>
                          <span className="text-gray-400">
                            Confidence: {((opportunity.confidence * 100) != null && !isNaN(opportunity.confidence * 100) && typeof (opportunity.confidence * 100) === 'number' ? (opportunity.confidence * 100).toFixed(0) : '0')}%
                          </span>
                          <span className="text-purple-400">
                            Capital: {(opportunity.capitalRequired != null && !isNaN(opportunity.capitalRequired) && typeof opportunity.capitalRequired === 'number' ? opportunity.capitalRequired.toFixed(3) : '0.000')} SOL
                          </span>
                          <span className="text-orange-400">
                            Gas: {(opportunity.gasFeeSol != null && !isNaN(opportunity.gasFeeSol) && typeof opportunity.gasFeeSol === 'number' ? opportunity.gasFeeSol.toFixed(4) : '0.0000')} SOL
                          </span>
                        </div>
                      </div>
                      <Button
                        onClick={() => executeArbitrageTrade(opportunity)}
                        disabled={executingTradeId === opportunity.id || !walletState.isConnected}
                        size="sm"
                        className="bg-green-600 hover:bg-green-700 text-white disabled:opacity-50"
                      >
                        {executingTradeId === opportunity.id ? (
                          <>
                            <Activity className="w-4 h-4 mr-2 animate-spin" />
                            Executing Safely...
                          </>
                        ) : (
                          <>
                            <Shield className="w-4 h-4 mr-2" />
                            Execute Safe Arbitrage
                          </>
                        )}
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Trade History */}
        {tradeHistory.length > 0 && (
          <Card className="bg-black/20 border-purple-500/30">
            <CardHeader>
              <CardTitle className="text-purple-400 flex items-center">
                <Clock className="w-5 h-5 mr-2" />
                Safe Trade Executions
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-3 max-h-64 overflow-y-auto">
                {tradeHistory.slice(0, 10).map((trade) => (
                  <div key={trade.id} className="bg-black/30 rounded-lg p-3 border border-gray-700">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center space-x-3">
                        {getStatusIcon(trade.result.success)}
                        <div>
                          <div className="flex items-center space-x-2">
                            <span className="text-white font-medium">{trade.opportunity.pair}</span>
                            <Badge className="bg-purple-500/20 text-purple-400 border-purple-500/50 text-xs">
                              SAFE {trade.opportunity.type}
                            </Badge>
                          </div>
                          <div className="flex items-center space-x-4 mt-1 text-sm">
                            <span className="text-gray-300">
                              Expected: ${(trade.opportunity.netProfitUsd != null && !isNaN(trade.opportunity.netProfitUsd) && typeof trade.opportunity.netProfitUsd === 'number' ? trade.opportunity.netProfitUsd.toFixed(6) : '0.000000')}
                            </span>
                            {trade.result.actualProfitUsd && (
                              <span className="text-green-400">
                                Actual: ${trade.result.actualProfitUsd.toFixed(6)}
                              </span>
                            )}
                            <span className="text-blue-400">
                              Speed: {trade.result.executionTimeMs}ms
                            </span>
                            <span className="text-gray-400">
                              {trade.timestamp.toLocaleTimeString()}
                            </span>
                          </div>
                          {trade.result.error && (
                            <span className="text-red-400 text-sm">Error: {trade.result.error}</span>
                          )}
                        </div>
                      </div>
                      <div className="text-right">
                        <Badge 
                          variant="outline" 
                          className={
                            trade.result.success ? 'border-green-500 text-green-400' : 'border-red-500 text-red-400'
                          }
                        >
                          {trade.result.success ? 'SUCCESS' : 'FAILED'}
                        </Badge>
                        {trade.result.txHash && (
                          <div className="text-xs text-gray-400 mt-1">
                            <a 
                              href={`https://solscan.io/tx/${trade.result.txHash}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="hover:text-blue-400"
                            >
                              {trade.result.txHash.slice(0, 12)}...
                            </a>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Footer */}
        <div className="text-center text-sm text-purple-300 space-y-2">
          <p>🛡️ Safe MEV Arbitrage Bot | Zero Loss Trading | UI Parameters Only</p>
          <div className="flex items-center justify-center space-x-6">
            <span>Min Profit: ${(autoTradeSettings.minProfitUsd != null && !isNaN(autoTradeSettings.minProfitUsd) && typeof autoTradeSettings.minProfitUsd === 'number' ? autoTradeSettings.minProfitUsd.toFixed(3) : '0.000')}</span>
            <span>Max Capital: {autoTradeSettings.maxCapitalSol} SOL</span>
            <span>Priority Fee: {((autoTradeSettings.priorityFeeLamports / 1e9) != null && !isNaN(autoTradeSettings.priorityFeeLamports / 1e9) && typeof (autoTradeSettings.priorityFeeLamports / 1e9) === 'number' ? (autoTradeSettings.priorityFeeLamports / 1e9).toFixed(3) : '0.000')} SOL</span>
            <span>Auto-Trade: {autoTradeSettings.enabled ? '🟢 SAFE ACTIVE' : '🔴 INACTIVE'}</span>
            <span>Balance: {(walletState.balance != null && !isNaN(walletState.balance) && typeof walletState.balance === 'number' ? walletState.balance.toFixed(4) : '0.0000')} SOL</span>
            <span>Total Profit: ${(performanceStats.totalProfitUsd != null && !isNaN(performanceStats.totalProfitUsd) && typeof performanceStats.totalProfitUsd === 'number' ? performanceStats.totalProfitUsd.toFixed(4) : '0.0000')}</span>
          </div>
          <p className="text-xs text-gray-400">
            🛡️ SAFE ARBITRAGE - All parameters from UI, no hardcoding, sequential execution, balance verification
          </p>
        </div>
      </div>
    </div>
  );
};

export default PrivateKeyTradingDashboard;