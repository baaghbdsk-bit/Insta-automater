'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const host = require('../src/host');

test('encodeKey keeps path separators and encodes reserved characters', () => {
  assert.equal(host.encodeKey('reels/2026-11-14/a b.mp4'), 'reels/2026-11-14/a%20b.mp4');
  assert.equal(host.encodeKey('a(b)*c'), 'a%28b%29%2Ac');
  assert.equal(host.encodeKey('simple-name_1.mp4'), 'simple-name_1.mp4');
});

test('signing is deterministic for a fixed clock', () => {
  const c = {
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'secret',
    region: 'auto',
    bucket: 'videos',
  };
  const date = new Date('2026-11-14T02:30:00.000Z');
  const args = {
    method: 'PUT',
    host: 'acct.r2.cloudflarestorage.com',
    canonicalUri: '/videos/reels/x.mp4',
    payloadHash: 'a'.repeat(64),
    extra: { 'content-type': 'video/mp4' },
    c,
    date,
  };
  const one = host.sign(args);
  const two = host.sign(args);

  assert.equal(one.authorization, two.authorization);
  assert.match(one.authorization, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20261114\/auto\/s3\/aws4_request,/);
  assert.match(one.authorization, /SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date/);
  assert.match(one.authorization, /Signature=[0-9a-f]{64}$/);
  assert.equal(one.headers['x-amz-date'], '20261114T023000Z');
  assert.equal(one.headers.host, 'acct.r2.cloudflarestorage.com');
});

test('signature changes when the payload hash changes', () => {
  const c = { accessKeyId: 'A', secretAccessKey: 'S', region: 'auto', bucket: 'b' };
  const date = new Date('2026-11-14T02:30:00.000Z');
  const base = {
    method: 'PUT',
    host: 'h',
    canonicalUri: '/b/k',
    extra: {},
    c,
    date,
  };
  const a = host.sign({ ...base, payloadHash: 'a'.repeat(64) });
  const b = host.sign({ ...base, payloadHash: 'b'.repeat(64) });
  assert.notEqual(a.authorization, b.authorization);
});

test('missing() names the unset variables instead of throwing', () => {
  const missing = host.missing();
  assert.ok(Array.isArray(missing));
  assert.equal(host.isConfigured(), missing.length === 0);
});

/**
 * AWS publishes a canonical SigV4 example ("GET Object" in the S3 API docs).
 * Matching its signature byte-for-byte proves the canonical request, the string
 * to sign, the key derivation and the HMAC chain are all correct — which is the
 * only part of the R2 client that cannot be caught by a unit test otherwise.
 */
test('matches the published AWS SigV4 GET Object vector', () => {
  const c = {
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    region: 'us-east-1',
    bucket: 'examplebucket',
  };

  const out = host.sign({
    method: 'GET',
    host: 'examplebucket.s3.amazonaws.com',
    canonicalUri: '/test.txt',
    payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    extra: {
      range: 'bytes=0-9',
    },
    c,
    date: new Date('2013-05-24T00:00:00.000Z'),
  });

  const signature = out.authorization.match(/Signature=([0-9a-f]{64})$/)[1];
  assert.equal(signature, 'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
  assert.match(out.authorization, /SignedHeaders=host;range;x-amz-content-sha256;x-amz-date/);
});
