import React from 'react';
interface RealWalletIntegrationProps {
    walletState: {
        isConnected: boolean;
        publicKey: string | null;
        balance: number;
    };
    onWalletConnect: (privateKey: string) => Promise<boolean>;
    onWalletDisconnect: () => void;
    onRefreshBalance: () => Promise<void>;
}
declare const RealWalletIntegration: React.FC<RealWalletIntegrationProps>;
export default RealWalletIntegration;
//# sourceMappingURL=RealWalletIntegration.d.ts.map