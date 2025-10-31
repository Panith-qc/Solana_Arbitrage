import React, { useState } from 'react';
import Phase2AutoTrading from './components/Phase2AutoTrading';
import PrivateKeyTradingDashboard from './components/PrivateKeyTradingDashboard';
import { Button } from './components/ui/button';
function App() {
    // Toggle between Phase 2 auto trading and manual dashboard
    const [usePhase2, setUsePhase2] = useState(true);
    return (<div className="App">
      {/* Toggle Button */}
      <div className="fixed top-4 right-4 z-50">
        <Button variant={usePhase2 ? "default" : "outline"} onClick={() => setUsePhase2(!usePhase2)} className="font-semibold">
          {usePhase2 ? '🚀 Phase 2 (All Strategies)' : '⚙️ Manual Mode'}
        </Button>
      </div>

      {/* Phase 2 Auto-Trading with ALL strategies by default */}
      {usePhase2 ? (<Phase2AutoTrading />) : (<PrivateKeyTradingDashboard />)}
    </div>);
}
export default App;
//# sourceMappingURL=App.js.map