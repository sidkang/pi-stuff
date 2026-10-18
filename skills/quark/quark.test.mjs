import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = fileURLToPath(new URL('.', import.meta.url));
const cli = `${root}scripts/quark-drive.cjs`;

// Exercise the real bundled command registration, result writer and process exit.
// Replace only external services/persistence before bootstrap. No real account,
// browser, network request or credential write is involved.
const driver = String.raw`
const fs = require('node:fs');
const Module = require('node:module');
const scenario = JSON.parse(fs.readFileSync(0, 'utf8'));
for (const name of ['node:http', 'node:https']) {
  const mod = require(name);
  mod.request = mod.get = () => { throw new Error('Unexpected network access'); };
}
global.fetch = () => { throw new Error('Unexpected fetch'); };
const cp = require('node:child_process');
cp.exec = cp.execSync = cp.spawn = () => { throw new Error('Unexpected process launch'); };
const source = fs.readFileSync(process.env.QUARK_TEST_CLI, 'utf8');
const marker = 'var DR=nm();';
if (source.split(marker).length !== 2) throw new Error('CLI bootstrap boundary changed');
`;

const stub = String.raw`
const fixture = JSON.parse(process.env.QUARK_TEST_SCENARIO);
const events = [];
const account = fixture.noAccount ? undefined : {accessToken:'test-access-token',userId:'test-user'};
const record = (name) => events.push(name);
const noop = new Proxy({}, {get: () => () => {}});
C = noop;
N = noop;
Np = () => {};
Jy = async () => ({clientDeviceId:'test-device',deviceName:'test',agentId:'pi',workDir:''});
xf = async () => { record('browser'); return {agentAuthCode:'browser-code'}; };
A = {
  runTimeType:'wild', detectAgent:()=>'pi', getCurrentEnv:()=>'prod', isCloudMode:()=>false,
  getAccount:async()=>account,
  permissionManager: {
    getLocalAccount:()=>account, getUserId:()=>account?.userId,
    getPersistedDeviceId:()=>fixture.noDevice ? '' : 'test-device',
    precheckConfigWritable:()=>{record('precheck');return {ok:!fixture.readOnly,configPath:'/test/config.json',errorCode:'EACCES'}},
    getDynamicClientInfo:()=>({clientId:'test-client',deviceId:'test-device'}),
    setAccessToken:()=>{}, setRefreshToken:()=>{},
    saveLocalAccount:async()=>{record('save');return {ok:true}}
  }
};
F = async () => ({oauth:{
  getUserInfo:async()=>{
    record('validate');
    if (fixture.networkError) throw new Error('offline');
    return fixture.validation || {status:0,data:{userId:'test-user',nickname:'测试账号'}};
  },
  getAuthorizePageUrl:async()=>{record('authorize');return {data:{authorizePageUrl:'https://example.invalid/auth',pageCode:'test-page'}}},
  getAgentAuthCode:async({agentAuthCode})=>{
    record('exchange');
    if (fixture.badToken) return {status:0,data:{status:'expired'}};
    return {status:0,data:{status:'install_confirmed',userId:'test-user',accessToken:'new-test-token',deviceId:'test-device'}};
  }
}});
process.on('exit',()=>process.stderr.write('TEST_EVENTS='+JSON.stringify(events)+'\n'));
`;

function login(fixture = {}, args = []) {
  // Compile with the original filename so bundled relative imports retain their base.
  const script = driver + `
const stub = ${JSON.stringify(stub)};
process.argv = [process.execPath, process.env.QUARK_TEST_CLI, 'login', ...scenario.args];
const m = new Module(process.env.QUARK_TEST_CLI);
m.filename = process.env.QUARK_TEST_CLI;
m.paths = Module._nodeModulePaths(require('node:path').dirname(m.filename));
m._compile(source.replace(marker, stub + marker), m.filename);
`;
  const result = spawnSync(process.execPath, ['-e', script], {
    input: JSON.stringify({ args }), encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, QUARK_TEST_CLI: cli, QUARK_TEST_SCENARIO: JSON.stringify(fixture) },
  });
  assert.ifError(result.error);
  const events = result.stderr.match(/TEST_EVENTS=(.*)/);
  assert.ok(events, result.stderr);
  const rows = result.stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(rows.length, 1, result.stdout);
  assert.equal(rows[0].type, 'result');
  assert.equal(rows[0].action, 'login');
  assert.doesNotMatch(result.stdout, /test-access-token|new-test-token|browser-code/);
  return { status: result.status, result: rows[0], events: JSON.parse(events[1]) };
}

test('validated existing login is an idempotent success, even with read-only config', () => {
  for (let i = 0; i < 2; i++) {
    const output = login({ readOnly: true });
    assert.equal(output.status, 0);
    assert.equal(output.result.code, 0);
    assert.deepEqual(output.result.data, { status: 'already_authorized', nickname: '测试账号' });
    assert.match(output.result.msg, /已登录.*测试账号.*授权有效/);
    assert.deepEqual(output.events, ['validate']);
  }
});

test('invalid, incomplete or failed validation must not claim an existing login is valid', () => {
  for (const fixture of [
    { validation: { status: 1, data: { userId: 'test-user', nickname: '测试账号' } } },
    { validation: { status: 0, data: { nickname: '测试账号' } } },
    { validation: { status: 0, data: { userId: 'test-user', nickname: ' ' } } },
    { networkError: true },
  ]) {
    const output = login({ ...fixture, readOnly: true });
    assert.equal(output.status, 1);
    assert.equal(output.result.code, -112);
    assert.deepEqual(output.events, ['validate', 'precheck']);
  }
});

test('missing account or device follows the normal browser login flow', () => {
  for (const fixture of [{ noAccount: true }, { noDevice: true }]) {
    const output = login(fixture);
    assert.equal(output.status, 0);
    assert.equal(output.result.code, 0);
    assert.equal(output.result.data.status, 'install_confirmed');
    assert.deepEqual(output.events, ['precheck', 'authorize', 'browser', 'exchange', 'save']);
  }
});

test('explicit authorization code still exchanges and saves instead of short-circuiting', () => {
  const output = login({}, ['--token', 'explicit-code']);
  assert.equal(output.status, 0);
  assert.equal(output.result.code, 0);
  assert.equal(output.result.data.status, 'install_confirmed');
  assert.deepEqual(output.events, ['precheck', 'exchange', 'save']);
});

test('invalid authorization code remains a failure despite an existing account', () => {
  const output = login({ badToken: true }, ['--token', 'expired-code']);
  assert.equal(output.status, 1);
  assert.equal(output.result.code, -102);
  assert.deepEqual(output.events, ['precheck', 'exchange']);
});

test('documented command examples resolve against the bundled CLI', () => {
  const files = ['SKILL.md', ...readdirSync(`${root}references`).filter((p) => p.endsWith('.md')).map((p) => `references/${p}`)];
  const commands = new Set();
  for (const file of files) {
    const text = readFileSync(`${root}${file}`, 'utf8');
    for (const match of text.matchAll(/\.\/scripts\/quark-drive\.cjs ([^\n]+)/g)) {
      const tokens = match[1].trim().split(/\s+/);
      if (tokens[0] === '<command>') continue;
      const command = tokens.slice(0, ['list', 'resume', 'delete', 'status', 'batches', 'reconcile'].includes(tokens[1]) ? 2 : 1);
      const flags = [...match[1].matchAll(/--[a-z-]+/g)].map((m) => m[0]);
      commands.add(JSON.stringify({ command, flags }));
    }
    for (const [, relative] of text.matchAll(/\]\(([^:)]+\.md)\)/g)) {
      assert.ok(readFileSync(new URL(relative, new URL(file, import.meta.url))).length);
    }
  }
  for (const entry of commands) {
    const { command, flags } = JSON.parse(entry);
    const output = spawnSync('./scripts/quark-drive.cjs', [...command, '--help'], { cwd: root, encoding: 'utf8', timeout: 10_000 });
    assert.equal(output.status, 0, output.stderr);
    assert.match(output.stdout, new RegExp(`Usage: quark-drive ${command.join(' ')}`));
    for (const flag of flags) assert.ok(output.stdout.includes(flag), `${command.join(' ')} lacks ${flag}`);
  }
});
