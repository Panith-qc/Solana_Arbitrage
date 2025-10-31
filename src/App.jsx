import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from 'react';
import Phase2AutoTrading from './components/Phase2AutoTrading';
import PrivateKeyTradingDashboard from './components/PrivateKeyTradingDashboard';
import { Button } from './components/ui/button';
function App() {
    // Toggle between Phase 2 auto trading and manual dashboard
    const [usePhase2, setUsePhase2] = useState(true);
    return (_jsxs("div", { className: "App", children: [_jsx("div", { className: "fixed top-4 right-4 z-50", children: _jsx(Button, { variant: usePhase2 ? "default" : "outline", onClick: () => setUsePhase2(!usePhase2), className: "font-semibold", children: usePhase2 ? '🚀 Phase 2 (All Strategies)' : '⚙️ Manual Mode' }) }), usePhase2 ? (_jsx(Phase2AutoTrading, {})) : (_jsx(PrivateKeyTradingDashboard, {}))] }));
}
export default App;
