import React, { useState } from 'react';
import AutoTradingSetup from './components/AutoTradingSetup';
import PrivateKeyTradingDashboard from './components/PrivateKeyTradingDashboard';
import { Button } from './components/ui/button';

function App() {
  // Toggle between auto setup and advanced dashboard
  const [useAutoMode, setUseAutoMode] = useState(true);

  return (
    <div className="App">
      {/* Toggle Button */}
      <div className="fixed top-4 right-4 z-50">
        <Button
          variant={useAutoMode ? "default" : "outline"}
          onClick={() => setUseAutoMode(!useAutoMode)}
        >
          {useAutoMode ? '🤖 Auto Mode (Simple)' : '⚙️ Advanced Mode'}
        </Button>
      </div>

      {/* Show Auto Trading Setup by default (Simple Mode) */}
      {useAutoMode ? (
        <AutoTradingSetup />
      ) : (
        <PrivateKeyTradingDashboard />
      )}
    </div>
  );
}

export default App;