declare class CorsProxyService {
    private readonly PROXY_URLS;
    private currentProxyIndex;
    private maxRetries;
    constructor();
    private getCurrentProxy;
    private switchProxy;
    proxyFetch(url: string, options?: RequestInit): Promise<Response>;
    directFetch(url: string, options?: RequestInit): Promise<Response>;
    smartFetch(url: string, options?: RequestInit): Promise<Response>;
    getStatus(): {
        currentProxy: string;
        proxyIndex: number;
        totalProxies: number;
    };
    reset(): void;
}
export declare const corsProxyService: CorsProxyService;
export {};
//# sourceMappingURL=corsProxyService.d.ts.map