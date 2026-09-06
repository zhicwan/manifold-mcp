import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import type { CommittedModel, ModelingSession, RenderViewOptions, Report } from '@manifold3d/modeling/modeling.js';
import { MAX_CODE_BYTES } from '@manifold3d/modeling/validation/validators.js';

import type { CopilotExtensionSession, ExtensionTool, ExtensionToolResult } from './sdk-boundary.js';

const CAPTURE_VIEWS = new Set<NonNullable<RenderViewOptions['view']>>([
  'iso',
  'front',
  'back',
  'left',
  'right',
  'top',
  'bottom',
]);
const MAX_DESCRIPTION_LENGTH = 240;

export interface ExtensionToolsOptions {
  modelingSession: ModelingSession;
  publishModel(model: CommittedModel): void;
  getSession(): CopilotExtensionSession;
}

export function createExtensionTools(options: ExtensionToolsOptions): ExtensionTool[] {
  return [
    {
      name: 'manifold_validate_script',
      description:
        'Validate a manifold-3d TypeScript snippet in the sandbox without changing the current Viewer model.',
      parameters: codeParameters(false),
      handler: args =>
        toolOperation(async () => {
          const input = parseCodeArgs(args, false);
          const result = await options.modelingSession.validate({ code: input.code });
          return reportResult(result.report);
        }),
    },
    {
      name: 'manifold_execute_script',
      description:
        'Execute a manifold-3d TypeScript snippet and publish a successful model to every open Manifold Canvas.',
      parameters: codeParameters(true),
      handler: args =>
        toolOperation(async () => {
          const input = parseCodeArgs(args, true);
          const result = await options.modelingSession.execute(
            {
              code: input.code,
              ...(input.description !== undefined ? { description: input.description } : {}),
            },
            {
              beforeCommit: model => options.publishModel(model),
            },
          );
          return reportResult(result.report, result.model ? { modelRevision: result.model.revision } : {});
        }),
    },
    {
      name: 'manifold_capture_view',
      description: 'Render the current Manifold model to PNG and save it under the Copilot session workspace.',
      parameters: {
        type: 'object',
        properties: {
          view: {
            type: 'string',
            enum: [...CAPTURE_VIEWS],
            default: 'iso',
            description: 'Camera preset.',
          },
          width: {
            type: 'integer',
            minimum: 128,
            maximum: 2048,
            default: 1024,
          },
          height: {
            type: 'integer',
            minimum: 128,
            maximum: 2048,
            default: 1024,
          },
        },
        additionalProperties: false,
      },
      handler: args =>
        toolOperation(async () => {
          const renderOptions = parseCaptureArgs(args);
          const capture = await options.modelingSession.captureCurrent(renderOptions);
          if (!capture) {
            return failureResult(
              'NO_MODEL',
              'No model is available to capture. Run manifold_execute_script successfully first.',
            );
          }
          const session = options.getSession();
          if (!session.workspacePath) {
            return failureResult('WORKSPACE_UNAVAILABLE', 'The Copilot session workspace is unavailable.');
          }
          const captureDirectory = join(session.workspacePath, 'files', 'manifold3d-captures');
          await mkdir(captureDirectory, { recursive: true });
          const view = renderOptions.view ?? 'iso';
          const filePath = join(captureDirectory, `capture-r${capture.model.revision}-${view}-${randomUUID()}.png`);
          await writeFile(filePath, capture.result.png, { flag: 'wx' });
          return successResult({
            ok: true,
            filePath,
            modelRevision: capture.model.revision,
            view,
            width: capture.result.width,
            height: capture.result.height,
            renderBackend: 'software-rasterizer',
          });
        }),
    },
  ];
}

function codeParameters(withDescription: boolean): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      code: {
        type: 'string',
        minLength: 1,
        description:
          'TypeScript source that assigns the final Manifold to `result`. Available globals: Manifold, CrossSection, Mesh.',
      },
      ...(withDescription
        ? {
            description: {
              type: 'string',
              maxLength: MAX_DESCRIPTION_LENGTH,
              description: 'Optional short label displayed by the Viewer.',
            },
          }
        : {}),
    },
    required: ['code'],
    additionalProperties: false,
  };
}

function parseCodeArgs(value: unknown, withDescription: boolean): { code: string; description?: string } {
  const record = exactRecord(value, withDescription ? ['code', 'description'] : ['code'], 'Tool arguments');
  if (typeof record.code !== 'string' || record.code.length === 0) {
    throw new ExtensionToolInputError('INVALID_ARGUMENT', '`code` must be a non-empty string.');
  }
  if (Buffer.byteLength(record.code, 'utf8') > MAX_CODE_BYTES) {
    throw new ExtensionToolInputError('CODE_TOO_LARGE', `Source exceeds the ${MAX_CODE_BYTES} byte limit.`);
  }
  if (!withDescription || record.description === undefined) {
    return { code: record.code };
  }
  if (
    typeof record.description !== 'string' ||
    record.description.length === 0 ||
    record.description.length > MAX_DESCRIPTION_LENGTH ||
    hasUnsafeControlCharacter(record.description)
  ) {
    throw new ExtensionToolInputError(
      'INVALID_ARGUMENT',
      `\`description\` must be plain text no longer than ${MAX_DESCRIPTION_LENGTH} characters.`,
    );
  }
  return { code: record.code, description: record.description };
}

function parseCaptureArgs(value: unknown): RenderViewOptions {
  const record = exactRecord(value, ['view', 'width', 'height'], 'Tool arguments');
  const view = record.view ?? 'iso';
  if (typeof view !== 'string' || !CAPTURE_VIEWS.has(view as NonNullable<RenderViewOptions['view']>)) {
    throw new ExtensionToolInputError('INVALID_ARGUMENT', '`view` is not a supported camera preset.');
  }
  const width = boundedInteger(record.width ?? 1024, 'width');
  const height = boundedInteger(record.height ?? 1024, 'height');
  return {
    view: view as NonNullable<RenderViewOptions['view']>,
    width,
    height,
  };
}

function boundedInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 128 || value > 2048) {
    throw new ExtensionToolInputError('INVALID_ARGUMENT', `\`${label}\` must be an integer from 128 to 2048.`);
  }
  return value;
}

function exactRecord(value: unknown, allowedKeys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ExtensionToolInputError('INVALID_ARGUMENT', `${label} must be an object.`);
  }
  const record = value as Record<string, unknown>;
  const unexpected = Object.keys(record).find(key => !allowedKeys.includes(key));
  if (unexpected !== undefined) {
    throw new ExtensionToolInputError('INVALID_ARGUMENT', `${label} contains unsupported field \`${unexpected}\`.`);
  }
  return record;
}

async function toolOperation(operation: () => Promise<ExtensionToolResult>): Promise<ExtensionToolResult> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ExtensionToolInputError) {
      return failureResult(error.code, error.message);
    }
    const message = error instanceof Error ? error.message : String(error);
    return failureResult('EXTENSION_ERROR', message);
  }
}

function reportResult(report: Report, extra: Record<string, unknown> = {}): ExtensionToolResult {
  const body = { ...report, ...extra };
  if (report.ok) {
    return successResult(body);
  }
  return {
    textResultForLlm: JSON.stringify(body),
    resultType: 'failure',
    error: report.errors[0]?.message ?? 'Manifold validation failed.',
  };
}

function successResult(body: Record<string, unknown>): ExtensionToolResult {
  return {
    textResultForLlm: JSON.stringify(body),
    resultType: 'success',
  };
}

function failureResult(code: string, message: string): ExtensionToolResult {
  return {
    textResultForLlm: JSON.stringify({ ok: false, code, message }),
    resultType: 'failure',
    error: message,
  };
}

function hasUnsafeControlCharacter(value: string): boolean {
  return [...value].some(character => {
    const code = character.charCodeAt(0);
    return (code >= 0 && code <= 8) || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127;
  });
}

class ExtensionToolInputError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ExtensionToolInputError';
  }
}
