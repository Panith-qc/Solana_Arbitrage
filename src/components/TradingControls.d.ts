import React from 'react';
interface TradingControlsProps {
    walletBalance?: {
        sol: number;
        usdc: number;
        usdt: number;
    };
    onScannerToggle?: (isActive: boolean) => void;
    onOpportunityFound?: (opportunity: unknown) => void;
}
declare const TradingControls: React.FC<TradingControlsProps>;
export default TradingControls;
//# sourceMappingURL=TradingControls.d.ts.map