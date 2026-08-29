export const HOST_ACTION_PROTOCOL_VERSION = 1 as const;

export const MAX_HOST_ACTIONS = 32;
export const MAX_HOST_ACTION_ID_LENGTH = 64;
export const MAX_HOST_ACTION_LABEL_LENGTH = 80;
export const MAX_HOST_ACTION_MESSAGE_LENGTH = 512;
export const MAX_HOST_ACTION_INPUT_BYTES = 16 * 1024;
export const MAX_HOST_ACTION_ANNOTATION_IDS = 128;
export const MAX_HOST_ACTION_JSON_DEPTH = 8;

export type HostActionProtocolVersion = typeof HOST_ACTION_PROTOCOL_VERSION;
export type HostActionIcon = 'bot' | 'check' | 'download' | 'message' | 'play' | 'sparkles' | 'wand';
export type HostActionSlot = 'toolbar' | 'annotation-footer' | 'export-menu' | 'annotation-batch' | 'selection-gesture';
export type HostActionTone = 'default' | 'primary' | 'danger';
export type HostActionRequirement = 'model' | 'annotations';
export type HostActionState = 'accepted' | 'running' | 'succeeded' | 'failed';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface HostActionDescriptor {
  id: string;
  label: string;
  icon: HostActionIcon;
  slot: HostActionSlot;
  tone: HostActionTone;
  requires: HostActionRequirement[];
  disabledReason?: string;
}

export interface HostActionsManifestMessage {
  kind: 'host_actions_manifest';
  protocolVersion: HostActionProtocolVersion;
  actions: HostActionDescriptor[];
}

export interface HostActionInvocationMessage {
  kind: 'host_action_invoke';
  protocolVersion: HostActionProtocolVersion;
  requestId: string;
  actionId: string;
  modelVersion: string;
  annotationRevision: number;
  annotationIds?: string[];
  input?: JsonValue;
}

export interface HostActionStatusMessage {
  kind: 'host_action_status';
  protocolVersion: HostActionProtocolVersion;
  requestId: string;
  actionId: string;
  state: HostActionState;
  operationId?: string;
  message?: string;
}

export interface HostActionRequestIdentity {
  requestId: string;
  actionId: string;
}

export class HostActionProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HostActionProtocolError';
  }
}

export function createHostActionsManifest(actions: readonly HostActionDescriptor[]): HostActionsManifestMessage {
  return parseHostActionsManifest(
    {
      kind: 'host_actions_manifest',
      protocolVersion: HOST_ACTION_PROTOCOL_VERSION,
      actions: [...actions],
    },
    'Host actions manifest',
  );
}

export function createHostActionInvocation(
  message: Omit<HostActionInvocationMessage, 'kind' | 'protocolVersion'>,
): HostActionInvocationMessage {
  return parseHostActionInvocation({
    kind: 'host_action_invoke',
    protocolVersion: HOST_ACTION_PROTOCOL_VERSION,
    ...message,
  });
}

export function createHostActionStatus(
  message: Omit<HostActionStatusMessage, 'kind' | 'protocolVersion'>,
): HostActionStatusMessage {
  return parseHostActionStatus({
    kind: 'host_action_status',
    protocolVersion: HOST_ACTION_PROTOCOL_VERSION,
    ...message,
  });
}

export function parseHostActionsManifest(value: unknown, label = 'Host actions manifest'): HostActionsManifestMessage {
  const record = requireRecord(value, label);
  requireOnlyKeys(record, ['kind', 'protocolVersion', 'actions'], label);
  if (record.kind !== 'host_actions_manifest') {
    throw new HostActionProtocolError(`${label} kind must be "host_actions_manifest".`);
  }
  requireProtocolVersion(record.protocolVersion, label);
  if (!Array.isArray(record.actions) || record.actions.length > MAX_HOST_ACTIONS) {
    throw new HostActionProtocolError(`${label} actions must be an array with at most ${MAX_HOST_ACTIONS} items.`);
  }
  const actions = record.actions.map((action, index) => parseHostActionDescriptor(action, `Host action ${index}`));
  if (new Set(actions.map(action => action.id)).size !== actions.length) {
    throw new HostActionProtocolError(`${label} action ids must be unique.`);
  }
  return {
    kind: 'host_actions_manifest',
    protocolVersion: HOST_ACTION_PROTOCOL_VERSION,
    actions,
  };
}

export function isHostActionsManifest(value: unknown): value is HostActionsManifestMessage {
  try {
    parseHostActionsManifest(value);
    return true;
  } catch {
    return false;
  }
}

export function parseHostActionDescriptor(value: unknown, label = 'Host action descriptor'): HostActionDescriptor {
  const record = requireRecord(value, label);
  requireOnlyKeys(record, ['id', 'label', 'icon', 'slot', 'tone', 'requires', 'disabledReason'], label);
  const id = parseId(record.id, `${label} id`);
  const actionLabel = parseBoundedText(record.label, `${label} label`, MAX_HOST_ACTION_LABEL_LENGTH, false);
  if (!isHostActionIcon(record.icon)) {
    throw new HostActionProtocolError(`${label} icon is not supported.`);
  }
  if (!isHostActionSlot(record.slot)) {
    throw new HostActionProtocolError(`${label} slot is not supported.`);
  }
  if (!isHostActionTone(record.tone)) {
    throw new HostActionProtocolError(`${label} tone is not supported.`);
  }
  if (
    !Array.isArray(record.requires) ||
    record.requires.length > 2 ||
    !record.requires.every(isHostActionRequirement) ||
    new Set(record.requires).size !== record.requires.length
  ) {
    throw new HostActionProtocolError(`${label} requires must contain unique known requirements.`);
  }
  const disabledReason =
    record.disabledReason === undefined
      ? undefined
      : parseBoundedText(record.disabledReason, `${label} disabledReason`, MAX_HOST_ACTION_MESSAGE_LENGTH, false);
  return {
    id,
    label: actionLabel,
    icon: record.icon,
    slot: record.slot,
    tone: record.tone,
    requires: [...record.requires],
    ...(disabledReason !== undefined ? { disabledReason } : {}),
  };
}

export function parseHostActionInvocation(value: unknown): HostActionInvocationMessage {
  const label = 'Host action invocation';
  const record = requireRecord(value, label);
  requireOnlyKeys(
    record,
    [
      'kind',
      'protocolVersion',
      'requestId',
      'actionId',
      'modelVersion',
      'annotationRevision',
      'annotationIds',
      'input',
    ],
    label,
  );
  if (record.kind !== 'host_action_invoke') {
    throw new HostActionProtocolError(`${label} kind must be "host_action_invoke".`);
  }
  requireProtocolVersion(record.protocolVersion, label);
  const requestId = parseId(record.requestId, `${label} requestId`);
  const actionId = parseId(record.actionId, `${label} actionId`);
  const modelVersion = parseBoundedText(record.modelVersion, `${label} modelVersion`, 128, false);
  if (
    typeof record.annotationRevision !== 'number' ||
    !Number.isSafeInteger(record.annotationRevision) ||
    record.annotationRevision < 0
  ) {
    throw new HostActionProtocolError(`${label} annotationRevision must be a nonnegative safe integer.`);
  }
  let annotationIds: string[] | undefined;
  if (record.annotationIds !== undefined) {
    if (
      !Array.isArray(record.annotationIds) ||
      record.annotationIds.length > MAX_HOST_ACTION_ANNOTATION_IDS ||
      !record.annotationIds.every(item => typeof item === 'string')
    ) {
      throw new HostActionProtocolError(
        `${label} annotationIds must be an array with at most ${MAX_HOST_ACTION_ANNOTATION_IDS} ids.`,
      );
    }
    annotationIds = record.annotationIds.map((id, index) => parseId(id, `${label} annotationIds[${index}]`));
    if (new Set(annotationIds).size !== annotationIds.length) {
      throw new HostActionProtocolError(`${label} annotationIds must be unique.`);
    }
  }
  let input: JsonValue | undefined;
  if (record.input !== undefined) {
    if (!isSafeJsonValue(record.input)) {
      throw new HostActionProtocolError(
        `${label} input must be safe JSON no larger than ${MAX_HOST_ACTION_INPUT_BYTES} bytes.`,
      );
    }
    input = record.input;
  }
  return {
    kind: 'host_action_invoke',
    protocolVersion: HOST_ACTION_PROTOCOL_VERSION,
    requestId,
    actionId,
    modelVersion,
    annotationRevision: record.annotationRevision,
    ...(annotationIds !== undefined ? { annotationIds } : {}),
    ...(input !== undefined ? { input } : {}),
  };
}

export function isHostActionInvocation(value: unknown): value is HostActionInvocationMessage {
  try {
    parseHostActionInvocation(value);
    return true;
  } catch {
    return false;
  }
}

export function parseHostActionStatus(value: unknown): HostActionStatusMessage {
  const label = 'Host action status';
  const record = requireRecord(value, label);
  requireOnlyKeys(
    record,
    ['kind', 'protocolVersion', 'requestId', 'actionId', 'state', 'operationId', 'message'],
    label,
  );
  if (record.kind !== 'host_action_status') {
    throw new HostActionProtocolError(`${label} kind must be "host_action_status".`);
  }
  requireProtocolVersion(record.protocolVersion, label);
  const requestId = parseId(record.requestId, `${label} requestId`);
  const actionId = parseId(record.actionId, `${label} actionId`);
  if (!isHostActionState(record.state)) {
    throw new HostActionProtocolError(`${label} state is not supported.`);
  }
  const operationId =
    record.operationId === undefined ? undefined : parseId(record.operationId, `${label} operationId`, 128);
  const message =
    record.message === undefined
      ? undefined
      : parseBoundedText(record.message, `${label} message`, MAX_HOST_ACTION_MESSAGE_LENGTH, true);
  return {
    kind: 'host_action_status',
    protocolVersion: HOST_ACTION_PROTOCOL_VERSION,
    requestId,
    actionId,
    state: record.state,
    ...(operationId !== undefined ? { operationId } : {}),
    ...(message !== undefined ? { message } : {}),
  };
}

export function isHostActionStatus(value: unknown): value is HostActionStatusMessage {
  try {
    parseHostActionStatus(value);
    return true;
  } catch {
    return false;
  }
}

export function extractHostActionRequestIdentity(value: unknown): HostActionRequestIdentity | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (record.kind !== 'host_action_invoke') {
    return undefined;
  }
  try {
    return {
      requestId: parseId(record.requestId, 'Host action requestId'),
      actionId: parseId(record.actionId, 'Host action actionId'),
    };
  } catch {
    return undefined;
  }
}

export function isSafeJsonValue(value: unknown): value is JsonValue {
  const seen = new Set<object>();
  let nodes = 0;
  const visit = (item: unknown, depth: number): item is JsonValue => {
    nodes += 1;
    if (nodes > 2_048 || depth > MAX_HOST_ACTION_JSON_DEPTH) {
      return false;
    }
    if (item === null || typeof item === 'boolean' || typeof item === 'string') {
      return true;
    }
    if (typeof item === 'number') {
      return Number.isFinite(item);
    }
    if (!item || typeof item !== 'object' || seen.has(item)) {
      return false;
    }
    seen.add(item);
    if (Array.isArray(item)) {
      const valid = item.length <= 512 && item.every(entry => visit(entry, depth + 1));
      seen.delete(item);
      return valid;
    }
    const prototype = Object.getPrototypeOf(item);
    if (prototype !== Object.prototype && prototype !== null) {
      seen.delete(item);
      return false;
    }
    const entries = Object.entries(item);
    const valid =
      entries.length <= 256 &&
      entries.every(
        ([key, entry]) =>
          key.length <= 128 &&
          key !== '__proto__' &&
          key !== 'prototype' &&
          key !== 'constructor' &&
          visit(entry, depth + 1),
      );
    seen.delete(item);
    return valid;
  };

  if (!visit(value, 0)) {
    return false;
  }
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength <= MAX_HOST_ACTION_INPUT_BYTES;
  } catch {
    return false;
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HostActionProtocolError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireOnlyKeys(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(record).find(key => !allowedSet.has(key));
  if (unexpected !== undefined) {
    throw new HostActionProtocolError(`${label} contains unsupported field "${unexpected}".`);
  }
}

function requireProtocolVersion(value: unknown, label: string): void {
  if (value !== HOST_ACTION_PROTOCOL_VERSION) {
    throw new HostActionProtocolError(
      `${label} protocolVersion must be ${HOST_ACTION_PROTOCOL_VERSION}; received ${String(value)}.`,
    );
  }
}

function parseId(value: unknown, label: string, maxLength = MAX_HOST_ACTION_ID_LENGTH): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxLength ||
    !/^[A-Za-z0-9][-A-Za-z0-9._:]*$/.test(value)
  ) {
    throw new HostActionProtocolError(`${label} must be a safe identifier no longer than ${maxLength} characters.`);
  }
  return value;
}

function parseBoundedText(value: unknown, label: string, maxLength: number, allowEmpty: boolean): string {
  if (
    typeof value !== 'string' ||
    (!allowEmpty && value.trim().length === 0) ||
    value.length > maxLength ||
    hasUnsafeControlCharacter(value)
  ) {
    throw new HostActionProtocolError(`${label} must be bounded plain text no longer than ${maxLength} characters.`);
  }
  return value;
}

function hasUnsafeControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if ((code >= 0 && code <= 8) || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127) {
      return true;
    }
  }
  return false;
}

function isHostActionIcon(value: unknown): value is HostActionIcon {
  return (
    value === 'bot' ||
    value === 'check' ||
    value === 'download' ||
    value === 'message' ||
    value === 'play' ||
    value === 'sparkles' ||
    value === 'wand'
  );
}

function isHostActionSlot(value: unknown): value is HostActionSlot {
  return (
    value === 'toolbar' ||
    value === 'annotation-footer' ||
    value === 'export-menu' ||
    value === 'annotation-batch' ||
    value === 'selection-gesture'
  );
}

function isHostActionTone(value: unknown): value is HostActionTone {
  return value === 'default' || value === 'primary' || value === 'danger';
}

function isHostActionRequirement(value: unknown): value is HostActionRequirement {
  return value === 'model' || value === 'annotations';
}

function isHostActionState(value: unknown): value is HostActionState {
  return value === 'accepted' || value === 'running' || value === 'succeeded' || value === 'failed';
}
