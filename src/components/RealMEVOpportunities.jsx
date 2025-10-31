// REAL MEV OPPORTUNITIES - PRODUCTION DISPLAY
// Live opportunities with no mock data, real profit calculations
import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { DollarSign, TrendingUp, Zap, Clock, Target, AlertTriangle, Activity } from 'lucide-react';
const RealMEVOpportunities = ({ opportunities, isScanning, onExecuteTrade, executingTradeId, autoTradingEnabled }) => {
    const getTypeIcon = (type) => {
        switch (type) {
            case 'SANDWICH': return <Target className="w-4 h-4"/>;
            case 'ARBITRAGE': return <TrendingUp className="w-4 h-4"/>;
            case 'LIQUIDATION': return <AlertTriangle className="w-4 h-4"/>;
            default: return <DollarSign className="w-4 h-4"/>;
        }
    };
    const getTypeColor = (type) => {
        switch (type) {
            case 'SANDWICH': return 'bg-purple-500/20 text-purple-400 border-purple-500/50';
            case 'ARBITRAGE': return 'bg-blue-500/20 text-blue-400 border-blue-500/50';
            case 'LIQUIDATION': return 'bg-orange-500/20 text-orange-400 border-orange-500/50';
            default: return 'bg-gray-500/20 text-gray-400 border-gray-500/50';
        }
    };
    const getRiskColor = (risk) => {
        switch (risk) {
            case 'LOW': return 'bg-green-500/20 text-green-400 border-green-500/50';
            case 'MEDIUM': return 'bg-yellow-500/20 text-yellow-400 border-yellow-500/50';
            case 'HIGH': return 'bg-red-500/20 text-red-400 border-red-500/50';
            default: return 'bg-gray-500/20 text-gray-400 border-gray-500/50';
        }
    };
    const formatTimeAgo = (timestamp) => {
        const seconds = Math.floor((new Date().getTime() - timestamp.getTime()) / 1000);
        if (seconds < 60)
            return `${seconds}s ago`;
        const minutes = Math.floor(seconds / 60);
        if (minutes < 60)
            return `${minutes}m ago`;
        return timestamp.toLocaleTimeString();
    };
    // Sort opportunities by execution priority and profit
    const sortedOpportunities = [...opportunities].sort((a, b) => {
        const priorityA = a.executionPriority || 0;
        const priorityB = b.executionPriority || 0;
        if (priorityA !== priorityB)
            return priorityB - priorityA;
        return b.profitUsd - a.profitUsd;
    });
    return (<Card className="bg-black/20 border-yellow-500/30">
      <CardHeader>
        <CardTitle className="text-yellow-400 flex items-center justify-between">
          <div className="flex items-center">
            <DollarSign className="w-5 h-5 mr-2"/>
            Real MEV Opportunities
          </div>
          <div className="flex items-center space-x-2">
            {isScanning && (<div className="flex items-center space-x-2">
                <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></div>
                <span className="text-sm text-green-400">Live Scanning</span>
              </div>)}
            {autoTradingEnabled && (<Badge className="bg-yellow-500/20 text-yellow-400 border-yellow-500/50">
                <Zap className="w-3 h-3 mr-1"/>
                AUTO
              </Badge>)}
          </div>
        </CardTitle>
        <p className="text-sm text-gray-300">
          Real-time MEV opportunities with accurate profit calculations (NO MOCK DATA)
        </p>
      </CardHeader>
      <CardContent>
        {sortedOpportunities.length === 0 ? (<div className="text-center py-12">
            <TrendingUp className="w-16 h-16 text-gray-500 mx-auto mb-4"/>
            <p className="text-gray-400 text-lg mb-2">
              {isScanning ?
                '🔍 Scanning for real MEV opportunities...' :
                '⏹️ Scanner stopped - No opportunities available'}
            </p>
            <p className="text-sm text-gray-500 mb-4">
              Monitoring: Sandwich, Arbitrage, and Liquidation opportunities
            </p>
            <div className="flex justify-center space-x-4 text-xs text-gray-600">
              <span>Min Sandwich: $0.05</span>
              <span>Min Arbitrage: $0.02</span>
              <span>Min Liquidation: $0.10</span>
            </div>
            <p className="text-xs text-red-400 mt-4">
              🔴 NO MOCK DATA - Only real profitable opportunities appear here
            </p>
          </div>) : (<div className="space-y-4">
            {/* Opportunity Summary */}
            <div className="grid grid-cols-4 gap-4 p-4 bg-black/30 rounded-lg border border-gray-700">
              <div className="text-center">
                <div className="text-2xl font-bold text-green-400">
                  {sortedOpportunities.length}
                </div>
                <div className="text-xs text-gray-400">Total Opportunities</div>
              </div>
              <div className="text-center">
                <div className="text-2xl font-bold text-yellow-400">
                  ${sortedOpportunities.reduce((sum, opp) => sum + opp.profitUsd, 0).toFixed(3)}
                </div>
                <div className="text-xs text-gray-400">Total Profit Potential</div>
              </div>
              <div className="text-center">
                <div className="text-2xl font-bold text-blue-400">
                  {sortedOpportunities.filter(opp => opp.riskLevel === 'LOW').length}
                </div>
                <div className="text-xs text-gray-400">Low Risk</div>
              </div>
              <div className="text-center">
                <div className="text-2xl font-bold text-purple-400">
                  {sortedOpportunities.filter(opp => opp.type === 'SANDWICH').length}
                </div>
                <div className="text-xs text-gray-400">Sandwich Ops</div>
              </div>
            </div>

            {/* Opportunity List */}
            <div className="space-y-3 max-h-96 overflow-y-auto">
              {sortedOpportunities.map((opportunity, index) => (<div key={opportunity.id} className="bg-black/30 rounded-lg p-4 border border-gray-700 hover:border-gray-600 transition-colors">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center space-x-4">
                      {/* Opportunity Info */}
                      <div className="flex items-center space-x-2">
                        {getTypeIcon(opportunity.type)}
                        <span className="text-white font-bold">{opportunity.pair}</span>
                        {index === 0 && (<Badge className="bg-gold-500/20 text-yellow-300 border-yellow-500/50 text-xs">
                            TOP
                          </Badge>)}
                      </div>
                      
                      {/* Type and Risk Badges */}
                      <div className="flex items-center space-x-2">
                        <Badge className={`${getTypeColor(opportunity.type)} text-xs`}>
                          {opportunity.type}
                        </Badge>
                        <Badge className={`${getRiskColor(opportunity.riskLevel)} text-xs`}>
                          {opportunity.riskLevel}
                        </Badge>
                        <Badge className="bg-green-500/20 text-green-400 border-green-500/50 text-xs">
                          REAL
                        </Badge>
                      </div>
                    </div>

                    {/* Execute Button */}
                    <Button onClick={() => onExecuteTrade(opportunity)} disabled={executingTradeId === opportunity.id} size="sm" className="bg-green-600 hover:bg-green-700 text-white">
                      {executingTradeId === opportunity.id ? (<>
                          <Activity className="w-4 h-4 mr-2 animate-spin"/>
                          Executing...
                        </>) : (<>
                          <Zap className="w-4 h-4 mr-2"/>
                          Execute Trade
                        </>)}
                    </Button>
                  </div>

                  {/* Profit and Details */}
                  <div className="mt-3 grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                    <div>
                      <div className="text-gray-400">Profit</div>
                      <div className="flex items-center space-x-2">
                        <span className="text-green-400 font-bold">
                          +{opportunity.profitPercent.toFixed(3)}%
                        </span>
                        <span className="text-gray-300">
                          ${opportunity.profitUsd.toFixed(4)}
                        </span>
                      </div>
                    </div>
                    
                    <div>
                      <div className="text-gray-400">Confidence</div>
                      <div className="text-white font-medium">
                        {opportunity.confidence}%
                      </div>
                    </div>
                    
                    <div>
                      <div className="text-gray-400">Size</div>
                      <div className="text-white">
                        ${(opportunity.inputAmount * 245 / 1e9).toFixed(2)}
                      </div>
                    </div>
                    
                    <div>
                      <div className="text-gray-400 flex items-center">
                        <Clock className="w-3 h-3 mr-1"/>
                        Time
                      </div>
                      <div className="text-white">
                        {formatTimeAgo(opportunity.timestamp)}
                      </div>
                    </div>
                  </div>

                  {/* Sandwich-specific details */}
                  {opportunity.type === 'SANDWICH' && (<div className="mt-2 p-2 bg-purple-500/10 rounded border border-purple-500/30">
                      <div className="text-xs text-purple-300">
                        🎯 Sandwich Strategy: Frontrun → Target Transaction → Backrun
                      </div>
                    </div>)}

                  {/* High priority indicator */}
                  {opportunity.executionPriority && opportunity.executionPriority > 100 && (<div className="mt-2 flex items-center text-xs text-yellow-400">
                      <AlertTriangle className="w-3 h-3 mr-1"/>
                      High Priority Execution Recommended
                    </div>)}
                </div>))}
            </div>
          </div>)}
      </CardContent>
    </Card>);
};
export default RealMEVOpportunities;
//# sourceMappingURL=RealMEVOpportunities.js.map