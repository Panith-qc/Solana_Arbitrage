// COMPREHENSIVE TRADING SETTINGS PANEL
// All parameters configurable through UI
import React, { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Settings, DollarSign, Clock, Shield, Zap, RefreshCw, AlertTriangle, CheckCircle, Save, RotateCcw } from 'lucide-react';
import { tradingConfigManager } from '../config/tradingConfig';
const TradingSettingsPanel = ({ onClose }) => {
    const [config, setConfig] = useState(tradingConfigManager.getConfig());
    const [hasChanges, setHasChanges] = useState(false);
    const [validationErrors, setValidationErrors] = useState([]);
    const [prices, setPrices] = useState({});
    useEffect(() => {
        // Subscribe to config changes
        const unsubscribe = tradingConfigManager.subscribe((newConfig) => {
            setConfig(newConfig);
        });
        // Update prices periodically
        const priceInterval = setInterval(() => {
            setPrices({});
        }, 5000);
        return () => {
            unsubscribe();
            clearInterval(priceInterval);
        };
    }, []);
    const updateConfig = (updates) => {
        const newConfig = { ...config, ...updates };
        setConfig(newConfig);
        setHasChanges(true);
        // Validate
        const validation = tradingConfigManager.validateConfig();
        setValidationErrors(validation.errors);
    };
    const updateSection = (section, updates) => {
        const newConfig = {
            ...config,
            [section]: { ...config[section], ...updates }
        };
        setConfig(newConfig);
        setHasChanges(true);
    };
    const saveChanges = () => {
        const validation = tradingConfigManager.validateConfig();
        if (!validation.isValid) {
            setValidationErrors(validation.errors);
            return;
        }
        tradingConfigManager.updateConfig(config);
        setHasChanges(false);
        setValidationErrors([]);
        console.log('✅ Trading settings saved');
    };
    const resetToDefaults = () => {
        tradingConfigManager.resetToDefaults();
        setHasChanges(false);
        setValidationErrors([]);
    };
    const formatPrice = (price) => {
        if (price < 0.001)
            return price.toFixed(8);
        if (price < 1)
            return price.toFixed(6);
        return price.toFixed(2);
    };
    return (<div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <Card className="w-full max-w-4xl max-h-[90vh] overflow-y-auto bg-black/90 border-purple-500/30">
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-purple-400 flex items-center">
              <Settings className="w-5 h-5 mr-2"/>
              Trading Settings
            </CardTitle>
            <div className="flex items-center space-x-2">
              {hasChanges && (<Badge className="bg-yellow-500/20 text-yellow-400 border-yellow-500/50">
                  Unsaved Changes
                </Badge>)}
              <Button onClick={onClose} variant="outline" size="sm">
                Close
              </Button>
            </div>
          </div>
        </CardHeader>

        <CardContent>
          <Tabs defaultValue="trading" className="space-y-6">
            <TabsList className="grid w-full grid-cols-5">
              <TabsTrigger value="trading">Trading</TabsTrigger>
              <TabsTrigger value="prices">Prices</TabsTrigger>
              <TabsTrigger value="scanner">Scanner</TabsTrigger>
              <TabsTrigger value="risk">Risk</TabsTrigger>
              <TabsTrigger value="apis">APIs</TabsTrigger>
            </TabsList>

            {/* Trading Settings */}
            <TabsContent value="trading" className="space-y-4">
              <Card className="bg-black/20 border-green-500/30">
                <CardHeader>
                  <CardTitle className="text-green-400 flex items-center">
                    <DollarSign className="w-4 h-4 mr-2"/>
                    Trading Parameters
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <Label className="text-white">Min Profit (USD)</Label>
                      <input type="number" step="0.0001" value={config.trading.minProfitUsd} onChange={(e) => updateSection('trading', {
            minProfitUsd: parseFloat(e.target.value) || 0.0001
        })} className="w-full mt-1 px-3 py-2 bg-black/30 border border-gray-600 rounded text-white"/>
                    </div>
                    <div>
                      <Label className="text-white">Max Position (SOL)</Label>
                      <input type="number" step="0.01" value={config.trading.maxPositionSol} onChange={(e) => updateSection('trading', {
            maxPositionSol: parseFloat(e.target.value) || 0.1
        })} className="w-full mt-1 px-3 py-2 bg-black/30 border border-gray-600 rounded text-white"/>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <Label className="text-white">Slippage (Basis Points)</Label>
                      <div className="mt-2">
                        <Slider value={[config.trading.slippageBps]} onValueChange={([value]) => updateSection('trading', { slippageBps: value })} min={1} max={500} step={1} className="w-full"/>
                        <div className="text-sm text-gray-400 mt-1">
                          {config.trading.slippageBps} BPS ({(config.trading.slippageBps / 100).toFixed(2)}%)
                        </div>
                      </div>
                    </div>
                    <div>
                      <Label className="text-white">Priority Fee (Lamports)</Label>
                      <input type="number" step="1000" value={config.trading.priorityFeeLamports} onChange={(e) => updateSection('trading', {
            priorityFeeLamports: parseInt(e.target.value) || 200000
        })} className="w-full mt-1 px-3 py-2 bg-black/30 border border-gray-600 rounded text-white"/>
                      <div className="text-sm text-gray-400 mt-1">
                        ~{(config.trading.priorityFeeLamports / 1e9).toFixed(6)} SOL
                      </div>
                    </div>
                  </div>

                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <Label className="text-white">Auto Trading</Label>
                      <Switch checked={config.trading.autoTradingEnabled} onCheckedChange={(checked) => updateSection('trading', { autoTradingEnabled: checked })}/>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                      <div className="flex items-center justify-between">
                        <Label className="text-white">Enable Arbitrage</Label>
                        <Switch checked={config.trading.enableArbitrage} onCheckedChange={(checked) => updateSection('trading', { enableArbitrage: checked })}/>
                      </div>
                      <div className="flex items-center justify-between">
                        <Label className="text-white">Enable Micro MEV</Label>
                        <Switch checked={config.trading.enableMicroMev} onCheckedChange={(checked) => updateSection('trading', { enableMicroMev: checked })}/>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                      <div className="flex items-center justify-between">
                        <Label className="text-white">Enable Sandwich</Label>
                        <Switch checked={config.trading.enableSandwich} onCheckedChange={(checked) => updateSection('trading', { enableSandwich: checked })}/>
                      </div>
                      <div className="flex items-center justify-between">
                        <Label className="text-white">Enable Liquidation</Label>
                        <Switch checked={config.trading.enableLiquidation} onCheckedChange={(checked) => updateSection('trading', { enableLiquidation: checked })}/>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            {/* Price Settings */}
            <TabsContent value="prices" className="space-y-4">
              <Card className="bg-black/20 border-blue-500/30">
                <CardHeader>
                  <CardTitle className="text-blue-400 flex items-center">
                    <RefreshCw className="w-4 h-4 mr-2"/>
                    Price Configuration
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <Label className="text-white">Price Refresh Interval (ms)</Label>
                      <input type="number" step="1000" value={config.prices.refreshIntervalMs} onChange={(e) => updateSection('prices', {
            refreshIntervalMs: parseInt(e.target.value) || 30000
        })} className="w-full mt-1 px-3 py-2 bg-black/30 border border-gray-600 rounded text-white"/>
                      <div className="text-sm text-gray-400 mt-1">
                        {(config.prices.refreshIntervalMs / 1000).toFixed(0)} seconds
                      </div>
                    </div>
                    <div>
                      <Label className="text-white">Max Price Age (ms)</Label>
                      <input type="number" step="1000" value={config.prices.maxPriceAgeMs} onChange={(e) => updateSection('prices', {
            maxPriceAgeMs: parseInt(e.target.value) || 60000
        })} className="w-full mt-1 px-3 py-2 bg-black/30 border border-gray-600 rounded text-white"/>
                      <div className="text-sm text-gray-400 mt-1">
                        {(config.prices.maxPriceAgeMs / 1000).toFixed(0)} seconds
                      </div>
                    </div>
                  </div>

                  <div className="space-y-3">
                    <Label className="text-white">Current Prices</Label>
                    <div className="grid grid-cols-3 gap-3">
                      {Object.entries(config.tokens).map(([symbol, mint]) => {
            const priceData = prices[mint];
            const isStale = priceData ?
                (Date.now() - priceData.timestamp) > config.prices.maxPriceAgeMs :
                true;
            return (<div key={symbol} className="bg-black/30 rounded p-3 border border-gray-700">
                            <div className="flex items-center justify-between">
                              <span className="text-white font-medium">{symbol}</span>
                              {isStale ? (<AlertTriangle className="w-4 h-4 text-yellow-400"/>) : (<CheckCircle className="w-4 h-4 text-green-400"/>)}
                            </div>
                            <div className="text-sm text-gray-300">
                              ${priceData ? formatPrice(priceData.price) : 'N/A'}
                            </div>
                            {priceData && (<div className="text-xs text-gray-400">
                                {new Date(priceData.timestamp).toLocaleTimeString()}
                              </div>)}
                          </div>);
        })}
                    </div>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            {/* Scanner Settings */}
            <TabsContent value="scanner" className="space-y-4">
              <Card className="bg-black/20 border-yellow-500/30">
                <CardHeader>
                  <CardTitle className="text-yellow-400 flex items-center">
                    <Clock className="w-4 h-4 mr-2"/>
                    Scanner Configuration
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <Label className="text-white">Scan Interval (ms)</Label>
                      <input type="number" step="100" value={config.scanner.scanIntervalMs} onChange={(e) => updateSection('scanner', {
            scanIntervalMs: parseInt(e.target.value) || 1200
        })} className="w-full mt-1 px-3 py-2 bg-black/30 border border-gray-600 rounded text-white"/>
                    </div>
                    <div>
                      <Label className="text-white">Token Check Delay (ms)</Label>
                      <input type="number" step="50" value={config.scanner.tokenCheckDelayMs} onChange={(e) => updateSection('scanner', {
            tokenCheckDelayMs: parseInt(e.target.value) || 200
        })} className="w-full mt-1 px-3 py-2 bg-black/30 border border-gray-600 rounded text-white"/>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <Label className="text-white">Circuit Breaker Threshold</Label>
                      <input type="number" step="1" value={config.scanner.circuitBreakerFailureThreshold} onChange={(e) => updateSection('scanner', {
            circuitBreakerFailureThreshold: parseInt(e.target.value) || 5
        })} className="w-full mt-1 px-3 py-2 bg-black/30 border border-gray-600 rounded text-white"/>
                    </div>
                    <div>
                      <Label className="text-white">Recovery Timeout (ms)</Label>
                      <input type="number" step="1000" value={config.scanner.circuitBreakerRecoveryTimeoutMs} onChange={(e) => updateSection('scanner', {
            circuitBreakerRecoveryTimeoutMs: parseInt(e.target.value) || 30000
        })} className="w-full mt-1 px-3 py-2 bg-black/30 border border-gray-600 rounded text-white"/>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <Label className="text-white">Max Opportunities</Label>
                      <input type="number" step="1" value={config.scanner.maxOpportunities} onChange={(e) => updateSection('scanner', {
            maxOpportunities: parseInt(e.target.value) || 10
        })} className="w-full mt-1 px-3 py-2 bg-black/30 border border-gray-600 rounded text-white"/>
                    </div>
                    <div>
                      <Label className="text-white">Profit Capture Rate</Label>
                      <div className="mt-2">
                        <Slider value={[config.scanner.profitCaptureRate * 100]} onValueChange={([value]) => updateSection('scanner', { profitCaptureRate: value / 100 })} min={10} max={100} step={5} className="w-full"/>
                        <div className="text-sm text-gray-400 mt-1">
                          {(config.scanner.profitCaptureRate * 100).toFixed(0)}%
                        </div>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            {/* Risk Management */}
            <TabsContent value="risk" className="space-y-4">
              <Card className="bg-black/20 border-red-500/30">
                <CardHeader>
                  <CardTitle className="text-red-400 flex items-center">
                    <Shield className="w-4 h-4 mr-2"/>
                    Risk Management
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <Label className="text-white">Max Trade Amount (SOL)</Label>
                      <input type="number" step="0.1" value={config.risk.maxTradeAmountSol} onChange={(e) => updateSection('risk', {
            maxTradeAmountSol: parseFloat(e.target.value) || 1.0
        })} className="w-full mt-1 px-3 py-2 bg-black/30 border border-gray-600 rounded text-white"/>
                    </div>
                    <div>
                      <Label className="text-white">Max Daily Loss (SOL)</Label>
                      <input type="number" step="0.01" value={config.risk.maxDailyLossSol} onChange={(e) => updateSection('risk', {
            maxDailyLossSol: parseFloat(e.target.value) || 0.1
        })} className="w-full mt-1 px-3 py-2 bg-black/30 border border-gray-600 rounded text-white"/>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <Label className="text-white">Stop Loss (%)</Label>
                      <input type="number" step="0.1" value={config.risk.stopLossPercent} onChange={(e) => updateSection('risk', {
            stopLossPercent: parseFloat(e.target.value) || 5.0
        })} className="w-full mt-1 px-3 py-2 bg-black/30 border border-gray-600 rounded text-white"/>
                    </div>
                    <div>
                      <Label className="text-white">Max Concurrent Trades</Label>
                      <input type="number" step="1" value={config.risk.maxConcurrentTrades} onChange={(e) => updateSection('risk', {
            maxConcurrentTrades: parseInt(e.target.value) || 3
        })} className="w-full mt-1 px-3 py-2 bg-black/30 border border-gray-600 rounded text-white"/>
                    </div>
                  </div>

                  <div>
                    <Label className="text-white">Cooldown Between Trades (ms)</Label>
                    <input type="number" step="1000" value={config.risk.cooldownBetweenTradesMs} onChange={(e) => updateSection('risk', {
            cooldownBetweenTradesMs: parseInt(e.target.value) || 5000
        })} className="w-full mt-1 px-3 py-2 bg-black/30 border border-gray-600 rounded text-white"/>
                    <div className="text-sm text-gray-400 mt-1">
                      {(config.risk.cooldownBetweenTradesMs / 1000).toFixed(0)} seconds
                    </div>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            {/* API Settings */}
            <TabsContent value="apis" className="space-y-4">
              <Card className="bg-black/20 border-purple-500/30">
                <CardHeader>
                  <CardTitle className="text-purple-400 flex items-center">
                    <Zap className="w-4 h-4 mr-2"/>
                    API Configuration
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-3">
                    <div>
                      <Label className="text-white">Jupiter Quote API</Label>
                      <input type="url" value={config.apis.jupiterQuote} onChange={(e) => updateSection('apis', { jupiterQuote: e.target.value })} className="w-full mt-1 px-3 py-2 bg-black/30 border border-gray-600 rounded text-white"/>
                    </div>
                    <div>
                      <Label className="text-white">Jupiter Swap API</Label>
                      <input type="url" value={config.apis.jupiterSwap} onChange={(e) => updateSection('apis', { jupiterSwap: e.target.value })} className="w-full mt-1 px-3 py-2 bg-black/30 border border-gray-600 rounded text-white"/>
                    </div>
                    <div>
                      <Label className="text-white">Jupiter Price API</Label>
                      <input type="url" value={config.apis.jupiterPrice} onChange={(e) => updateSection('apis', { jupiterPrice: e.target.value })} className="w-full mt-1 px-3 py-2 bg-black/30 border border-gray-600 rounded text-white"/>
                    </div>
                    <div>
                      <Label className="text-white">Solscan Base URL</Label>
                      <input type="url" value={config.apis.solscanBase} onChange={(e) => updateSection('apis', { solscanBase: e.target.value })} className="w-full mt-1 px-3 py-2 bg-black/30 border border-gray-600 rounded text-white"/>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>

          {/* Validation Errors */}
          {validationErrors.length > 0 && (<Alert className="border-red-500/50 bg-red-500/10">
              <AlertTriangle className="h-4 w-4"/>
              <AlertDescription className="text-red-400">
                <strong>Configuration Errors:</strong>
                <ul className="mt-2 space-y-1">
                  {validationErrors.map((error, index) => (<li key={index}>• {error}</li>))}
                </ul>
              </AlertDescription>
            </Alert>)}

          {/* Action Buttons */}
          <div className="flex items-center justify-between pt-4 border-t border-gray-700">
            <Button onClick={resetToDefaults} variant="outline" className="border-red-500/50 text-red-400 hover:bg-red-500/20">
              <RotateCcw className="w-4 h-4 mr-2"/>
              Reset to Defaults
            </Button>

            <div className="flex items-center space-x-2">
              <Button onClick={onClose} variant="outline">
                Cancel
              </Button>
              <Button onClick={saveChanges} disabled={!hasChanges || validationErrors.length > 0} className="bg-green-600 hover:bg-green-700">
                <Save className="w-4 h-4 mr-2"/>
                Save Changes
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>);
};
export default TradingSettingsPanel;
//# sourceMappingURL=TradingSettingsPanel.js.map