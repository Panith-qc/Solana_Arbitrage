import React from 'react';
interface PrivateKeyWalletProps {
    onWalletConnect: (privateKey: string, publicKey: string) => void;
    onWalletDisconnect: () => void;
    isConnected: boolean;
    walletInfo?: {
        publicKey: string;
        balance: number;
        totalUsd: number;
    };
}
declare const PrivateKeyWallet: React.FC<PrivateKeyWalletProps>;
export default PrivateKeyWallet;
//# sourceMappingURL=PrivateKeyWallet.d.ts.map