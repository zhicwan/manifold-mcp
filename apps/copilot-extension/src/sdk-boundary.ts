import type { Canvas, CanvasOptions, JoinSessionConfig } from '@github/copilot-sdk/extension';
import type { CopilotSession, MessageOptions, Tool, ToolResultObject } from '@github/copilot-sdk';

type SendAttachmentsToMessage = CopilotSession['rpc']['extensions']['sendAttachmentsToMessage'];

export interface CopilotExtensionSession {
  readonly workspacePath: CopilotSession['workspacePath'];
  send(options: MessageOptions): Promise<string>;
  log(...args: Parameters<CopilotSession['log']>): ReturnType<CopilotSession['log']>;
  disconnect(): ReturnType<CopilotSession['disconnect']>;
  readonly rpc: {
    readonly extensions: {
      sendAttachmentsToMessage: SendAttachmentsToMessage;
    };
  };
}

export interface CopilotSdkBoundary {
  createCanvas(options: CanvasOptions): Canvas;
  joinSession(config: JoinSessionConfig): Promise<CopilotExtensionSession>;
}

export type ExtensionTool = Tool;
export type ExtensionToolResult = ToolResultObject;
