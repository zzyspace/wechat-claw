export interface WechatyModule {
  WechatyBuilder: {
    build(options: Record<string, unknown>): WechatyInstance;
  };
  ScanStatus: {
    [key: string]: string | number;
  };
  log: {
    info(namespace: string, ...args: unknown[]): void;
  };
}

export interface WechatyInstance {
  Contact?: {
    find(query: Record<string, unknown>): Promise<any>;
  };
  Room?: {
    find(query: Record<string, unknown>): Promise<any>;
  };
  puppet?: {
    messageRawPayload?(messageId: string): Promise<unknown>;
  };
  isLoggedIn?: boolean;
  on(event: string, listener: (...args: any[]) => unknown): WechatyInstance;
  start(): Promise<void>;
  stop(): Promise<void>;
}
