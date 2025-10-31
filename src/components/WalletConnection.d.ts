import React from 'react';
interface WalletConnectionProps {
    showDetails?: boolean;
    className?: string;
    onWalletConnect?: (walletType: string, privateKey?: string) => void;
    onWalletDisconnect?: () => void;
    onRefreshBalance?: () => void;
}
export declare const WalletConnection: React.FC<WalletConnectionProps>;
export default WalletConnection;
//# sourceMappingURL=WalletConnection.d.ts.map