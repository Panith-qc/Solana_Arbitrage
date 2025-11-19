/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_HELIUS_API_KEY: string;
  readonly VITE_HELIUS_RPC_URL?: string;
  readonly VITE_PRIVATE_KEY?: string;
  readonly VITE_RISK_LEVEL?: string;
  readonly VITE_MAX_POSITION_SOL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
