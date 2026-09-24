import { createHash } from 'node:crypto';
import type { StartCommand } from './model';

const idPattern = /^[a-zA-Z0-9_-]{1,100}$/;
const fields = ['orgId', 'actorId', 'commandType', 'idempotencyKey', 'specHash'];
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function parseCommand(value: unknown): StartCommand {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_COMMAND');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).length !== fields.length || Object.keys(input).some(k => !fields.includes(k))) {
    throw new Error('INVALID_COMMAND_FIELDS');
  }
  for (const key of ['orgId', 'actorId', 'idempotencyKey']) {
    if (typeof input[key] !== 'string' || !idPattern.test(input[key])) throw new Error('INVALID_IDENTIFIER');
  }
  if (input.commandType !== 'poc.run' || typeof input.specHash !== 'string' || !/^[a-f0-9]{64}$/.test(input.specHash)) {
    throw new Error('INVALID_INTENT');
  }
  return { orgId: input.orgId as string, actorId: input.actorId as string, commandType: 'poc.run', idempotencyKey: input.idempotencyKey as string, specHash: input.specHash };
}

// The scope is an array, not delimiter concatenation: identifiers cannot collide by rearranging separators.
export function operationId(command: StartCommand): string {
  return 'poc-' + digest([command.orgId, command.actorId, command.commandType, command.idempotencyKey]);
}
export function requestHash(command: StartCommand): string {
  return digest([command.orgId, command.actorId, command.commandType, command.idempotencyKey, command.specHash]);
}

// Refuse accidental execution against a production or remote database.
export function testDatabaseUrl(raw: string | undefined): string {
  if (!raw) throw new Error('POC_DATABASE_URL_REQUIRED');
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('INVALID_TEST_DATABASE_URL'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      || !/^\/[a-z0-9_]+_test$/.test(url.pathname) || url.search || url.hash) {
    throw new Error('LOCAL_TEST_DATABASE_ONLY');
  }
  return raw;
}
export function testSchema(value: string): string {
  if (!/^zt_poc_[a-f0-9]{16}$/.test(value)) throw new Error('INVALID_TEST_SCHEMA');
  return value;
}
