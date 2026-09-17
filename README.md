# ComfyUI Mobile Remote

在手机浏览器里选工作流、改参数、看出图，计算仍在电脑上的 ComfyUI 里完成。
Use workflows, adjust parameters, and view results from your phone browser. ComfyUI still runs on your computer.

[中文](#中文) | [English](#english) | [更新记录 / Changelog](CHANGELOG.md)

## 中文

### 能做什么

- 选工作流、改提示词与参数，支持文生图、图生图和手机上传图片。
- 在「高级」页调节点参数、沿连线跳转，用可折叠小地图查看工作流。
- 生成页与高级页共用独立的手机副本，刷新后保留调整，不会改动电脑上的原工作流。
- 查看进度、历史和收藏，重新生成或全屏看图；也提供可选的随机标签 CLIP 编码节点。
- 通过 Tailscale 或 Cloudflare 临时公网链接访问，界面支持中、英、日、韩四种语言。

### 致谢

「高级」页的节点面板使用并改编了 [comfyui-mobile-frontend](https://github.com/cosmicbuffalo/comfyui-mobile-frontend)（MIT）的组件代码，部分界面和交互也参考了该项目。感谢作者 [@cosmicbuffalo](https://github.com/cosmicbuffalo) 的开源分享。

### 安装与使用

1. 将插件文件夹命名为 `ComfyUI-Mobile-Remote`，放入 `ComfyUI/custom_nodes/`，然后重启 ComfyUI。
2. 打开电脑左侧快捷栏的「手机远程」面板，选择 Tailscale 或 Cloudflare，按面板提示连接。
3. 在手机浏览器打开面板提供的链接。Cloudflare 组件首次使用时会自动下载，不需要单独构建前端。

手机会列出电脑上已保存、当前打开的工作流。想让某个工作流常驻，在电脑的「手机远程」面板里点「导入工作流」。常驻后不用一直在电脑前台打开它，但 **ComfyUI 必须保持运行**。

没看到工作流时，先在电脑保存并打开它，稍等片刻，再回到手机生成页；也可以直接导入。手机语言在「设置」里切换，电脑语言在面板「标签管理」旁切换，两边各自保存。

需要用电脑当前版本替换手机副本时，先在电脑打开对应工作流，再到手机设置点「重新同步电脑工作流」。**这会覆盖当前手机调整**，不影响历史和收藏。

### 连接安全

- 插件没有登录或密码验证。Tailscale 访问由你的私有网络控制；Cloudflare 临时公网链接不要转发给别人，用完及时关闭。
- 局域网或 Tailscale 访问需要 ComfyUI 监听外部地址，例如启动时加 `--listen 0.0.0.0`。只在你信任的网络中开放访问。
- 更新后重启 ComfyUI，再刷新手机页面。版本变化见 [更新日志](CHANGELOG.md)。

## English

### What You Can Do

- Choose workflows, edit prompts and parameters, run text-to-image or image-to-image, and upload images from your phone.
- Edit node parameters in Advanced, follow connections, and check a collapsible workflow minimap.
- Generate and Advanced share a separate phone copy. Your adjustments survive refreshes without changing the original desktop workflow.
- Check progress, browse history and favorites, regenerate images, or open them full-screen. An optional random-tag CLIP encoder is also included.
- Connect through Tailscale or a temporary Cloudflare link. The interface supports Chinese, English, Japanese, and Korean.

### Acknowledgements

The Advanced tab's node panel uses and adapts component code from [comfyui-mobile-frontend](https://github.com/cosmicbuffalo/comfyui-mobile-frontend) (MIT), with parts of its UI and interactions also drawing on that project. Thanks to [@cosmicbuffalo](https://github.com/cosmicbuffalo) for sharing this work as open source.

### Install and Connect

1. Name the plugin folder `ComfyUI-Mobile-Remote`, place it in `ComfyUI/custom_nodes/`, and restart ComfyUI.
2. Open **Mobile Remote** from the desktop sidebar, choose Tailscale or Cloudflare, and follow the connection prompts.
3. Open the link shown in the panel on your phone. Cloudflare downloads its component on first use; no frontend build is needed.

The phone lists saved workflows currently open on the desktop. Use **Import Workflow** in the desktop panel to keep one available without leaving it open in the editor. **ComfyUI itself must still be running.**

If a workflow is missing, save and open it on the desktop, wait briefly, and return to Generate on your phone, or import it directly. Change the phone language in Settings and the desktop language beside Tag Management. Each device remembers its own choice.

To replace the phone copy with the current desktop version, open that workflow on the desktop and use the resync option in the phone Settings. **This replaces your current phone adjustments**, but leaves history and favorites untouched.

### Connection Safety

- The plugin has no login or password protection. Tailscale access is controlled by your private network. Do not share temporary public Cloudflare links, and close the tunnel when finished.
- LAN and Tailscale access require ComfyUI to listen on an external address, for example with `--listen 0.0.0.0`. Only expose it on networks you trust.
- After updating, restart ComfyUI and refresh the page on your phone. See the [changelog](CHANGELOG.md) for release notes.
