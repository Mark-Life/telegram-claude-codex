/**
 * The part of pi's extension API `mcp.ts` uses (pi 1.6). pi resolves this
 * module to its own copy when it loads an extension; the bot does not
 * depend on it.
 */
declare module "@earendil-works/pi-coding-agent" {
  type McpExposure = "codemode" | "deferred" | "direct" | "hidden";

  type McpServerConfig =
    | {
        exposure?: McpExposure;
        headers?: Record<string, string>;
        /** Seconds a request may take; pi's default is 60. */
        timeout?: number;
        type: "http";
        url: string;
      }
    | {
        args?: string[];
        command: string;
        exposure?: McpExposure;
        timeout?: number;
        type: "stdio";
      };

  interface ExtensionAPI {
    registerCommand: (...args: never[]) => void;
    registerMcpServer: (name: string, config: McpServerConfig) => void;
  }

  type ExtensionFactory = (pi: ExtensionAPI) => Promise<void> | void;

  export function createMcpExtension(options: {
    loadConfig: () => {
      autoEnableCodemode?: boolean;
      errors: string[];
      servers: never[];
    };
  }): ExtensionFactory;

  export type { ExtensionAPI, McpServerConfig };
}
