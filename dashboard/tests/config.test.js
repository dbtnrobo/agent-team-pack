'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readConfig, sanitizePublicConfig } = require('../lib/config');

test('readConfig: ファイルを読んで JSON を返す', () => {
  const tmp = path.join(os.tmpdir(), `cfg-${process.pid}.json`);
  fs.writeFileSync(tmp, JSON.stringify({ siteTitle: 'X', agents: {} }));
  try {
    assert.deepEqual(readConfig(tmp), { siteTitle: 'X', agents: {} });
  } finally {
    fs.rmSync(tmp, { force: true });
  }
});

test('sanitizePublicConfig: serverOnly を一切含めない', () => {
  const full = {
    siteTitle: 'Dash', teamName: 'Team',
    agents: { alpha: { label: 'Alpha', color: '#3B82F6', secretField: 'x' } },
    serverOnly: { dataSources: { sessions: { projectsRoot: '/secret/path' } }, startCommands: { alpha: 'rm -rf /' } }
  };
  const pub = sanitizePublicConfig(full);
  assert.equal('serverOnly' in pub, false);
  assert.equal('startCommands' in pub, false);
});

test('sanitizePublicConfig: agents は label/color のみに絞る', () => {
  const pub = sanitizePublicConfig({ agents: { alpha: { label: 'J', color: '#111', extra: 'leak' } } });
  assert.deepEqual(pub.agents.alpha, { label: 'J', color: '#111' });
  assert.equal('extra' in pub.agents.alpha, false);
});

test('sanitizePublicConfig: 既定値で埋める', () => {
  const pub = sanitizePublicConfig({});
  assert.equal(pub.siteTitle, 'Dashboard');
  assert.equal(pub.teamName, 'Team');
  assert.equal(pub.timezone, 'Asia/Tokyo');
  assert.deepEqual(pub.agents, {});
});

test('sanitizePublicConfig: agent の label 未指定は agentId・color 未指定は既定色', () => {
  const pub = sanitizePublicConfig({ agents: { foo: {} } });
  assert.equal(pub.agents.foo.label, 'foo');
  assert.equal(pub.agents.foo.color, '#6B7280');
});
