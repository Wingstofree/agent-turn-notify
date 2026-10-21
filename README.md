# agent-turn-notify

模型停下来、**轮到你操作**的那一刻，桌面弹一条提醒；中途的子代理结束、后台任务完成、授权提示一律不打扰。
同一套脚本适配 **Qoder CLI / Claude Code / Codex CLI**，Windows 与 macOS/Linux 都有实现。

> The agent pops a desktop notification exactly once per finished turn — when control is
> handed back to you. Mid-task events stay silent. One script, three CLIs.

```bash
node install.mjs     # 自动检测你装了哪几个 CLI，写进各自配置（改前自动 .bak）
node verify.mjs      # 注入合成事件，断言"该弹的弹、该静的静"，并量出弹窗延迟
```

实测：脚本自身 **117–124ms** 出横幅，从进程被拉起到看见横幅 **471–501ms**（差额是 PowerShell 引擎冷启动）。

---

## 方法论：七个决定，不是七行代码

这套东西真正的成本不在通知本身，而在下面这七个判断。换任何 CLI、任何桌面平台都一样适用。

### 1. 事件选型决定噪音，而不是弹窗样式

一开始我注册了 6 个事件（`Stop`/`QueryEnd`/`Notification`/`SubagentStop`/`TaskCompleted`/`UserPromptSubmit`），结果是"一直在弹"。教训：**先问"这个事件发生时，球在谁手上"**。球在用户手上才弹；球还在模型/子代理/后台任务手上就不弹。

最后只留 `Stop`（Qoder/Claude）与 `agent-turn-complete`（Codex），其余全部静默。事件列表就是产品决策，写成一行常量便于反悔：

```powershell
$DoneEvents = @('Stop', 'agent-turn-complete')     # notify.ps1
DONE_EVENTS="Stop agent-turn-complete"             # notify.sh
```

> `Stop` 和 `QueryEnd` 会**同轮都触发**，只注册前者；不要指望"两个都注册再加去重"。

### 2. 横幅必须在声音之前，声音必须异步

第一版 `PlaySync()` 播放提示音后才 `ShowBalloonTip()`，而本机 `C:\Windows\Media\Ring01.wav` 约 **5.6 秒**（22050Hz/立体声/88200 B/s），于是弹窗整体晚了 5 秒——用户感知就是"根本没反应"。

正确顺序：`ShowBalloonTip()` → 记日志 → `SoundPlayer.Play()`（非阻塞）→ 最后才 `Start-Sleep` 维持横幅存活。音效首选短促的 `ding.wav`（0.40s），依次回落 `notify.wav`/`chimes.wav`，都没有就用 `SystemSounds::Exclamation`。

### 3. Windows 的两个编码陷阱，会让脚本"静默不干活"

| 陷阱 | 症状 | 处理 |
|---|---|---|
| `.ps1` 无 BOM | PowerShell 5.1 按 GBK 解码，中文串吞掉引号 → `字符串缺少终止符` ParserError | 存成 **UTF-8 with BOM**；`install.mjs` 复制时自动补 BOM |
| `[Console]::In.ReadToEnd()` | hook 的 stdin 是 UTF-8，但按 OEM 代码页（zh-CN=936）解码 → 含中文的 JSON `ConvertFrom-Json` 失败 | 按字节读：`New-Object IO.StreamReader([Console]::OpenStandardInput(), [Text.Encoding]::UTF8)` |

### 4. Stop hook 是双向通道，纯提醒也必须装死

`Stop` hook 的 **stdout 会被当 JSON 解析**，**exit 2 / `{"decision":"block"}` 会反向把模型拽回去继续干活**。所以：任何分支都 `exit 0`，任何调试输出走 stderr 或日志文件，永远别往 stdout 写。`verify.mjs` 专门有一条断言在守这个（stdout 非空即 FAIL）。

### 5. 传输通道三家不同，必须双入口

| CLI | 配置位置 | 完成事件 | 负载通道 | 关键字段 |
|---|---|---|---|---|
| Qoder CLI | `~/.qoder/settings.json` → `hooks.Stop` | `Stop` | **stdin** | `hook_event_name`, `session_id`, `cwd` |
| Claude Code | `~/.claude/settings.json` → `hooks.Stop` | `Stop` | **stdin** | 同上 + `prompt_id`, `permission_mode` |
| Codex CLI | `~/.codex/config.toml` → `notify` | `agent-turn-complete` | **最后一个 argv** | `type`, `cwd`, `input-messages`, `last-assistant-message`（kebab-case） |

Codex 这条是从源码确认的（`codex-rs/hooks/src/legacy_notify.rs`）：`command.arg(notify_payload)` 且 `stdin(Stdio::null()).stdout(null).stderr(null)`。所以脚本先试 argv 末位、再试 stdin；顺带一提，Codex 会送你 `last-assistant-message`，横幅正文直接用它比"任务完成"有用得多。

### 6. `async: true`，否则横幅的 13 秒寿命会拖慢会话

横幅要靠进程活着维持，那就让它后台活。`async` 的 hook 不阻塞 agent，`timeout: 30` 兜底。

### 7. 验证靠注入合成事件，不靠"我看着好像弹了"

`verify.mjs` 喂四种事件，断言两弹两静，并量 spawn→横幅的毫秒数。这一步揪出过两个纯靠肉眼看不到的高频坑：

- node 里 `detached: true` 会丢继承的 stdin 句柄 → 脚本读到空负载 → 静默 exit 0，看起来"hook 没触发"
- 忘记 `child.stdin.end(payload)` → 同上，症状一模一样

横幅是否真的显示还要看 Windows「焦点辅助/勿扰模式」，那部分只能人眼确认，所以脚本每次弹窗都往 `~/.agent-notify/notify.log` 追加一行含 `弹窗耗时 Nms` 的记录——把"有没有触发"和"有没有看见"拆成两个可独立观察的事实。

---

## 安装细节

`install.mjs` 无依赖、幂等、改前自动备份为 `<file>.bak-<时间戳>`：

- 把 `bin/notify.ps1`（补 BOM）或 `bin/notify.sh`（chmod 755）复制到 `~/.agent-notify/`
- Qoder / Claude：往 `settings.json` 的 `hooks.Stop` **追加**一条，不动你已有的其它 hook
- Codex：只在**顶层**写 `notify`。已有 `notify` 时**拒绝覆盖**（很多机器上这行属于 computer-use 工具链），要替换请显式 `--force`；插入位置在首个 `[table]` 之前，避免把顶层键写进表里
- `--target=qoder,claude` 手动指定；`--dry-run` 只打印不写盘

卸载：删掉对应 `hooks.Stop` 条目 / `notify` 行，再 `rm -rf ~/.agent-notify`，或用安装时留下的 `.bak-*` 直接还原。

## 想要别的时机

- **等授权也叫醒我**：把 `Notification` 加进事件列表（Codex 没有对应事件，只能在 Qoder/Claude 侧加）
- **整批任务全停下再弹**：改成"完成事件只 arm、静默 N 秒后若无新事件且你没发新指令才弹"（需要 pending token + watcher 进程 + `UserPromptSubmit` 撤销）。我实现过这一版，四条断言也都过了，但被否掉了——多一层状态就多一类"为什么不弹"的排查成本。**默认那版一行状态都不存，更容易长期维护**，所以这里不做。真要做得另开分支。

## 已知限制

- **Codex on Windows 长 prompt 会静默失效**：payload 走 argv，`input-messages` 会把整段 prompt 带上；超过约 32k 字符时进程创建失败且无报错（上游 [issue #18309](https://github.com/openai/codex/issues/18309)，本机 `codex-cli 0.135.0` 未复现出报错但也未能实测——后端不可达）。别把提醒当成交付保证。
- **Codex `notify` 官方标记为 legacy**，源码里有"hooks 体系成熟后移除"的 TODO；将来要迁到 `hooks` / `hooks.json`。
- 一次性 headless（`-p`）里横幅可能比 CLI 进程退出**更早**出现：`Stop` 在模型停下那刻就触发，不等 stdout 刷完。交互式会话无此现象。
- `detached` 子进程读不到 stdin（见方法论 7）。
- Windows 焦点辅助/勿扰会把横幅静默收进通知中心；`notify-send`/`osascript` 同理受系统通知设置约束。

## 文件

```
bin/notify.ps1   Windows：横幅 + 音效，stdin/argv 双入口，全程 exit 0
bin/notify.sh    macOS / Linux：osascript / notify-send，无 jq 依赖（grep 取字段）
install.mjs      三家配置写入：幂等、备份、拒绝覆盖 Codex notify
verify.mjs       合成事件断言 + 弹窗延迟测量
```

## License

未附许可证，默认保留所有权利。要开源请先补 LICENSE。
