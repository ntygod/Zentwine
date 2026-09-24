import assert from 'node:assert/strict';
import { test } from 'node:test';
import { operationId, parseCommand, requestHash, testDatabaseUrl, testSchema } from './identity';

const fixture = { orgId: 'org_demo', actorId: 'human_demo', commandType: 'poc.run' as const, idempotencyKey: 'request_1', specHash: 'a'.repeat(64) };
test('valid command is copied and has a stable identity', () => {
  const result = parseCommand(fixture); assert.notEqual(result, fixture);
  assert.equal(operationId(result), operationId(fixture));
});
test('property order does not affect fingerprint', () => {
  assert.equal(requestHash(fixture), requestHash(parseCommand(Object.fromEntries(Object.entries(fixture).reverse()))));
});
test('same key and changed intent retains operation identity but changes fingerprint', () => {
  const changed = { ...fixture, specHash: 'b'.repeat(64) };
  assert.equal(operationId(changed), operationId(fixture));
  assert.notEqual(requestHash(changed), requestHash(fixture));
});
test('organization and actor are separate idempotency scopes', () => {
  assert.notEqual(operationId(fixture), operationId({ ...fixture, orgId: 'other_org' }));
  assert.notEqual(operationId(fixture), operationId({ ...fixture, actorId: 'other_actor' }));
});
test('unexpected authority fields are rejected', () => {
  assert.throws(() => parseCommand({ ...fixture, admin: true }), /INVALID_COMMAND_FIELDS/);
});
test('malformed input does not leak the supplied value', () => {
  for (const value of [null, [], 'secret', { ...fixture, specHash: 'secret-value' }, { ...fixture, actorId: '../admin' }]) {
    assert.throws(() => parseCommand(value), error => error instanceof Error && !error.message.includes('secret-value'));
  }
});
test('only a dedicated local test database is accepted', () => {
  assert.equal(testDatabaseUrl('postgres://localhost/zentwine_poc_test'), 'postgres://localhost/zentwine_poc_test');
  for (const url of [undefined, 'invalid', 'postgres://remote/zentwine_poc_test', 'postgres://localhost/production', 'postgres://localhost/a_test?options=x']) {
    assert.throws(() => testDatabaseUrl(url));
  }
});
test('schema identifiers cannot inject SQL', () => {
  assert.equal(testSchema('zt_poc_0123456789abcdef'), 'zt_poc_0123456789abcdef');
  for (const name of ['public', 'zt_poc_bad;DROP SCHEMA public', 'zt_poc_123']) assert.throws(() => testSchema(name));
});
