'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const {
  isAllowedNavigation,
  isExternalWebUrl,
  isLoopbackHostname,
  shouldAttachToken,
  validateServerUrl,
} = require('../dist/shared.js')

test('accepts https servers and trims a trailing path slash', () => {
  assert.deepEqual(validateServerUrl('https://core.example.com/'), { ok: true, url: 'https://core.example.com' })
  assert.deepEqual(validateServerUrl('  https://core.example.com/core  '), { ok: true, url: 'https://core.example.com/core' })
  assert.deepEqual(validateServerUrl('https://core.example.com:8443'), { ok: true, url: 'https://core.example.com:8443' })
})

test('allows plain http only for loopback', () => {
  assert.equal(validateServerUrl('http://127.0.0.1:3001').ok, true)
  assert.equal(validateServerUrl('http://localhost:3001').ok, true)
  assert.equal(validateServerUrl('http://[::1]:3001').ok, true)
  const remote = validateServerUrl('http://core.example.com')
  assert.equal(remote.ok, false)
  assert.match(remote.reason, /https/u)
  assert.equal(isLoopbackHostname('127.0.0.1'), true)
  assert.equal(isLoopbackHostname('core.example.com'), false)
})

test('rejects malformed or unsafe addresses', () => {
  for (const value of ['', '   ', 'core.example.com', 'ftp://core.example.com', 'https://user:pass@core.example.com', 'https://core.example.com/?a=1', 'https://core.example.com/#x', undefined, 42]) {
    assert.equal(validateServerUrl(value).ok, false, String(value))
  }
})

test('stays inside the configured origin', () => {
  const server = 'https://core.example.com'
  assert.equal(isAllowedNavigation('https://core.example.com/workspaces/1', server), true)
  assert.equal(isAllowedNavigation('https://core.example.com', server), true)
  // A different origin, a lookalike host and a dry-run of the same prefix are all refused.
  assert.equal(isAllowedNavigation('https://evil.example.com/workspaces/1', server), false)
  assert.equal(isAllowedNavigation('https://core.example.com.evil.com/', server), false)
  assert.equal(isAllowedNavigation('https://core.example.com@evil.com/', server), false)
  assert.equal(isAllowedNavigation('http://core.example.com/', server), false)
  assert.equal(isAllowedNavigation('file:///etc/passwd', server), false)
  assert.equal(isAllowedNavigation('javascript:alert(1)', server), false)
})

test('attaches the token only to the configured origin', () => {
  const server = 'https://core.example.com'
  assert.equal(shouldAttachToken('https://core.example.com/api/v1/runs', server), true)
  assert.equal(shouldAttachToken('https://cdn.example.com/x.js', server), false)
  assert.equal(shouldAttachToken('https://core.example.com.evil.com/api', server), false)
})

test('opens only web URLs in the system browser', () => {
  assert.equal(isExternalWebUrl('https://docs.example.com'), true)
  assert.equal(isExternalWebUrl('http://docs.example.com'), true)
  assert.equal(isExternalWebUrl('file:///C:/Windows/System32/cmd.exe'), false)
  assert.equal(isExternalWebUrl('javascript:alert(1)'), false)
  assert.equal(isExternalWebUrl('ms-settings:'), false)
  assert.equal(isExternalWebUrl('not a url'), false)
})
