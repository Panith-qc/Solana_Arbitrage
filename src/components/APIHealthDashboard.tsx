import { useState, useEffect } from 'react';
import { multiAPIService } from '../services/multiAPIQuoteService';

export const APIHealthDashboard = () => {
  const [health, setHealth] = useState<any[]>([]);
  const [isVisible, setIsVisible] = useState(true);

  useEffect(() => {
    // Update health every second
    const interval = setInterval(() => {
      setHealth(multiAPIService.getHealthReport());
    }, 1000);

    return () => clearInterval(interval);
  }, []);

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'HEALTHY': return 'text-green-500';
      case 'DEGRADED': return 'text-yellow-500';
      case 'PAUSED': return 'text-orange-500';
      case 'FAILED': return 'text-red-500';
      default: return 'text-gray-500';
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'HEALTHY': return '✅';
      case 'DEGRADED': return '⚠️';
      case 'PAUSED': return '⏸️';
      case 'FAILED': return '❌';
      default: return '❓';
    }
  };

  if (!isVisible) {
    return (
      <button
        onClick={() => setIsVisible(true)}
        className="fixed bottom-4 right-4 bg-gray-800 text-white px-4 py-2 rounded-lg shadow-lg hover:bg-gray-700 transition-colors z-50"
      >
        📡 Show API Health
      </button>
    );
  }

  return (
    <div className="fixed bottom-4 right-4 bg-gray-900 text-white rounded-lg shadow-2xl p-4 max-w-2xl z-50 border border-gray-700">
      <div className="flex justify-between items-center mb-3">
        <h3 className="text-lg font-bold flex items-center gap-2">
          <span className="text-2xl">📡</span>
          API Health Monitor
        </h3>
        <button
          onClick={() => setIsVisible(false)}
          className="text-gray-400 hover:text-white transition-colors"
        >
          ✕
        </button>
      </div>

      <div className="space-y-2 max-h-96 overflow-y-auto">
        {health.length === 0 ? (
          <div className="text-gray-400 text-center py-4">
            No API data yet...
          </div>
        ) : (
          health.map((api, index) => (
            <div
              key={index}
              className={`p-3 rounded-lg border ${
                api.status === 'HEALTHY'
                  ? 'bg-green-900/20 border-green-700/50'
                  : api.status === 'DEGRADED'
                  ? 'bg-yellow-900/20 border-yellow-700/50'
                  : api.status === 'PAUSED'
                  ? 'bg-orange-900/20 border-orange-700/50'
                  : 'bg-red-900/20 border-red-700/50'
              }`}
            >
              <div className="flex justify-between items-start mb-2">
                <div className="flex items-center gap-2">
                  <span className="text-xl">{getStatusIcon(api.status)}</span>
                  <span className="font-semibold">{api.name}</span>
                </div>
                <span className={`text-sm font-bold ${getStatusColor(api.status)}`}>
                  {api.status}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-2 text-sm">
                <div>
                  <span className="text-gray-400">Success Rate:</span>
                  <span className="ml-2 font-mono text-green-400">{api.successRate}</span>
                </div>
                <div>
                  <span className="text-gray-400">Avg Latency:</span>
                  <span className="ml-2 font-mono text-blue-400">{api.avgLatency}</span>
                </div>
                <div>
                  <span className="text-gray-400">Calls:</span>
                  <span className="ml-2 font-mono text-purple-400">
                    {api.successfulCalls}/{api.totalCalls}
                  </span>
                </div>
                <div>
                  <span className="text-gray-400">Rate Limit:</span>
                  <span className="ml-2 font-mono text-orange-400">{api.callsThisMinute}</span>
                </div>
              </div>

              {api.consecutiveFailures > 0 && (
                <div className="mt-2 text-xs text-red-400">
                  ⚠️ {api.consecutiveFailures} consecutive failures
                </div>
              )}

              {api.pauseRemaining && (
                <div className="mt-2 text-xs text-orange-400">
                  ⏸️ Paused for {api.pauseRemaining}
                </div>
              )}

              {api.lastError && api.status !== 'HEALTHY' && (
                <div className="mt-2 text-xs text-gray-400 truncate" title={api.lastError}>
                  Last error: {api.lastError}
                </div>
              )}
            </div>
          ))
        )}
      </div>

      <div className="mt-3 pt-3 border-t border-gray-700 text-xs text-gray-400">
        Updates every 1 second • Best API auto-selected
      </div>
    </div>
  );
};
