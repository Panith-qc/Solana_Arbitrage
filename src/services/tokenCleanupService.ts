export interface TokenBalance { 
  mint: string;
  symbol?: string;
  amount: number; 
  decimals: number;
  valueUsd?: number;
}
export interface CleanupResult { 
  success: boolean;
  cleaned?: string[];
  tokensCleaned?: number;
  totalValueRecovered?: number;
  transactions?: string[];
  errors?: string[];
}
export const tokenCleanupService = { 
  scanWalletTokens: async () => ([]), 
  cleanupAllTokens: async (): Promise<CleanupResult> => ({ success: true, cleaned: [], tokensCleaned: 0, totalValueRecovered: 0, transactions: [], errors: [] }),
  cleanup: async () => ({ success: true }) 
};
