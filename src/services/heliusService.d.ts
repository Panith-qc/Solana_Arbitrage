import { Connection, PublicKey } from '@solana/web3.js';
declare class HeliusService {
    private connection;
    private apiKey;
    constructor();
    getConnection(): Connection;
    healthCheck(): Promise<boolean>;
    getBalance(publicKey: PublicKey): Promise<number>;
    getTokenAccounts(publicKey: PublicKey): Promise<any>;
    getTransactionHistory(publicKey: PublicKey, limit?: number): Promise<any>;
    getWalletData(publicKey: PublicKey): Promise<{
        publicKey: any;
        balance: number;
        tokenAccounts: any;
        recentTransactions: any;
        timestamp: number;
        network: string;
    }>;
    getApiStats(): {
        apiKey: string;
        rpcEndpoint: string;
        apiEndpoint: string;
        network: string;
        isConfigured: boolean;
    };
    testConnection(): Promise<{
        success: boolean;
        slot: any;
        version: any;
        network: string;
        error?: undefined;
    } | {
        success: boolean;
        error: any;
        network: string;
        slot?: undefined;
        version?: undefined;
    }>;
}
export declare const heliusService: HeliusService;
export default heliusService;
//# sourceMappingURL=heliusService.d.ts.map