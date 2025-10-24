import React, { useState } from 'react';
import AutoTradingSetup from './components/AutoTradingSetup';
import PrivateKeyTradingDashboard from './components/PrivateKeyTradingDashboard';
import { Button } from './components/ui/button';

function App() {
  // Toggle between auto setup and advanced dashboard
  // DEFAULT TO ADVANCED (ORIGINAL WORKING DASHBOARD)
  const [useAutoMode, setUseAutoMode] = useState(false);

  return (
    <div className="App">
      {/* Toggle Button */}
      <div className="fixed top-4 right-4 z-50">
        <Button
          variant={useAutoMode ? "default" : "outline"}
          onClick={() => setUseAutoMode(!useAutoMode)}
        >
          {useAutoMode ? '🤖 Auto Mode (Experimental)' : '⚙️ Advanced Mode (Original)'}
        </Button>
      </div>

      {/* Show ORIGINAL working dashboard by default */}
      {useAutoMode ? (
        <AutoTradingSetup />
      ) : (
        <PrivateKeyTradingDashboard />
      )}
    </div>
  );
}

export default App;