#!/usr/bin/env node
/*
 * agent-turn-notify self-test. Feeds synthetic hook events to the installed script and
 * asserts: completion events pop, mid-task events stay silent, stdout stays empty (a Stop
 * hook's stdout is parsed as JSON), and the balloon lands in well under a second.
 *
 *   node verify.mjs            # test the installed script (~/.agent-notify)
 *   node verify.mjs --local    # test ./bin before installing
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const isWin = process.platform === 'win32';
const local = process.argv.includes('--local');
const dir = local ? path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'bin')
                  : path.join(os.homedir(), '.agent-notify');
const script = path.join(dir, isWin ? 'notify.ps1' : 'notify.sh');
const logFile = path.join(os.homedir(), '.agent-notify', 'notify.log');
const CWD = process.cwd();

if (!fs.existsSync(script)) fail(`找不到 ${script}，先跑 node install.mjs`);
function fail(m) { console.error(m); process.exit(1); }

const wrap = (obj) => JSON.stringify(obj);
const ev = (name, extra = {}) => wrap({ session_id: 'verify', cwd: CWD, hook_event_name: name, ...extra });

const CASES = [
  { title: 'Stop（stdin 传输）期望弹窗', payload: ev('Stop'), stdin: true, expectPop: true },
  { title: 'agent-turn-complete（argv 传输，Codex 方式）期望弹窗',
    payload: wrap({ type: 'agent-turn-complete', 'thread-id': 't', 'turn-id': 'u', cwd: CWD, 'input-messages': ['帮我改个 bug'], 'last-assistant-message': '已修复，测试通过。' }),
    stdin: false, expectPop: true },
  { title: 'Notification（等待授权，属中途）期望静默',
    payload: ev('Notification', { message: '允许执行 git commit 吗？' }), stdin: true, expectPop: false },
  { title: 'SubagentStop / TaskCompleted（中途）期望静默', payload: ev('SubagentStop'), stdin: true, expectPop: false },
];

function killTree(pid) {
  if (!pid) return;
  if (isWin) spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  else { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
}

function logLines() {
  try { return fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).length; } catch { return 0; }
}

function runOne(c) {
  return new Promise((resolve) => {
    const launch = isWin
      ? { exe: 'powershell', argv: ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', script.replace(/\\/g, '/')] }
      : { exe: script, argv: [] };
    if (!c.stdin) launch.argv.push(c.payload);     // Codex appends the JSON as the last argv
    const before = logLines();
    const t0 = Date.now();
    // detached:true loses the inherited stdin handle on Windows, so the script would see
    // an empty payload and silently no-op — never detach here.
    const child = spawn(launch.exe, launch.argv, { cwd: CWD, stdio: ['pipe', 'pipe', 'ignore'] });
    if (c.stdin) { child.stdin.on('error', () => {}); child.stdin.end(c.payload); } else { child.stdin.end(); }
    let stdout = '';
    let settled = false;
    let iv = null;
    child.stdout?.on('data', (d) => { stdout += d; });
    const finish = (ok, detail) => { if (settled) return; settled = true; if (iv) clearInterval(iv); killTree(child.pid); resolve({ ok, detail, stdout }); };
    iv = setInterval(() => {
      const now = logLines();
      if (c.expectPop && now > before) finish(true, `弹窗耗时 ${Date.now() - t0}ms`);
      else if (Date.now() - t0 > 4000) {
        if (c.expectPop) finish(false, '4s 内没有弹窗记录');
        else finish(now === before, now === before ? '保持静默' : '不该弹窗却弹了');
      }
    }, 20);
    child.on('error', (e) => finish(false, e.message));
  });
}

console.log(`测试脚本: ${script}\n`);
let failed = 0;
for (const c of CASES) {
  const r = await runOne(c);
  const stdoutBad = r.stdout.trim().length > 0;
  const ok = r.ok && !stdoutBad;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.title}  —  ${r.detail}${stdoutBad ? ' / stdout 被污染!' : ''}`);
}
console.log(`\n${failed ? `${failed} 项失败` : '全部通过'} · 日志: ${logFile}`);
process.exit(failed ? 1 : 0);
