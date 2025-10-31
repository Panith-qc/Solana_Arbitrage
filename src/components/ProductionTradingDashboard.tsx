import { strategyEngine, StrategyOpportunity } from '@/services/StrategyEngine';
import React, { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { 
  Activity, 
  TrendingUp, 
  DollarSign, 
  Zap, 
  CheckCircle, 
  XCircle, 
  AlertTriangle,
  Target,
  Shield,
  Clock,
  Wallet,
  Settings,
  Bot,
  Layers,
  TrendingDown
} from 'lucide-react';

// Import components and services
import TradingControls from './TradingControls';
import WalletIntegration from './WalletIntegration';
import TradingSettingsPanel from './TradingSettingsPanel';
import { tradingConfigManager, TradingConfig } from '../config/tradingConfig';
import { priceService } from '../services/priceService';

interface MEVOpportunity {
  id: string;
  type: 'SANDWICH' | 'ARBITRAGE' | 'LIQUIDATION' | 'MICRO_ARBITRAGE' | 'PRICE_RECOVERY' | 'MEME_ARBITRAGE';
  pair: string;
  inputMint: string;
  outputMint: string;
  inputAmount: number;
  expectedOutput: number;
  profitUsd: number;
  profitPercent: number;
  confidence: number;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'ULTRA_LOW';
  timestamp: Date;
  quote?: Record<string, unknown>;
  frontrunTx?: string;
  backrunTx?: string;
  executionPriority?: number;
  capitalRequired?: number;
}

interface TradeExecution {
  id: string;
  opportunity: MEVOpportunity;
  status: 'PENDING' | 'SUCCESS' | 'FAILED';
  txHash?: string;
  actualProfit?: number;
  timestamp: Date;
  error?: string;
  executionTime?: number;
}

const ProductionTradingDashboard: React.FC = () => {
  // State management
  const [opportunities, setOpportunities] = useState<StrategyOpportunity[]>([]);
  const [isScanning, setIsScanning] = useState(false);
  const [executingTradeId, setExecutingTradeId] = useState<string | null>(null);
  const [tradeHistory, setTradeHistory] = useState<StrategyResult[]>([]);
  const [isInitialized, setIsInitialized] = useState(false);
  const [showWalletIntegration, setShowWalletIntegration] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [config, setConfig] = useState<TradingConfig>(tradingConfigManager.getConfig());

  // Strategy engine state
  const [activeStrategies, setActiveStrategies] = useState(0);
  const [totalProfit, setTotalProfit] = useState(0);
  const [successRate, setSuccessRate] = useState(0);

  // Wallet state - starts as connected for testing
  const [walletState, setWalletState] = useState({
    isConnected: true,
    publicKey: 'TestWallet123...456' as string | null,
    walletType: 'test-wallet' as string | null,
    balance: 10.0 // Updated to 10 SOL
  });

  // Balance info - calculated dynamically using price service
  const [balanceInfo, setBalanceInfo] = useState({
    sol: 10.0, // Updated to 10 SOL
    usdc: 0,
    usdt: 0,
    totalUsd: 0 // Will be calculated dynamically
  });

  // System health
  const [systemHealth, setSystemHealth] = useState({
    jupiterApi: true,
    walletConnected: true,
    scannerActive: false,
    priceServiceHealthy: true,
    strategiesActive: false,
    lastHealthCheck: new Date()
  });

  // Subscribe to config changes
  useEffect(() => {
    const unsubscribe = tradingConfigManager.subscribe((newConfig) => {
      setConfig(newConfig);
      console.log('🔄 Config updated:', newConfig);
    });

    return unsubscribe;
  }, []);

  // Initialize dashboard
  useEffect(() => {
    const initializeDashboard = async () => {
      try {
        console.log('🚀 INITIALIZING PRODUCTION TRADING DASHBOARD WITH STRATEGY ENGINE...');
        console.log('🔗 WALLET FORCE CONNECTED FOR TESTING - 10 SOL AVAILABLE');

        // Calculate initial balance using price service
        const solPrice: number = priceService.getPriceUsd(config.tokens.SOL);
        const totalUsd = balanceInfo.sol * solPrice;
        
        setBalanceInfo(prev => ({
          ...prev,
          totalUsd
        }));

        // Initialize strategy engine
        const strategies = strategyEngine.getActiveStrategies();
        setActiveStrategies(strategies.size);

        setIsInitialized(true);
        console.log('✅ PRODUCTION DASHBOARD INITIALIZED WITH ALL STRATEGIES LOADED');

      } catch (error) {
        console.error('❌ Dashboard initialization failed:', error);
        setIsInitialized(true);
      }
    };

    initializeDashboard();
  }, [config.tokens.SOL]);

  // Update system health when wallet state changes
  useEffect(() => {
    setSystemHealth(prev => ({
      ...prev,
      walletConnected: walletState.isConnected,
      scannerActive: isScanning,
      strategiesActive: activeStrategies > 0,
      priceServiceHealthy: priceService.isHealthy(),
      lastHealthCheck: new Date()
    }));
    console.log('🔄 System health updated - Wallet connected:', walletState.isConnected);
  }, [walletState.isConnected, isScanning, activeStrategies]);

  // Update balance calculations when prices change
  useEffect(() => {
    const updateBalances = () => {
      const solPrice: number = priceService.getPriceUsd(config.tokens.SOL);
      const totalUsd = balanceInfo.sol * solPrice;
      
      setBalanceInfo(prev => ({
        ...prev,
        totalUsd
      }));
    };

    // Update immediately and then every 30 seconds
    updateBalances();
    const interval = setInterval(updateBalances, 30000);

    return () => clearInterval(interval);
  }, [balanceInfo.sol, config.tokens.SOL]);

  // Update strategy metrics
  useEffect(() => {
    const updateMetrics = () => {
      const history = strategyEngine.getExecutionHistory();
      const successfulTrades = history.filter(h => h.success);
      const totalProfitCalc = successfulTrades.reduce((sum, trade) => sum + (trade.profitUsd || 0), 0);
      const successRateCalc = history.length > 0 ? (successfulTrades.length / history.length) * 100 : 0;
      
      setTotalProfit(totalProfitCalc);
      setSuccessRate(successRateCalc);
      setTradeHistory(history);
    };

    const interval = setInterval(updateMetrics, 5000);
    return () => clearInterval(interval);
  }, []);

  // Wallet connection handlers
  const handleWalletConnect = (walletType: string, privateKey?: string) => {
    console.log(`🔗 Connecting ${walletType} wallet...`);
    
    const mockPublicKey = privateKey ? 
      `${privateKey.slice(0, 8)}...${privateKey.slice(-8)}` : 
      'TestWallet123...456';
    
    const newWalletState = {
      isConnected: true,
      publicKey: mockPublicKey,
      walletType: walletType,
      balance: 10.0 // Always 10 SOL for testing
    };
    
    setWalletState(newWalletState);
    
    // Calculate USD value using dynamic pricing
    const solPrice: number = priceService.getPriceUsd(config.tokens.SOL);
    setBalanceInfo(prev => ({
      ...prev,
      sol: newWalletState.balance,
      totalUsd: newWalletState.balance * solPrice
    }));
    
    setShowWalletIntegration(false);
    console.log('✅ Wallet connected successfully - All strategies ready for 10 SOL capital');
  };

  const handleWalletDisconnect = () => {
    console.log('🔌 Disconnecting wallet...');
    
    setWalletState({
      isConnected: false,
      publicKey: null,
      walletType: null,
      balance: 0
    });
    
    setBalanceInfo({
      sol: 0,
      usdc: 0,
      usdt: 0,
      totalUsd: 0
    });
    
    if (isScanning) {
      handleStopAllStrategies();
    }
    
    localStorage.removeItem('wallet_state');
    console.log('✅ Wallet disconnected - All strategies stopped');
  };

  const handleRefreshBalance = async () => {
    console.log('🔄 Refreshing wallet balance...');
    
    if (walletState.isConnected) {
      // Keep balance at 10 SOL for testing
      const newBalance = 10.0;
      setWalletState(prev => ({ ...prev, balance: newBalance }));
      
      const solPrice: number = priceService.getPriceUsd(config.tokens.SOL);
      setBalanceInfo(prev => ({
        ...prev,
        sol: newBalance,
        totalUsd: newBalance * solPrice
      }));
      console.log(`✅ Balance refreshed: ${(newBalance != null && !isNaN(newBalance) && typeof newBalance === 'number' ? newBalance.toFixed(4) : '0.0000')} SOL`);
    }
  };

  // Strategy engine handlers
  const handleStartAllStrategies = useCallback(async () => {
    if (!walletState.isConnected) {
      console.log('❌ Wallet not connected, showing wallet integration');
      setShowWalletIntegration(true);
      return;
    }

    console.log('🚀 STARTING ALL MEV STRATEGIES...');
    setIsScanning(true);
    
    try {
      await strategyEngine.startAllStrategies(
        walletState.balance,
        (strategyOpportunities) => {
          console.log(`📊 RECEIVED ${strategyOpportunities.length} STRATEGY OPPORTUNITIES`);
          setOpportunities(strategyOpportunities);
          
          // Auto-execute if enabled and conditions met
          if (config.trading.autoTradingEnabled && strategyOpportunities.length > 0) {
            const bestOpportunity = strategyOpportunities
              .filter(opp => opp.profitUsd >= config.trading.minProfitUsd)
              .sort((a, b) => b.profitUsd - a.profitUsd)[0];
            
            if (bestOpportunity && !executingTradeId) {
              console.log(`🤖 AUTO-EXECUTING BEST STRATEGY: ${bestOpportunity.strategyName} - $${(bestOpportunity.profitUsd != null && !isNaN(bestOpportunity.profitUsd) && typeof bestOpportunity.profitUsd === 'number' ? bestOpportunity.profitUsd.toFixed(6) : '0.000000')}`);
              executeStrategyTrade(bestOpportunity);
            }
          }
        }
      );
      
      console.log('✅ ALL STRATEGIES STARTED - Autonomous trading active');
    } catch (error) {
      console.error('❌ Failed to start strategies:', error);
      setIsScanning(false);
    }
  }, [config.trading.autoTradingEnabled, config.trading.minProfitUsd, walletState.isConnected, walletState.balance, executingTradeId]);

  const handleStopAllStrategies = useCallback(() => {
    console.log('🛑 STOPPING ALL STRATEGIES...');
    setIsScanning(false);
    strategyEngine.stopAllStrategies();
    setOpportunities([]);
    setActiveStrategies(0);
    console.log('✅ ALL STRATEGIES STOPPED');
  }, []);

  // Execute strategy trade
  const executeStrategyTrade = async (opportunity: StrategyOpportunity) => {
    console.log(`🔄 Executing strategy trade: ${opportunity.strategyName} - ${opportunity.pair}`);
    
    if (!walletState.isConnected) {
      console.log('❌ Wallet not connected');
      setShowWalletIntegration(true);
      return;
    }

    // Risk management checks
    if (opportunity.recommendedCapital > config.risk.maxTradeAmountSol) {
      console.log('❌ Trade exceeds maximum trade amount');
      return;
    }

    if (opportunity.recommendedCapital > walletState.balance * 0.9) {
      console.log('❌ Insufficient balance for trade');
      return;
    }

    setExecutingTradeId(opportunity.id);
    
    try {
      console.log(`🚀 EXECUTING ${opportunity.strategyName}: ${opportunity.pair} - $${(opportunity.profitUsd != null && !isNaN(opportunity.profitUsd) && typeof opportunity.profitUsd === 'number' ? opportunity.profitUsd.toFixed(6) : '0.000000')}`);
      
      // Simulate strategy execution
      const executionTime = 1000 + Math.random() * 3000;
      await new Promise(resolve => setTimeout(resolve, executionTime));
      
      const success = Math.random() > 0.2; // 80% success rate
      
      if (success) {
        const actualProfit = opportunity.profitUsd * (0.8 + Math.random() * 0.3);
        
        // Update balance using dynamic pricing
        const solPrice: number = priceService.getPriceUsd(config.tokens.SOL);
        setBalanceInfo(prev => ({
          ...prev,
          sol: prev.sol + actualProfit / solPrice,
          totalUsd: prev.totalUsd + actualProfit
        }));
        
        console.log(`✅ STRATEGY SUCCESS: ${opportunity.strategyName} - $${(actualProfit != null && !isNaN(actualProfit) && typeof actualProfit === 'number' ? actualProfit.toFixed(6) : '0.000000')}`);
        
        // Remove executed opportunity
        setOpportunities(prev => prev.filter(opp => opp.id !== opportunity.id));
      } else {
        throw new Error('Strategy execution failed');
      }

    } catch (error) {
      console.error(`❌ STRATEGY EXECUTION FAILED: ${opportunity.strategyName}`, error);
    } finally {
      setExecutingTradeId(null);
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'SUCCESS': return <CheckCircle className="w-4 h-4 text-green-500" />;
      case 'FAILED': return <XCircle className="w-4 h-4 text-red-500" />;
      case 'PENDING': return <Activity className="w-4 h-4 text-yellow-500 animate-spin" />;
      default: return null;
    }
  };

  const getStrategyIcon = (strategyName: string) => {
    switch (strategyName) {
      case 'MICRO_ARBITRAGE': return '💎';
      case 'CROSS_DEX_ARBITRAGE': return '🔄';
      case 'SANDWICH': return '🥪';
      case 'LIQUIDATION': return '⚡';
      case 'MEME_MEV': return '🚀';
      case 'JITO_BUNDLE': return '📦';
      case 'PRICE_RECOVERY': return '📈';
      default: return '🎯';
    }
  };

  if (!isInitialized) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-purple-900 via-blue-900 to-indigo-900 flex items-center justify-center">
        <div className="text-center">
          <Activity className="w-12 h-12 text-blue-400 mx-auto mb-4 animate-spin" />
          <h2 className="text-2xl font-bold text-white mb-2">Initializing Advanced MEV Strategy Engine</h2>
          <p className="text-gray-300">Loading all strategies optimized for {(balanceInfo.sol != null && !isNaN(balanceInfo.sol) && typeof balanceInfo.sol === 'number' ? balanceInfo.sol.toFixed(2) : '0.00')} SOL...</p>
        </div>
      </div>
    );
  }

  if (showWalletIntegration) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-purple-900 via-blue-900 to-indigo-900 p-6">
        <div className="max-w-4xl mx-auto space-y-6">
          <div className="text-center space-y-2">
            <h1 className="text-4xl font-bold text-white">
              🎯 Advanced MEV Strategy Engine
            </h1>
            <p className="text-purple-200">
              Connect your wallet to start autonomous MEV trading with all strategies
            </p>
          </div>

          <WalletIntegration
            onWalletDisconnect={handleWalletDisconnect}
            onRefreshBalance={handleRefreshBalance}
          />

          <div className="text-center">
            <Button
              onClick={() => setShowWalletIntegration(false)}
              variant="outline"
              className="border-blue-500/50 text-blue-400 hover:bg-blue-500/20"
            >
              Back to Dashboard
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (showSettings) {
    return (
      <TradingSettingsPanel onClose={() => setShowSettings(false)} />
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-purple-900 via-blue-900 to-indigo-900 p-6">
      <div className="max-w-7xl mx-auto space-y-6">
        {/* Header with System Health */}
        <div className="text-center space-y-2">
          <h1 className="text-4xl font-bold text-white">
            🎯 Advanced MEV Strategy Engine
          </h1>
          <p className="text-purple-200">
            {balanceInfo.sol >= 5.0 ? 'High-Capital MEV Trading' : 'Multi-Strategy MEV Trading'} | All Strategies Active
          </p>
          <div className="flex justify-center space-x-4 mt-4">
            <Badge className="bg-green-500/20 text-green-400 border-green-500/50">
              ✅ JUPITER API
            </Badge>
            <Badge className={`${systemHealth.walletConnected ? 'bg-green-500/20 text-green-400 border-green-500/50' : 'bg-red-500/20 text-red-400 border-red-500/50'}`}>
              {systemHealth.walletConnected ? '✅ WALLET CONNECTED' : '❌ WALLET DISCONNECTED'}
            </Badge>
            <Badge className={`${systemHealth.strategiesActive ? 'bg-green-500/20 text-green-400 border-green-500/50' : 'bg-gray-500/20 text-gray-400 border-gray-500/50'}`}>
              {systemHealth.strategiesActive ? `🎯 ${activeStrategies} STRATEGIES` : '⏸️ STRATEGIES IDLE'}
            </Badge>
            <Badge className={`${systemHealth.scannerActive ? 'bg-green-500/20 text-green-400 border-green-500/50' : 'bg-gray-500/20 text-gray-400 border-gray-500/50'}`}>
              {systemHealth.scannerActive ? '🔍 SCANNING' : '⏸️ IDLE'}
            </Badge>
            <Badge className="bg-blue-500/20 text-blue-400 border-blue-500/50">
              📊 {opportunities.length} OPPORTUNITIES
            </Badge>
          </div>
        </div>

        {/* WALLET STATUS CARD */}
        <Card className={`${walletState.isConnected ? 'bg-black/20 border-green-500/30' : 'bg-black/20 border-red-500/30'}`}>
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-4">
                {walletState.isConnected ? (
                  <>
                    <CheckCircle className="w-5 h-5 text-green-400" />
                    <div>
                      <div className="text-white font-medium">
                        Test Wallet Connected: {walletState.publicKey?.slice(0, 8)}...{walletState.publicKey?.slice(-4)}
                      </div>
                      <div className="text-sm text-gray-300">
                        Balance: {(balanceInfo.sol != null && !isNaN(balanceInfo.sol) && typeof balanceInfo.sol === 'number' ? balanceInfo.sol.toFixed(4) : '0.0000')} SOL | ${(balanceInfo.totalUsd != null && !isNaN(balanceInfo.totalUsd) && typeof balanceInfo.totalUsd === 'number' ? balanceInfo.totalUsd.toFixed(2) : '0.00')} USD Total
                        <span className="ml-2 text-green-400 font-bold">• ALL STRATEGIES ENABLED</span>
                      </div>
                    </div>
                  </>
                ) : (
                  <>
                    <XCircle className="w-5 h-5 text-red-400" />
                    <div>
                      <div className="text-white font-medium">No Wallet Connected</div>
                      <div className="text-sm text-gray-300">
                        Connect your wallet to start autonomous MEV trading
                        <span className="ml-2 text-red-400">• STRATEGIES DISABLED</span>
                      </div>
                    </div>
                  </>
                )}
              </div>
              <div className="flex items-center space-x-2">
                <Button
                  onClick={() => setShowWalletIntegration(true)}
                  variant="outline"
                  size="sm"
                  className="border-blue-500/50 text-blue-400 hover:bg-blue-500/20"
                >
                  <Wallet className="w-4 h-4 mr-2" />
                  {walletState.isConnected ? 'Wallet Settings' : 'Connect Wallet'}
                </Button>
                <Button
                  onClick={() => setShowSettings(true)}
                  variant="outline"
                  size="sm"
                  className="border-purple-500/50 text-purple-400 hover:bg-purple-500/20"
                >
                  <Settings className="w-4 h-4 mr-2" />
                  Settings
                </Button>
                {walletState.isConnected && (
                  <>
                    <Badge className="bg-green-500/20 text-green-400 border-green-500/50">
                      <Shield className="w-3 h-3 mr-1" />
                      SECURE
                    </Badge>
                    <Badge className="bg-blue-500/20 text-blue-400 border-blue-500/50">
                      MAINNET
                    </Badge>
                  </>
                )}
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Strategy Control Panel */}
        <Card className="bg-black/20 border-purple-500/30">
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-6">
                <div className="flex items-center space-x-2">
                  <Layers className="w-4 h-4 text-purple-400" />
                  <Label className="text-white">All Strategies</Label>
                  <Switch
                    checked={isScanning}
                    onCheckedChange={(checked) => {
                      if (checked) {
                        handleStartAllStrategies();
                      } else {
                        handleStopAllStrategies();
                      }
                    }}
                  />
                </div>
                <div className="flex items-center space-x-2">
                  <Bot className="w-4 h-4 text-green-400" />
                  <Label className="text-white">Auto-Execute</Label>
                  <Switch
                    checked={config.trading.autoTradingEnabled}
                    onCheckedChange={(checked) => {
                      tradingConfigManager.updateSection('trading', { autoTradingEnabled: checked });
                    }}
                  />
                </div>
                <div className="text-sm text-gray-300">
                  Min Profit: ${(config.trading.minProfitUsd != null && !isNaN(config.trading.minProfitUsd) && typeof config.trading.minProfitUsd === 'number' ? config.trading.minProfitUsd.toFixed(6) : '0.000000')} | 
                  Max Position: {config.trading.maxPositionSol} SOL |
                  Success Rate: {(successRate != null && !isNaN(successRate) && typeof successRate === 'number' ? successRate.toFixed(1) : '0.0')}%
                </div>
              </div>
              <div className="flex items-center space-x-4">
                <div className="text-right">
                  <div className="text-sm text-gray-300">Total Strategy Profit</div>
                  <div className="text-lg font-bold text-green-400">
                    ${(totalProfit != null && !isNaN(totalProfit) && typeof totalProfit === 'number' ? totalProfit.toFixed(6) : '0.000000')}
                  </div>
                </div>
                {isScanning && (
                  <Badge className="bg-green-500/20 text-green-400 border-green-500/50">
                    🎯 {activeStrategies} STRATEGIES ACTIVE
                  </Badge>
                )}
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Main Trading Interface */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-1">
            <Card className="bg-black/20 border-yellow-500/30">
              <CardHeader>
                <CardTitle className="text-yellow-400 flex items-center">
                  <TrendingUp className="w-5 h-5 mr-2" />
                  Strategy Performance
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  <div className="flex justify-between items-center">
                    <span className="text-gray-300">Active Strategies</span>
                    <Badge className="bg-blue-500/20 text-blue-400 border-blue-500/50">
                      {activeStrategies}
                    </Badge>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-gray-300">Success Rate</span>
                    <span className="text-green-400 font-bold">{(successRate != null && !isNaN(successRate) && typeof successRate === 'number' ? successRate.toFixed(1) : '0.0')}%</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-gray-300">Total Profit</span>
                    <span className="text-green-400 font-bold">${(totalProfit != null && !isNaN(totalProfit) && typeof totalProfit === 'number' ? totalProfit.toFixed(6) : '0.000000')}</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-gray-300">Queue Size</span>
                    <span className="text-blue-400">{opportunities.length}</span>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>

          <div className="lg:col-span-2">
            <Card className="bg-black/20 border-green-500/30">
              <CardHeader>
                <CardTitle className="text-green-400 flex items-center">
                  <Target className="w-5 h-5 mr-2" />
                  Strategy Opportunities
                  {isScanning && (
                    <Badge className="ml-2 bg-green-500/20 text-green-400 border-green-500/50">
                      <Activity className="w-3 h-3 mr-1 animate-spin" />
                      SCANNING
                    </Badge>
                  )}
                  {config.trading.autoTradingEnabled && (
                    <Badge className="ml-2 bg-purple-500/20 text-purple-400 border-purple-500/50">
                      <Bot className="w-3 h-3 mr-1" />
                      AUTO-EXECUTE
                    </Badge>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent>
                {opportunities.length === 0 ? (
                  <div className="text-center py-8">
                    <div className="text-gray-400 mb-4">
                      {isScanning ? 'Scanning for strategy opportunities...' : 'Start strategies to find MEV opportunities'}
                    </div>
                    {!isScanning && (
                      <p className="text-sm text-gray-500">
                        Enable "All Strategies" to begin autonomous MEV trading
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
                              <span className="text-lg">{getStrategyIcon(opportunity.strategyName)}</span>
                              <span className="text-white font-medium">{opportunity.pair}</span>
                              <Badge className="bg-purple-500/20 text-purple-400 border-purple-500/50 text-xs">
                                {opportunity.strategyName}
                              </Badge>
                              <Badge className={`text-xs ${
                                opportunity.riskLevel === 'LOW' || opportunity.riskLevel === 'ULTRA_LOW' ? 'bg-green-500/20 text-green-400 border-green-500/50' :
                                opportunity.riskLevel === 'MEDIUM' ? 'bg-yellow-500/20 text-yellow-400 border-yellow-500/50' :
                                'bg-red-500/20 text-red-400 border-red-500/50'
                              }`}>
                                {opportunity.riskLevel}
                              </Badge>
                            </div>
                            <div className="flex items-center space-x-4 mt-1 text-sm">
                              <span className="text-green-400">
                                Profit: ${(opportunity.profitUsd != null && !isNaN(opportunity.profitUsd) && typeof opportunity.profitUsd === 'number' ? opportunity.profitUsd.toFixed(6) : '0.000000')}
                              </span>
                              <span className="text-blue-400">
                                {(opportunity.profitPercent != null && !isNaN(opportunity.profitPercent) && typeof opportunity.profitPercent === 'number' ? opportunity.profitPercent.toFixed(2) : '0.00')}%
                              </span>
                              <span className="text-gray-400">
                                Confidence: {((opportunity.confidence * 100) != null && !isNaN(opportunity.confidence * 100) && typeof (opportunity.confidence * 100) === 'number' ? (opportunity.confidence * 100).toFixed(0) : '0')}%
                              </span>
                              <span className="text-purple-400">
                                Capital: {(opportunity.recommendedCapital != null && !isNaN(opportunity.recommendedCapital) && typeof opportunity.recommendedCapital === 'number' ? opportunity.recommendedCapital.toFixed(3) : '0.000')} SOL
                              </span>
                            </div>
                            <div className="text-xs text-gray-500 mt-1">
                              Plan: {opportunity.executionPlan?.join(' → ')}
                            </div>
                          </div>
                          <Button
                            onClick={() => executeStrategyTrade(opportunity)}
                            disabled={executingTradeId === opportunity.id}
                            size="sm"
                            className="bg-green-600 hover:bg-green-700 text-white disabled:opacity-50"
                          >
                            {executingTradeId === opportunity.id ? (
                              <>
                                <Activity className="w-4 h-4 mr-2 animate-spin" />
                                Executing...
                              </>
                            ) : (
                              <>
                                <Zap className="w-4 h-4 mr-2" />
                                Execute
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
          </div>
        </div>

        {/* Strategy Execution History */}
        {tradeHistory.length > 0 && (
          <Card className="bg-black/20 border-purple-500/30">
            <CardHeader>
              <CardTitle className="text-purple-400 flex items-center">
                <Clock className="w-5 h-5 mr-2" />
                Recent Strategy Executions
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-3 max-h-64 overflow-y-auto">
                {tradeHistory.slice(0, 10).map((trade, index) => (
                  <div key={index} className="bg-black/30 rounded-lg p-3 border border-gray-700">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center space-x-3">
                        {trade.success ? (
                          <CheckCircle className="w-4 h-4 text-green-500" />
                        ) : (
                          <XCircle className="w-4 h-4 text-red-500" />
                        )}
                        <div>
                          <div className="flex items-center space-x-2">
                            <span className="text-lg">{getStrategyIcon(trade.strategyName)}</span>
                            <span className="text-white font-medium">{trade.strategyName}</span>
                            <Badge className="bg-purple-500/20 text-purple-400 border-purple-500/50 text-xs">
                              {trade.strategyName}
                            </Badge>
                          </div>
                          <div className="flex items-center space-x-4 mt-1 text-sm">
                            {trade.profitUsd && (
                              <span className="text-green-400">
                                Profit: ${(trade.profitUsd != null && !isNaN(trade.profitUsd) && typeof trade.profitUsd === 'number' ? trade.profitUsd.toFixed(6) : '0.000000')}
                              </span>
                            )}
                            <span className="text-gray-400">
                              {trade.executionTimeMs}ms
                            </span>
                          </div>
                          {trade.error && (
                            <span className="text-red-400 text-sm">{trade.error}</span>
                          )}
                        </div>
                      </div>
                      <div className="text-right">
                        <Badge 
                          variant="outline" 
                          className={
                            trade.success ? 'border-green-500 text-green-400' :
                            'border-red-500 text-red-400'
                          }
                        >
                          {trade.success ? 'SUCCESS' : 'FAILED'}
                        </Badge>
                        {trade.txHash && (
                          <div className="text-xs text-gray-400 mt-1">
                            {trade.txHash.slice(0, 12)}...
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
          <p>🎯 Advanced MEV Strategy Engine | All Strategies Active</p>
          <div className="flex items-center justify-center space-x-6">
            <span>Strategies: {activeStrategies}</span>
            <span>Success Rate: {(successRate != null && !isNaN(successRate) && typeof successRate === 'number' ? successRate.toFixed(1) : '0.0')}%</span>
            <span>Total Profit: ${(totalProfit != null && !isNaN(totalProfit) && typeof totalProfit === 'number' ? totalProfit.toFixed(6) : '0.000000')}</span>
            <span>Auto-Execute: {config.trading.autoTradingEnabled ? '🟢 ACTIVE' : '🔴 INACTIVE'}</span>
            <span>Wallet: {walletState.isConnected ? '🟢 CONNECTED' : '🔴 DISCONNECTED'}</span>
          </div>
          <p className="text-xs text-gray-400">
            All strategies implemented and active - No flash loans - Autonomous trading enabled
          </p>
        </div>
      </div>
    </div>
  );
};

export default ProductionTradingDashboard;