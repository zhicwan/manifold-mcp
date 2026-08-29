import type { Canvas, CanvasOptions, JoinSessionConfig } from '@github/copilot-sdk/extension';
import type { MessageOptions, Tool, ToolResultObject } from '@github/copilot-sdk';

export interface ExtensionContextAttachmentInput {
  type: 'extension_context';
  title: string;
  payload: null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
}

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface CopilotExtensionSession {
  readonly sessionId: string;
  readonly workspacePath: string | undefined;
  send(options: MessageOptions): Promise<string>;
  log(message: string, options?: { level?: 'info' | 'warning' | 'error'; ephemeral?: boolean }): Promise<void>;
  disconnect(): Promise<void>;
  readonly rpc: {
    readonly extensions: {
      sendAttachmentsToMessage(params: {
        instanceId?: string;
        attachments: ExtensionContextAttachmentInput[];
      }): Promise<void>;
    };
  };
}

export interface CopilotSdkBoundary {
  createCanvas(options: CanvasOptions): Canvas;
  joinSession(config: JoinSessionConfig): Promise<CopilotExtensionSession>;
}

export type ExtensionTool = Tool;
export type ExtensionToolResult = ToolResultObject;
