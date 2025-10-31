declare class EnhancedCorsProxyService {
    private supabaseUrl;
    private supabaseKey;
    healthCheck(): Promise<{
        supabase: boolean;
        direct: boolean;
        external: boolean;
    }>;
    fetch(url: string): Promise<Response>;
}
export declare const enhancedCorsProxyService: EnhancedCorsProxyService;
export declare const enhancedCorsProxy: EnhancedCorsProxyService;
export default enhancedCorsProxyService;
//# sourceMappingURL=enhancedCorsProxy.d.ts.map