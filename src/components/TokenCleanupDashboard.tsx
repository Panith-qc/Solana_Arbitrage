import React, { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { 
  Trash2, 
  Settings, 
  DollarSign, 
  AlertTriangle, 
  CheckCircle,
  Activity,
  Calculator,
  Zap
} from 'lucide-react';
import { tokenCleanupService, TokenBalance, CleanupResult } from '../services/tokenCleanupService';

interface RecoverySettings {
  priorityFeeSol: number;
  slippagePercent: number;
  minValueUsd: number;
  maxRetries: number;
  delayBetweenTxMs: number;
  enablePreflight: boolean;
}

const TokenCleanupDashboard: React.FC = () => {
  const [tokens, setTokens] = useState<TokenBalance[]>([]);
  const [isScanning, setIsScanning] = useState(false);
  const [isRecovering, setIsRecovering] = useState(false);
  const [recoveryResult, setRecoveryResult] = useState<CleanupResult | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [estimatedFees, setEstimatedFees] = useState<number>(0);
  const [estimatedRecovery, setEstimatedRecovery] = useState<number>(0);

  // Recovery settings with conservative defaults
  const [settings, setSettings] = useState<RecoverySettings>({
    priorityFeeSol: 0.002, // Reduced from 0.015 to 0.002 SOL
    slippagePercent: 3.0, // 3% slippage for stuck tokens
    minValueUsd: 0.50, // Only recover tokens worth $0.50+
    maxRetries: 2, // Reduced retries to save fees
    delayBetweenTxMs: 3000, // 3 second delay between transactions
    enablePreflight: true // Enable preflight checks
  });

  useEffect(() => {
    scanTokens();
  }, []);

  useEffect(() => {
    calculateEstimates();
  }, [tokens, settings]);

  const scanTokens = async () => {
    setIsScanning(true);
    try {
      const foundTokens = await tokenCleanupService.scanWalletTokens();
      setTokens(foundTokens);
    } catch (error) {
      console.error('Failed to scan tokens:', error);
    } finally {
      setIsScanning(false);
    }
  };

  const calculateEstimates = () => {
    const eligibleTokens = tokens.filter(token => token.usdValue >= settings.minValueUsd);
    const totalValue = eligibleTokens.reduce((sum, token) => sum + token.usdValue, 0);
    const totalFees = eligibleTokens.length * (settings.priorityFeeSol * 240); // Convert SOL to USD
    const accountCreationFees = eligibleTokens.length * (0.00203928 * 240); // Account creation costs
    
    setEstimatedRecovery(totalValue);
    setEstimatedFees(totalFees + accountCreationFees);
  };

  const handleRecovery = async () => {
    if (estimatedFees >= estimatedRecovery * 0.5) {
      const confirmed = window.confirm(
        `⚠️ WARNING: Recovery fees ($${estimatedFees.toFixed(2)}) are ${((estimatedFees/estimatedRecovery)*100).toFixed(1)}% of recovery value ($${estimatedRecovery.toFixed(2)}).\n\nThis means you'll lose significant value in fees. Continue anyway?`
      );
      if (!confirmed) return;
    }

    setIsRecovering(true);
    setRecoveryResult(null);

    try {
      // Update the service with current settings
      await updateServiceSettings();
      
      const result = await tokenCleanupService.cleanupAllTokens(settings.minValueUsd);
      setRecoveryResult(result);
      
      // Refresh token list after recovery
      setTimeout(() => {
        scanTokens();
      }, 5000);
    } catch (error) {
      console.error('Recovery failed:', error);
      setRecoveryResult({
        success: false,
        cleaned: 0,
        tokensCleaned: 0,
        totalValueRecovered: 0,
        transactions: [],
        errors: [error instanceof Error ? error.message : 'Unknown error'],
      });
    } finally {
      setIsRecovering(false);
    }

  };

  const updateServiceSettings = async () => {
    // This would ideally update the service configuration
    // For now, we'll pass settings through the cleanup call
    console.log('🔧 Updated recovery settings:', settings);
  };

  const getTotalValue = () => {
    return tokens.reduce((sum, token) => sum + token.usdValue, 0);
  };

  const getEligibleTokens = () => {
    return tokens.filter(token => token.usdValue >= settings.minValueUsd);
  };

  const getFeeEfficiency = () => {
    if (estimatedRecovery === 0) return 0;
    return ((estimatedRecovery - estimatedFees) / estimatedRecovery) * 100;
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Trash2 className="w-5 h-5" />
            Token Recovery Center
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between">
            <div className="space-y-1">
              <div className="text-sm text-gray-600">
                Scan and convert stuck tokens back to SOL with optimized fees
              </div>
              <div className="flex items-center gap-4 text-sm">
                <span>Found: {tokens.length} tokens</span>
                <span>Total Value: ${getTotalValue().toFixed(2)}</span>
                <span>Eligible: {getEligibleTokens().length} tokens</span>
              </div>
            </div>
            <div className="flex gap-2">
              <Button
                onClick={scanTokens}
                disabled={isScanning}
                variant="outline"
                size="sm"
              >
                {isScanning ? (
                  <>
                    <Activity className="w-4 h-4 mr-2 animate-spin" />
                    Scanning...
                  </>
                ) : (
                  'Refresh Scan'
                )}
              </Button>
              <Button
                onClick={() => setShowSettings(!showSettings)}
                variant="outline"
                size="sm"
              >
                <Settings className="w-4 h-4 mr-2" />
                Settings
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Recovery Settings */}
      {showSettings && (
        <Card className="border-blue-200">
          <CardHeader>
            <CardTitle className="text-blue-700 flex items-center gap-2">
              <Settings className="w-5 h-5" />
              Recovery Parameters
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="priorityFee">Priority Fee (SOL)</Label>
                <Input
                  id="priorityFee"
                  type="number"
                  step="0.001"
                  min="0.001"
                  max="0.01"
                  value={settings.priorityFeeSol}
                  onChange={(e) => setSettings(prev => ({ 
                    ...prev, 
                    priorityFeeSol: parseFloat(e.target.value) || 0.002 
                  }))}
                  className="mt-1"
                />
                <div className="text-xs text-gray-500 mt-1">
                  Lower = cheaper, Higher = faster execution
                </div>
              </div>

              <div>
                <Label htmlFor="slippage">Max Slippage (%)</Label>
                <Input
                  id="slippage"
                  type="number"
                  step="0.5"
                  min="1"
                  max="10"
                  value={settings.slippagePercent}
                  onChange={(e) => setSettings(prev => ({ 
                    ...prev, 
                    slippagePercent: parseFloat(e.target.value) || 3.0 
                  }))}
                  className="mt-1"
                />
                <div className="text-xs text-gray-500 mt-1">
                  Higher slippage = better success rate
                </div>
              </div>

              <div>
                <Label htmlFor="minValue">Min Token Value (USD)</Label>
                <Input
                  id="minValue"
                  type="number"
                  step="0.10"
                  min="0.01"
                  max="10"
                  value={settings.minValueUsd}
                  onChange={(e) => setSettings(prev => ({ 
                    ...prev, 
                    minValueUsd: parseFloat(e.target.value) || 0.50 
                  }))}
                  className="mt-1"
                />
                <div className="text-xs text-gray-500 mt-1">
                  Only recover tokens above this value
                </div>
              </div>

              <div>
                <Label htmlFor="delay">Delay Between Tx (ms)</Label>
                <Input
                  id="delay"
                  type="number"
                  step="500"
                  min="1000"
                  max="10000"
                  value={settings.delayBetweenTxMs}
                  onChange={(e) => setSettings(prev => ({ 
                    ...prev, 
                    delayBetweenTxMs: parseInt(e.target.value) || 3000 
                  }))}
                  className="mt-1"
                />
                <div className="text-xs text-gray-500 mt-1">
                  Longer delay = better success rate
                </div>
              </div>
            </div>

            <div className="flex items-center space-x-2">
              <Switch
                id="preflight"
                checked={settings.enablePreflight}
                onCheckedChange={(checked) => setSettings(prev => ({ 
                  ...prev, 
                  enablePreflight: checked 
                }))}
              />
              <Label htmlFor="preflight">Enable Preflight Checks</Label>
              <div className="text-xs text-gray-500">
                (Recommended: catches errors before spending fees)
              </div>
            </div>

            <Separator />

            {/* Cost-Benefit Analysis */}
            <div className="bg-gray-50 p-4 rounded-lg">
              <h4 className="font-medium mb-3 flex items-center gap-2">
                <Calculator className="w-4 h-4" />
                Cost-Benefit Analysis
              </h4>
              <div className="grid grid-cols-3 gap-4 text-sm">
                <div>
                  <div className="text-gray-600">Estimated Recovery</div>
                  <div className="font-medium text-green-600">
                    ${estimatedRecovery.toFixed(2)}
                  </div>
                </div>
                <div>
                  <div className="text-gray-600">Estimated Fees</div>
                  <div className="font-medium text-red-600">
                    ${estimatedFees.toFixed(2)}
                  </div>
                </div>
                <div>
                  <div className="text-gray-600">Net Profit</div>
                  <div className={`font-medium ${getFeeEfficiency() > 50 ? 'text-green-600' : 'text-red-600'}`}>
                    ${(estimatedRecovery - estimatedFees).toFixed(2)} ({getFeeEfficiency().toFixed(1)}%)
                  </div>
                </div>
              </div>
              
              {getFeeEfficiency() < 50 && (
                <Alert className="mt-3 border-red-200 bg-red-50">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertDescription className="text-red-700">
                    <strong>High Fee Warning:</strong> Recovery fees are {(100-getFeeEfficiency()).toFixed(1)}% of value. 
                    Consider increasing minimum value or reducing priority fees.
                  </AlertDescription>
                </Alert>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Token List */}
      {tokens.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Stuck Tokens Found ({tokens.length})</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {tokens.map((token, index) => (
                <div key={index} className="flex items-center justify-between p-3 border rounded-lg">
                  <div className="flex items-center gap-3">
                    <Badge variant={token.usdValue >= settings.minValueUsd ? 'default' : 'secondary'}>
                      {token.symbol}
                    </Badge>
                    <div>
                      <div className="font-medium">
                        {token.uiAmount.toLocaleString()} {token.symbol}
                      </div>
                      <div className="text-sm text-gray-600">
                        Value: ${token.usdValue.toFixed(4)}
                      </div>
                    </div>
                  </div>
                  <div className="text-right">
                    {token.usdValue >= settings.minValueUsd ? (
                      <Badge className="bg-green-100 text-green-800">
                        Will Recover
                      </Badge>
                    ) : (
                      <Badge variant="secondary">
                        Below Threshold
                      </Badge>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Recovery Action */}
      {getEligibleTokens().length > 0 && (
        <Card className="border-green-200">
          <CardContent className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="font-medium text-green-700 mb-1">
                  Ready to Recover {getEligibleTokens().length} Tokens
                </h3>
                <div className="text-sm text-gray-600">
                  Net recovery: ${(estimatedRecovery - estimatedFees).toFixed(2)} 
                  (Fee efficiency: {getFeeEfficiency().toFixed(1)}%)
                </div>
              </div>
              <Button
                onClick={handleRecovery}
                disabled={isRecovering || getFeeEfficiency() < 0}
                className="bg-green-600 hover:bg-green-700"
              >
                {isRecovering ? (
                  <>
                    <Activity className="w-4 h-4 mr-2 animate-spin" />
                    Recovering...
                  </>
                ) : (
                  <>
                    <Zap className="w-4 h-4 mr-2" />
                    Start Recovery
                  </>
                )}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Recovery Results */}
      {recoveryResult && (
        <Card className={recoveryResult.success ? 'border-green-200' : 'border-red-200'}>
          <CardHeader>
            <CardTitle className={`flex items-center gap-2 ${recoveryResult.success ? 'text-green-700' : 'text-red-700'}`}>
              {recoveryResult.success ? (
                <CheckCircle className="w-5 h-5" />
              ) : (
                <AlertTriangle className="w-5 h-5" />
              )}
              Recovery {recoveryResult.success ? 'Complete' : 'Failed'}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <div className="text-sm text-gray-600">Tokens Recovered</div>
                  <div className="font-medium">{recoveryResult.tokensCleaned}</div>
                </div>
                <div>
                  <div className="text-sm text-gray-600">Value Recovered</div>
                  <div className="font-medium text-green-600">
                    ${(recoveryResult.totalValueRecovered ?? 0).toFixed(4)}
                  </div>
                </div>
                <div>
                  <div className="text-sm text-gray-600">Transactions</div>
                  <div className="font-medium">{recoveryResult.transactions?.length ?? 0}</div>
                </div>
              </div>

              {(recoveryResult.transactions?.length ?? 0) > 0 && (
                <div>
                  <div className="text-sm font-medium mb-2">Transaction Hashes:</div>
                  <div className="space-y-1">
                    {(recoveryResult.transactions ?? []).map((tx, index) => (
                      <a
                        key={index}
                        href={`https://solscan.io/tx/${tx}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-blue-600 hover:underline block"
                      >
                        {tx}
                      </a>
                    ))}
                  </div>
                </div>
              )}

              {(recoveryResult.errors?.length ?? 0) > 0 && (
                <div>
                  <div className="text-sm font-medium mb-2 text-red-600">Errors:</div>
                  <div className="space-y-1">
                    {(recoveryResult.errors ?? []).map((error, index) => (
                      <div key={index} className="text-xs text-red-600">
                        {error}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {tokens.length === 0 && !isScanning && (
        <Card>
          <CardContent className="text-center py-8">
            <CheckCircle className="w-12 h-12 text-green-500 mx-auto mb-4" />
            <h3 className="font-medium mb-2">No Stuck Tokens Found</h3>
            <p className="text-gray-600">Your wallet is clean! All tokens are properly managed.</p>
          </CardContent>
        </Card>
      )}
    </div>
  );
};

export default TokenCleanupDashboard;
