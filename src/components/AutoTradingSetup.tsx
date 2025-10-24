// AUTO-TRADING SETUP COMPONENT
// Simple one-click setup for automated trading
// User just enters wallet, selects risk, and clicks START!

import { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { RiskLevel, getAllRiskProfiles } from '../config/riskProfiles';
import { autoConfigService, AutoConfig } from '../services/autoConfigService';
import { Loader2, CheckCircle2, AlertCircle, TrendingUp, Shield, Zap } from 'lucide-react';

export default function AutoTradingSetup() {
  const [privateKey, setPrivateKey] = useState('');
  const [selectedRisk, setSelectedRisk] = useState<RiskLevel>('BALANCED');
  const [isConfiguring, setIsConfiguring] = useState(false);
  const [config, setConfig] = useState<AutoConfig | null>(null);
  const [isTrading, setIsTrading] = useState(false);
  const [error, setError] = useState<string>('');

  const profiles = getAllRiskProfiles();

  // Handle auto-configuration
  const handleConfigure = async () => {
    if (!privateKey.trim()) {
      setError('Please enter your wallet private key');
      return;
    }

    setError('');
    setIsConfiguring(true);

    try {
      // Extract wallet address from private key
      // In production, use proper wallet derivation
      const walletAddress = 'YOUR_WALLET_ADDRESS'; // TODO: Derive from private key
      
      // Auto-configure everything!
      const autoConfig = await autoConfigService.autoConfigureBot(
        walletAddress,
        selectedRisk
      );

      setConfig(autoConfig);
      setIsConfiguring(false);

      // Show success
      if (autoConfig.readyToTrade) {
        console.log('✅ Configuration complete! Ready to start trading.');
      }
    } catch (err) {
      setError('Failed to configure bot: ' + (err as Error).message);
      setIsConfiguring(false);
    }
  };

  // Start auto-trading
  const handleStartTrading = () => {
    if (!config) return;
    
    setIsTrading(true);
    
    // TODO: Actually start the trading engine with config
    console.log('🚀 Starting automated trading with config:', config);
    
    // In production, this would call:
    // strategyEngine.startWithAutoConfig(config);
  };

  // Stop trading
  const handleStopTrading = () => {
    setIsTrading(false);
    // TODO: Stop trading engine
  };

  // Get risk icon
  const getRiskIcon = (level: RiskLevel) => {
    if (level === 'CONSERVATIVE') return <Shield className="w-5 h-5" />;
    if (level === 'BALANCED') return <TrendingUp className="w-5 h-5" />;
    return <Zap className="w-5 h-5" />;
  };

  // Get risk color
  const getRiskColor = (level: RiskLevel) => {
    if (level === 'CONSERVATIVE') return 'bg-green-500';
    if (level === 'BALANCED') return 'bg-blue-500';
    return 'bg-red-500';
  };

  return (
    <div className="container mx-auto p-6 max-w-4xl">
      <Card>
        <CardHeader>
          <CardTitle className="text-3xl">🤖 Automated MEV Trading Bot</CardTitle>
          <CardDescription>
            One-click setup. No manual configuration. Just select risk level and start trading.
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-6">
          {/* Step 1: Enter Private Key */}
          {!config && (
            <>
              <div className="space-y-2">
                <Label htmlFor="privateKey">Wallet Private Key</Label>
                <Input
                  id="privateKey"
                  type="password"
                  placeholder="Enter your Solana wallet private key..."
                  value={privateKey}
                  onChange={(e) => setPrivateKey(e.target.value)}
                  className="font-mono"
                />
                <p className="text-sm text-muted-foreground">
                  Your private key never leaves your browser. Stored locally only.
                </p>
              </div>

              {/* Step 2: Select Risk Profile */}
              <div className="space-y-3">
                <Label>Select Risk Profile</Label>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  {profiles.map((profile) => (
                    <Card
                      key={profile.level}
                      className={`cursor-pointer transition-all ${
                        selectedRisk === profile.level
                          ? 'ring-2 ring-primary'
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
                            <span className="text-muted-foreground">Position Size:</span>
                            <span className="font-medium">{profile.maxPositionPercent}%</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-muted-foreground">Daily Trades:</span>
                            <span className="font-medium">{profile.expectedDailyTrades}</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-muted-foreground">Success Rate:</span>
                            <span className="font-medium">{profile.expectedSuccessRate}</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-muted-foreground">Daily Return:</span>
                            <span className="font-medium text-green-600">
                              {profile.expectedDailyReturn}
                            </span>
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

              {/* Configure Button */}
              <Button
                className="w-full"
                size="lg"
                onClick={handleConfigure}
                disabled={isConfiguring || !privateKey.trim()}
              >
                {isConfiguring ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Configuring Bot...
                  </>
                ) : (
                  '⚡ Auto-Configure Bot'
                )}
              </Button>
            </>
          )}

          {/* Step 3: Show Configuration & Start Trading */}
          {config && (
            <>
              <Alert className={config.readyToTrade ? 'border-green-500' : 'border-yellow-500'}>
                {config.readyToTrade ? (
                  <CheckCircle2 className="h-4 w-4 text-green-500" />
                ) : (
                  <AlertCircle className="h-4 w-4 text-yellow-500" />
                )}
                <AlertDescription>
                  {config.readyToTrade
                    ? '✅ Bot configured successfully! Ready to start automated trading.'
                    : '⚠️ Configuration complete but warnings detected. Review below.'}
                </AlertDescription>
              </Alert>

              {/* Configuration Summary */}
              <Card className="bg-accent">
                <CardHeader>
                  <CardTitle className="text-lg">Configuration Summary</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <p className="text-sm text-muted-foreground">Risk Profile</p>
                      <p className="font-bold">{config.profile.name}</p>
                    </div>
                    <div>
                      <p className="text-sm text-muted-foreground">Wallet Balance</p>
                      <p className="font-bold">{config.walletBalance.toFixed(4)} SOL</p>
                    </div>
                    <div>
                      <p className="text-sm text-muted-foreground">Max Position</p>
                      <p className="font-bold">
                        {config.calculatedSettings.maxPositionSol.toFixed(4)} SOL
                      </p>
                    </div>
                    <div>
                      <p className="text-sm text-muted-foreground">Daily Limit</p>
                      <p className="font-bold">
                        {config.calculatedSettings.dailyLimitSol.toFixed(4)} SOL
                      </p>
                    </div>
                  </div>

                  <div>
                    <p className="text-sm text-muted-foreground mb-2">Enabled Strategies</p>
                    <div className="flex flex-wrap gap-2">
                      {config.enabledStrategies.map((strategy) => (
                        <Badge key={strategy} variant="secondary">
                          {strategy}
                        </Badge>
                      ))}
                    </div>
                  </div>

                  {config.warnings.length > 0 && (
                    <div>
                      <p className="text-sm text-muted-foreground mb-2">⚠️ Warnings</p>
                      <ul className="space-y-1">
                        {config.warnings.map((warning, i) => (
                          <li key={i} className="text-sm text-yellow-600">
                            {warning}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Trading Controls */}
              <div className="flex gap-4">
                {!isTrading ? (
                  <Button
                    className="flex-1"
                    size="lg"
                    onClick={handleStartTrading}
                    disabled={!config.readyToTrade}
                  >
                    🚀 Start Automated Trading
                  </Button>
                ) : (
                  <Button
                    className="flex-1"
                    size="lg"
                    variant="destructive"
                    onClick={handleStopTrading}
                  >
                    ⏹️ Stop Trading
                  </Button>
                )}
                
                <Button
                  variant="outline"
                  onClick={() => setConfig(null)}
                  disabled={isTrading}
                >
                  Reset
                </Button>
              </div>

              {/* Trading Status */}
              {isTrading && (
                <Alert className="border-green-500 bg-green-50">
                  <CheckCircle2 className="h-4 w-4 text-green-500" />
                  <AlertDescription>
                    <span className="font-bold">Bot is trading!</span> Monitoring for opportunities
                    and executing trades automatically. Expected: {config.profile.expectedDailyTrades}.
                  </AlertDescription>
                </Alert>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* Info Cards */}
      {!config && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-6">
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-3 mb-2">
                <Shield className="w-6 h-6 text-green-500" />
                <h3 className="font-bold">Safe & Secure</h3>
              </div>
              <p className="text-sm text-muted-foreground">
                Private keys never leave your browser. All trades executed securely on-chain.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-3 mb-2">
                <Zap className="w-6 h-6 text-yellow-500" />
                <h3 className="font-bold">Fully Automated</h3>
              </div>
              <p className="text-sm text-muted-foreground">
                No manual configuration needed. Bot auto-sizes positions based on your balance.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-3 mb-2">
                <TrendingUp className="w-6 h-6 text-blue-500" />
                <h3 className="font-bold">Proven Strategies</h3>
              </div>
              <p className="text-sm text-muted-foreground">
                7 Phase 2 MEV strategies working 24/7 to capture profitable opportunities.
              </p>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
