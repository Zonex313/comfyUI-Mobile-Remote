# 更新日志 / Changelog

<!-- 每次发布都保留中文和 English 两段，写实际变化，尽量简短。
     Keep both language sections for every release. Focus on real changes and keep it brief. -->

## v0.3.0 · 2026-09-17

### 中文

这次主要把手机上的工作流调起来更顺手了。

- 新版「高级」页可以直接调节点参数、顺着连线找节点，还有一张能收起来的小地图，看复杂工作流方便多了。
- 生成页和高级页共用手机副本，改完刷新也还在，不会动电脑上的原工作流。想重新取电脑那份，在设置里点「重新同步电脑工作流」即可；这会覆盖当前手机调整。
- 手机和电脑界面都支持中文、英文、日文、韩文，语言可以各自选。
- 高级页加载能看到真实进度，也修了导入工作流的失效连线、大图翻页闪图和长文字挤出按钮的问题。

更新后重启 ComfyUI，再刷新手机页面。

### English

This update makes workflows a little easier to work with on your phone.

- The new Advanced tab lets you edit node parameters, follow connections, and check a collapsible minimap without losing your place.
- Generate and Advanced share a phone-only copy that survives refreshes without changing your desktop workflow. To start again from the desktop version, use the resync option in Settings; it replaces your current phone adjustments.
- Both interfaces now support Chinese, English, Japanese, and Korean, with separate language choices for each device.
- Advanced now shows real loading progress. This release also fixes stale links in imported workflows, flashes when browsing full-size images, and text spilling out of buttons.

Restart ComfyUI after updating, then refresh the page on your phone.

## v0.2.2 · 2026-09-15

### 中文

- 可以导入已保存的工作流，让它常驻手机列表，不用一直在电脑前台打开。
- 改善生成、历史、收藏和翻页体验，历史到底时也有提示了。
- 修整随机标签、工作流同步和热更新，队列与历史读取也更快。
- 修复历史清理、收藏并发和自动更新的一些边界问题；发布包不带个人设置、凭据、收藏或工作流数据。

### English

- Import saved workflows to keep them available on your phone without leaving them open in the desktop editor.
- Smoother generation, history, favorites, and paging, with a clear end-of-history message.
- Improved random tags, workflow sync, and hot reload, plus faster queue and history reads.
- Fixed edge cases in history cleanup, concurrent favorites, and updates. Release packages exclude personal settings, credentials, favorites, and workflow data.

## v0.2.1 · 2026-09-11

### 中文

- 自动更新只保留最近两份备份，不再越用越占空间；旧版本已删除的文件也会清理，个人数据不动。
- 确认更新后如果远端版本变了，会提醒重新检查，避免装错版本。
- 电脑端「手机远程」标题旁可以看到当前版本号了。

### English

- Updates keep only the two latest backups and remove obsolete plugin files, leaving personal data untouched.
- If the remote version changes after you confirm an update, you will be asked to check again before installing.
- The desktop Mobile Remote panel now shows the installed version next to its title.

## v0.2.0 · 2026-09-11

### 中文

- 新增可选的随机标签 CLIP 编码节点，可锁定、忽略或复制标签；关闭标签模式时就是普通文本编码。面板里可以一键加入画布。
- 电脑面板增加「检查更新」，可以直接下载新版，更新失败会回滚。
- 手机列表只显示电脑端已保存且正在打开的工作流；常用参数留在外面，其余收进「高级参数」。

### English

- Added an optional random-tag CLIP encoder with tag locking, ignoring, and prompt copying. With tag mode off, it behaves like a regular text encoder. Add it to the canvas from the panel.
- The desktop panel can check for and install updates, with rollback if an update fails.
- The phone lists saved workflows currently open on the desktop. Common controls stay visible, while the rest move into Advanced Parameters.

## v0.1.2 · 2026-09-11

### 中文

- 大图关闭更及时，不用再等一下或点两次；紧接着打开另一张图，也不会被上一次的关闭操作误关。

### English

- Full-size images close promptly without a second tap. Opening another image immediately afterward no longer lets the previous close action dismiss it.

## v0.1.1 · 2026-09-11

### 中文

- 修复从历史页关闭大图后误跳到设置页的问题，并给查看器底部按钮加上按下反馈。

### English

- Fixed an accidental jump to Settings after closing an image from History, and added pressed feedback to the viewer buttons.

## v0.1.0 · 首个公开版本 / First Public Release

### 中文

- 手机浏览器通过 Tailscale 或 Cloudflare 临时链接使用电脑上的 ComfyUI，不改动已有工作流和连线。此版本尚未提供额外节点。
- 电脑侧栏统一管理连接；手机可生成、查看队列、历史和收藏，也能全屏看图。
- 内置提示词标签库、互斥与跳过规则、锁定与忽略，以及历史保存、缩略图、图片删除和工作流备份。

### English

- Use desktop ComfyUI from a phone browser through Tailscale or a temporary Cloudflare link without changing existing workflows or connections. This version did not add any nodes.
- Manage connections from the desktop sidebar. Generate images and browse the queue, history, favorites, and full-size images on your phone.
- Includes prompt tags, exclusion and skip rules, locking and ignoring, saved history, thumbnails, image deletion, and workflow backups.
