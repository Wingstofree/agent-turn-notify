#!/usr/bin/env node
/*
 * agent-turn-notify installer — wires one notify script into Qoder CLI, Claude Code
 * and/or Codex CLI. No dependencies, idempotent, and it never silently overwrites an
 * existing Codex `notify` (that key is often owned by computer-use tooling).
 *
 *   node install.mjs                        # auto-detect installed CLIs
 *   node install.mjs --target=codex,claude
 *   node install.mjs --dry-run              # show what would change
 *   node install.mjs --force                # replace an existing notify/hooks entry
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const isWin = process.platform === 'win32';
const home = os.homedir();
const repoRoot = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const installDir = path.join(home, '.agent-notify');
const scriptPath = path.join(installDir, isWin ? 'notify.ps1' : 'notify.sh');
const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
};
const has = (name) => argv.includes(`--${name}`);
const dryRun = has('dry-run');
const force = has('force');

const TARGETS = {
  qoder: { dir: path.join(home, '.qoder'), label: 'Qoder CLI' },
  claude: { dir: path.join(home, '.claude'), label: 'Claude Code' },
  codex: { dir: path.join(home, '.codex'), label: 'Codex CLI' },
};

function detectTargets() {
  const t = flag('target', 'auto');
  if (t === 'all') return Object.keys(TARGETS);
  if (t !== 'auto') {
    const list = t.split(',').map((s) => s.trim()).filter(Boolean);
    for (const name of list) if (!TARGETS[name]) fail(`unknown --target "${name}" (qoder|claude|codex|auto|all)`);
    return list;
  }
  const found = Object.keys(TARGETS).filter((n) => fs.existsSync(TARGETS[n].dir));
  return found.length ? found : ['qoder'];
}

function fail(msg) {
  console.error(`agent-turn-notify: ${msg}`);
  process.exit(1);
}

function toPosix(p) {
  return p.replace(/\\/g, '/');
}

function writeFile(target, content, mode) {
  if (dryRun) {
    console.log(`\n[dry-run] ${target}\n${content}`);
    return;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (fs.existsSync(target)) {
    fs.copyFileSync(target, `${target}.bak-${ts}`);
    console.log(`  备份 -> ${target}.bak-${ts}`);
  }
  fs.writeFileSync(target, content, mode ? { mode } : undefined);
}

/* ------------------------------------------------------------------ scripts */

function installScripts() {
  const src = path.join(repoRoot, 'bin');
  fs.mkdirSync(installDir, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const from = path.join(src, name);
    const to = path.join(installDir, name);
    if (dryRun) {
      console.log(`[dry-run] 复制 ${from} -> ${to}`);
      continue;
    }
    let content = fs.readFileSync(from);
    // Windows PowerShell 5.1 reads a .ps1 without BOM as the OEM codepage, which
    // mangles the Chinese strings into parser errors. Guarantee a BOM on the way in.
    if (name.endsWith('.ps1') && !(content[0] === 0xef && content[1] === 0xbb && content[2] === 0xbf)) {
      content = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), content]);
      console.log('  notify.ps1 已补 UTF-8 BOM');
    }
    fs.writeFileSync(to, content);
    if (!isWin || name.endsWith('.sh')) fs.chmodSync(to, 0o755);
  }
  return toPosix(scriptPath);
}

/* ------------------------------------------------------- hook settings.json */

const hookCommand = isWin
  ? `powershell -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "${toPosix(scriptPath)}"`
  : `"${scriptPath}"`;

function mergeSettingsHook(settingsPath, label) {
  let config = {};
  if (fs.existsSync(settingsPath)) {
    try {
      config = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    } catch (e) {
      fail(`${settingsPath} 不是合法 JSON（${e.message}）——拒绝覆盖，请手动合并`);
    }
  }
  config.hooks ??= {};
  const existing = config.hooks.Stop ?? [];
  const already = JSON.stringify(existing).includes(toPosix(scriptPath));
  if (already && !force) {
    console.log(`  ${label}: Stop hook 已指向本脚本，跳过（--force 可重写）`);
    return;
  }
  const definition = {
    hooks: [
      {
        type: 'command',
        command: hookCommand,
        name: 'agent-turn-notify',
        async: true,          // the balloon lives ~13s; never block the agent on it
        timeout: 30,
      },
    ],
  };
  config.hooks.Stop = force ? [definition] : [...existing, definition];
  writeFile(settingsPath, `${JSON.stringify(config, null, 2)}\n`);
  console.log(`  ${label}: 已注册 hooks.Stop -> ${settingsPath}`);
}

/* ---------------------------------------------------------- codex config.toml */

const tomlString = (v) => `"${v.replace(/\\/g, '\\\\')}"`;

function codexNotifyArray() {
  return isWin
    ? [
        'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        '-NoProfile',
        '-NonInteractive',
        '-WindowStyle',
        'Hidden',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        toPosix(scriptPath),
      ].map(tomlString)
    : [tomlString(scriptPath)];
}

function writeCodexNotify(configPath) {
  const line = `notify = [${codexNotifyArray().join(', ')}]`;
  if (!fs.existsSync(configPath)) {
    writeFile(configPath, `# agent-turn-notify\n${line}\n`);
    console.log(`  Codex CLI: 已写入 notify -> ${configPath}`);
    return;
  }
  const text = fs.readFileSync(configPath, 'utf8');
  const existing = text.match(/^\s*notify\s*=.*$/im);
  if (existing) {
    if (!force) {
      console.log(`  Codex CLI: 已存在 notify（${existing[0].trim().slice(0, 90)}…）——不覆盖。确认要替换请加 --force`);
      return;
    }
    writeFile(configPath, text.replace(existing[0], `${line}  # agent-turn-notify`));
    console.log('  Codex CLI: 已替换 notify');
    return;
  }
  // `notify` is a top-level key: it must not land under a [table] header.
  const firstTable = text.search(/^\s*\[[^\]]+\]\s*$/m);
  const next = firstTable === -1
    ? `${text.replace(/\s*$/, '')}\n\n# agent-turn-notify\n${line}\n`
    : `${text.slice(0, firstTable)}\n# agent-turn-notify\n${line}\n\n${text.slice(firstTable)}`;
  writeFile(configPath, next);
  console.log('  Codex CLI: 已在首个 [table] 之前插入顶层 notify');
}

/* ------------------------------------------------------------------- main */

console.log(`平台 ${process.platform} · 安装到 ${installDir}`);
installScripts();
const targets = detectTargets();
console.log(`目标 CLI: ${targets.join(', ')}`);
for (const name of targets) {
  const { dir, label } = TARGETS[name];
  if (name === 'codex') {
    writeCodexNotify(path.join(dir, 'config.toml'));
  } else {
    mergeSettingsHook(path.join(dir, 'settings.json'), label);
  }
}
console.log(dryRun ? '\n--dry-run：未写入任何文件' : `\n完成。接着跑： node verify.mjs`);
