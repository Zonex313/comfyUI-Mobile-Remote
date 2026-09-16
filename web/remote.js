import { ready as i18nReady, t } from "./i18n.js?v=202610125";

// 词典到位后再注册界面，否则侧边栏标题会先渲染成中文原文。
await i18nReady;
import { app } from "../../scripts/app.js";
import { createPresetManager } from "./preset-manager.js?v=202610125";
import { createWorkflowImporter } from "./workflow-import.js?v=202610125";

const TAB_ID = "mobile-remote";
const POLL_MS = 3000;
const CONNECTIONS_API = "/mobile/api/connections";
// 状态文案要在切换语言后重新取，所以做成函数而不是模块级常量。
function tunnelStates() {
  return {
    stopped: [t("未连接"), "muted"],
    installing: [t("安装中"), "pending"],
    starting: [t("连接中"), "pending"],
    connected: [t("已连接"), "success"],
    reconnecting: [t("重连中"), "pending"],
    error: [t("连接异常"), "error"],
  };
}

function tailscaleStates() {
  return {
    connected: [t("已连接"), "success"],
    unconfigured: [t("未配置"), "muted"],
    offline: [t("未在线"), "muted"],
  };
}

let mountedPanel = null;
let registered = false;
// 热更新会重新求值本模块：退订函数挂在全局上，免得旧闭包一直留着。
const remoteRuntime = globalThis.__MTR_REMOTE_RUNTIME || (globalThis.__MTR_REMOTE_RUNTIME = { unsubscribeLocale: null });

function element(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

function icon(name) {
  const node = element("i", `mobile-remote-icon pi pi-${name}`);
  node.setAttribute("aria-hidden", "true");
  return node;
}

function button(label, iconName, text = "") {
  const node = element("button", "mobile-remote-button");
  node.type = "button";
  node.title = label;
  node.setAttribute("aria-label", label);
  const glyph = icon(iconName);
  const caption = element("span", "mobile-remote-button-label", text);
  node.append(glyph, caption);
  node.classList.toggle("mobile-remote-icon-button", !text);
  return { node, glyph, caption };
}

function mobileUrl(value) {
  if (typeof value !== "string" || !value.trim()) return "";
  try {
    const url = new URL(value.trim());
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username || url.password ||
      !/^\/mobile\/?$/.test(url.pathname)
    ) return "";
    return value.trim();
  } catch {
    return "";
  }
}

function validateSnapshot(data) {
  const tunnel = data?.tunnel;
  const tailscale = data?.tailscale;
  if (
    data?.ok !== true ||
    !Object.hasOwn(tunnelStates(), tunnel?.state) ||
    typeof tunnel.url !== "string" ||
    typeof tunnel.message !== "string" ||
    typeof tunnel.autostart !== "boolean" ||
    typeof tunnel.enabled !== "boolean" ||
    typeof tunnel.binary_present !== "boolean" ||
    !Object.hasOwn(tailscaleStates(), tailscale?.state) ||
    !Array.isArray(tailscale.urls) ||
    !tailscale.urls.every((url) => typeof url === "string") ||
    typeof tailscale.message !== "string"
  ) throw new Error(t("返回的连接状态不完整，请刷新重试"));
  return data;
}

async function copyUrl(value) {
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      // HTTP pages and clipboard permission failures use the selection fallback.
    }
  }
  const previousFocus = document.activeElement;
  const field = element("textarea", "mobile-remote-clipboard");
  field.value = value;
  field.readOnly = true;
  field.setAttribute("aria-label", t("复制链接"));
  document.body.append(field);
  try {
    field.focus({ preventScroll: true });
    field.select();
    field.setSelectionRange(0, value.length);
    if (!document.execCommand("copy")) throw new Error(t("复制未成功，请选中地址手动复制"));
  } finally {
    field.remove();
    if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
  }
}

const TAG_NODE_TYPE = "MobileTagCLIPTextEncode";
const UPDATE_API = "/mobile/api/update";

// 更新检测按钮：平时是「检查更新」，发现新版就变成粉蓝高亮的「立即更新」。
function makeUpdateButton(onApply) {
  const entry = button(t("检查更新"), "refresh", t("检查更新"));
  entry.node.classList.add("mobile-remote-update");
  entry.glyph?.remove(); // 只要文字，不要图标
  const state = { hasUpdate: false, info: null, busy: false };

  const paint = () => {
    const ready = state.hasUpdate && !state.busy;
    entry.caption.textContent = state.busy ? t("处理中") : ready ? t("立即更新") : t("检查更新");
    entry.node.title = ready
      ? t("发现新版本 {value}，点击更新", { value: state.info?.latest || "" })
      : t("检查更新");
    if (ready) {
      // 粉蓝高亮（内联样式，不动样式表）
      entry.node.style.background = "linear-gradient(100deg, rgba(240,180,196,0.95), rgba(126,180,212,0.95))";
      entry.node.style.color = "#1b1d27";
      entry.node.style.borderColor = "transparent";
      entry.node.style.boxShadow = "0 0 10px rgba(126,180,212,0.45)";
      entry.node.style.fontWeight = "700";
    } else {
      entry.node.style.background = "";
      entry.node.style.color = "";
      entry.node.style.borderColor = "";
      entry.node.style.boxShadow = "";
      entry.node.style.fontWeight = "";
    }
  };

  const check = async (force) => {
    try {
      const response = await fetch(force ? `${UPDATE_API}?force=1` : UPDATE_API, { cache: "no-store" });
      const body = await response.json();
      state.info = body;
      state.hasUpdate = Boolean(body?.ok && body.has_update);
    } catch (error) {
      state.hasUpdate = false;
      state.info = { ok: false, error: error?.message || t("检查更新失败") };
    }
    paint();
    if (force) {
      // 手动点击必须有反馈：已是最新就短暂变绿，跟「链接已复制」用同一套样式
      const isLatest = !state.hasUpdate && state.info?.ok !== false;
      entry.node.classList.toggle("is-copied", isLatest);
      entry.caption.textContent = state.hasUpdate ? t("立即更新") : isLatest ? t("已是最新") : t("检查失败");
      window.setTimeout(() => {
        entry.node.classList.remove("is-copied");
        paint();
      }, 1800);
    }
  };

  entry.node.addEventListener("click", () => {
    if (state.busy) return;
    if (state.hasUpdate) {
      void onApply(state, paint, entry);
      return;
    }
    void check(true);
  });

  paint();
  void check(false); // 启动时静默检查一次
  return entry;
}

// 把自制节点放到画布正中央；返回空串表示成功，否则是错误说明。
function addTagNodeToCanvas() {
  const graph = app?.graph;
  const factory = globalThis.LiteGraph;
  if (!graph || typeof factory?.createNode !== "function") return t("画布还没准备好");
  const node = factory.createNode(TAG_NODE_TYPE);
  if (!node) return t("找不到节点类型，确认插件已加载后刷新页面");
  graph.add(node);
  try {
    const canvas = app.canvas;
    const rect = canvas.canvas.getBoundingClientRect();
    const scale = canvas.ds?.scale || 1;
    const offset = canvas.ds?.offset || [0, 0];
    node.pos = [
      (rect.width / 2) / scale - offset[0] - (node.size?.[0] || 340) / 2,
      (rect.height / 2) / scale - offset[1] - (node.size?.[1] || 200) / 2,
    ];
    canvas.selectNode?.(node, false);
    canvas.setDirty?.(true, true);
  } catch { /* 定位失败就用默认位置 */ }
  return "";
}

function mountPanel(container) {
  const root = element("section", "mobile-remote-panel");
  root.setAttribute("aria-label", t("手机远程连接"));
  const header = element("header", "mobile-remote-header");
  const heading = element("h2", "mobile-remote-heading");
  const headingText = element("span", "", t("手机远程"));
  const versionTag = element("span", "mobile-remote-version", "");
  // 版本号小字贴在「手机远程」右下角
  versionTag.style.fontSize = "9px";
  versionTag.style.fontWeight = "500";
  versionTag.style.opacity = "0.55";
  versionTag.style.marginLeft = "4px";
  versionTag.style.letterSpacing = "0";
  versionTag.style.verticalAlign = "-1px"; // 往右下压一点
  // 不能改成 flex：标题会被挤成两行（"手机远/程"），保持块级且禁止换行
  heading.style.whiteSpace = "nowrap";
  heading.append(headingText, versionTag);
  void fetch("/mobile/api/status", { cache: "no-store" })
    .then((response) => response.json())
    .then((body) => {
      const version = body?.version ? String(body.version) : "";
      if (version) setText(versionTag, `v${version}`);
    })
    .catch(() => { /* 版本号拿不到就不显示 */ });
  const tagsButton = button(t("标签管理"), "list", t("标签管理"));
  tagsButton.node.classList.add("mobile-remote-tags-entry");
  const backButton = button(t("返回连接"), "arrow-left", t("返回"));
  backButton.node.classList.add("mobile-remote-tags-back");
  backButton.node.hidden = true;
  // 语言按钮：图标式、不带文字，放在「标签管理」左边，点开是语言菜单。
  const languageButton = button(t("语言"), "globe");
  languageButton.node.classList.add("mobile-remote-language-entry");
  languageButton.node.setAttribute("aria-haspopup", "menu");
  languageButton.node.setAttribute("aria-expanded", "false");
  const languageMenu = element("div", "mobile-remote-language-menu");
  languageMenu.setAttribute("role", "menu");
  languageMenu.hidden = true;
  const languagePicker = element("div", "mobile-remote-language-picker");
  languagePicker.append(languageButton.node, languageMenu);
  const closeLanguageMenu = () => {
    languageMenu.hidden = true;
    languageButton.node.setAttribute("aria-expanded", "false");
  };
  const paintLanguageMenu = () => {
    languageMenu.replaceChildren();
    const api = globalThis.MobileI18n;
    if (!api) return;
    for (const item of api.locales) {
      const option = element("button", "mobile-remote-language-option", item.label);
      option.type = "button";
      option.setAttribute("role", "menuitemradio");
      option.setAttribute("aria-checked", String(item.id === api.locale));
      option.addEventListener("click", (event) => {
        event.stopPropagation();
        closeLanguageMenu();
        if (item.id !== api.locale) void api.set(item.id);
      });
      languageMenu.append(option);
    }
  };
  languageButton.node.addEventListener("click", (event) => {
    event.stopPropagation();
    if (languageMenu.hidden) {
      paintLanguageMenu();
      languageMenu.hidden = false;
      languageButton.node.setAttribute("aria-expanded", "true");
    } else closeLanguageMenu();
  });
  languageMenu.addEventListener("click", (event) => event.stopPropagation());
  const onLanguageKeydown = (event) => { if (event.key === "Escape") closeLanguageMenu(); };
  document.addEventListener("click", closeLanguageMenu);
  document.addEventListener("keydown", onLanguageKeydown);
  paintLanguageMenu();
  const headerActions = element("div", "mobile-remote-header-actions");
  const updateButton = makeUpdateButton(async (state, paint, entry) => {
    state.busy = true;
    paint();
    try {
      const confirmed = encodeURIComponent(state.info?.latest || "");
      const response = await fetch(`${UPDATE_API}/apply?confirm=1&version=${confirmed}`, {
        method: "POST",
        cache: "no-store",
      });
      const body = await response.json();
      if (body?.ok) {
        state.hasUpdate = false;
        state.busy = false;
        paint();
        entry.caption.textContent = t("已更新");
        window.alert(t("已更新到 {updated_to}（{copied_count} 个文件）\n旧版本备份在 {backup}\n请重启 ComfyUI 生效", { updated_to: body.updated_to, copied_count: body.copied_count, backup: body.backup }));
      } else {
        state.busy = false;
        paint();
        window.alert(t("更新失败：{error}", { error: body?.error || t("未知错误") }));
      }
    } catch (error) {
      state.busy = false;
      paint();
      window.alert(t("更新失败：{value}", { value: error?.message || error }));
    }
  });
  headerActions.append(languagePicker, tagsButton.node, updateButton.node);
  header.append(heading, headerActions);
  const readError = element("p", "mobile-remote-error mobile-remote-read-error");
  readError.setAttribute("role", "alert");
  readError.hidden = true;
  const connectView = element("div", "mobile-remote-connect");
  const tagsManager = createPresetManager({ element, button, setText });
  root.append(header, readError, connectView, tagsManager.node);

  let snapshot = null;
  let disposed = false;
  let active = false;
  let intersecting = true;
  let epoch = 0;
  let pollTimer = 0;
  let reading = false;
  let pendingAction = null;
  let readErrorText = "";
  let actionErrorText = "";
  const requests = new Set();

  function makeCard(name, kind, subtitle) {
    const card = element("section", `mobile-remote-card mobile-remote-${kind}`);
    const cardHeader = element("div", "mobile-remote-card-header");
    const titleGroup = element("div", "mobile-remote-card-title-group");
    // 标题里分隔符后面的部分不加粗（例如 Cloudflare丨临时公网）。
    // 中文原文用「丨」，译文用 ASCII 竖线，两种都认，原样保留分隔符。
    const title = element("h3", "mobile-remote-card-title");
    const separator = /[丨|]/.exec(String(name))?.[0] ?? "丨";
    const [titleHead, ...titleRest] = String(name).split(/[丨|]/);
    title.append(element("span", "", titleHead));
    if (titleRest.length) {
      const soft = element("span", "", separator + titleRest.join(separator));
      soft.style.fontWeight = "400";
      soft.style.opacity = "0.75";
      title.append(soft);
    }
    title.id = `mobile-remote-${kind}-title`;
    card.setAttribute("aria-labelledby", title.id);
    titleGroup.append(title);
    // 副标题留空就整行不渲染（标题已经自带说明时不需要重复一行）
    if (subtitle) titleGroup.append(element("p", "mobile-remote-subtitle", subtitle));
    const status = element("span", "mobile-remote-status", t("读取中"));
    status.dataset.tone = "muted";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    status.setAttribute("aria-atomic", "true");
    cardHeader.append(titleGroup, status);
    const address = element("div", "mobile-remote-address");
    const field = element("textarea", "mobile-remote-url");
    field.id = `mobile-remote-${kind}-url`;
    field.setAttribute("aria-label", t("{name} 访问地址", { name: name }));
    field.readOnly = true;
    field.rows = 1;
    field.spellcheck = false;
    field.autocomplete = "off";
    field.dir = "ltr";
    field.placeholder = t("正在获取连接状态");
    field.classList.add("is-masked");
    const urlActions = element("div", "mobile-remote-url-actions");
    const copy = button(t("复制 {name} 链接", { name: name }), "copy");
    const reveal = button(t("显示 {name} 链接", { name: name }), "eye");
    const open = button(t("打开 {name} 链接", { name: name }), "external-link");
    copy.node.disabled = true;
    reveal.node.disabled = true;
    open.node.disabled = true;
    urlActions.append(copy.node, reveal.node, open.node);
    address.append(field, urlActions);
    const message = element("p", "mobile-remote-message");
    message.hidden = true;
    const feedback = element("p", "mobile-remote-feedback");
    feedback.setAttribute("role", "status");
    feedback.setAttribute("aria-live", "polite");
    feedback.hidden = true;
    card.append(cardHeader, address, message, feedback);
    connectView.append(card);
    const result = { card, status, field, address, copy, reveal, open, message, feedback, copyBusy: false, usable: false, revealed: false, copyTimer: 0, restoreCopy: null };

    function paintReveal() {
      const shown = result.revealed;
      field.classList.toggle("is-masked", result.usable && !shown);
      field.title = shown && result.usable ? field.value : "";
      reveal.glyph.className = `mobile-remote-icon pi pi-${shown ? "eye-slash" : "eye"}`;
      reveal.node.title = t("按住显示明文");
      reveal.node.setAttribute("aria-label", t("按住显示明文"));
      reveal.node.setAttribute("aria-pressed", shown ? "true" : "false");
    }
    function setRevealed(on) {
      if (disposed) return;
      result.revealed = Boolean(on && result.usable);
      paintReveal();
    }
    paintReveal();
    reveal.node.addEventListener("pointerdown", (event) => {
      if (disposed || !result.usable || event.button) return;
      reveal.node.setPointerCapture(event.pointerId);
      setRevealed(true);
    });
    reveal.node.addEventListener("pointerup", () => setRevealed(false));
    reveal.node.addEventListener("pointercancel", () => setRevealed(false));
    reveal.node.addEventListener("lostpointercapture", () => setRevealed(false));
    reveal.node.addEventListener("click", (event) => event.preventDefault());

    function restoreCopyButton() {
      window.clearTimeout(result.copyTimer);
      result.copyTimer = 0;
      copy.node.classList.remove("is-copied");
      setText(copy.caption, "");
      copy.glyph.className = "mobile-remote-icon pi pi-copy";
      copy.glyph.hidden = false;
      if (feedback.dataset.tone === "success") {
        feedback.hidden = true;
        setText(feedback, "");
      }
    }
    result.restoreCopy = restoreCopyButton;
    copy.node.addEventListener("click", async () => {
      if (disposed || !result.usable || result.copyBusy) return;
      const value = field.value;
      result.copyBusy = true;
      feedback.hidden = true;
      try {
        await copyUrl(value);
        if (!disposed && result.usable) {
          // 图标按钮保持正方形：勾表示成功，完整译文放到卡片已有的反馈行，
          // 否则日语「コピーしました」会把按钮撑破。
          copy.node.classList.add("is-copied");
          setText(copy.caption, "");
          copy.glyph.className = "mobile-remote-icon pi pi-check";
          copy.glyph.hidden = false;
          feedback.dataset.tone = "success";
          setText(feedback, t("已复制"));
          feedback.hidden = false;
          window.clearTimeout(result.copyTimer);
          result.copyTimer = window.setTimeout(() => {
            if (!disposed) restoreCopyButton();
          }, 3000);
        }
      } catch {
        if (!disposed && field.value === value) {
          restoreCopyButton();
          feedback.dataset.tone = "error";
          setText(feedback, t("复制未成功，请选中地址手动复制"));
          feedback.hidden = false;
          field.focus({ preventScroll: true });
          field.select();
        }
      } finally {
        result.copyBusy = false;
      }
    });
    open.node.addEventListener("click", () => {
      const url = mobileUrl(field.value);
      if (!disposed && result.usable && url) window.open(url, "_blank", "noopener,noreferrer");
    });
    return result;
  }

  const warning = element("section", "mobile-remote-card mobile-remote-warning");
  warning.setAttribute("role", "alert");
  warning.append(element(
    "p",
    "mobile-remote-warning-text",
    t("公网链接暴露是非常危险的事，所以即便是临时公网，也请务必保护好自己的链接避免外泄！"),
  ));
  connectView.append(warning);

  // 工作流相关的两个按钮并排一张卡片；卡片上不放任何文字，
  // 有关工作流的说明都写在「导入工作流」子页里。
  const actionCard = element("section", "mobile-remote-card mobile-remote-action-card");
  const actionRow = element("div", "mobile-remote-action-row");
  const nodeButton = button(t("加入随机标签节点"), "plus", t("加入随机标签节点"));
  nodeButton.node.addEventListener("click", () => {
    const error = addTagNodeToCanvas();
    const original = t("加入随机标签节点");
    nodeButton.caption.textContent = error ? t("加入失败") : t("已加入画布");
    window.setTimeout(() => { nodeButton.caption.textContent = original; }, 2000);
  });
  const importButton = button(t("导入工作流"), "download", t("导入工作流"));
  importButton.node.addEventListener("click", () => showView("import"));
  actionRow.append(nodeButton.node, importButton.node);
  actionCard.append(actionRow);
  connectView.append(actionCard);

  const importer = createWorkflowImporter({ element, button, setText });
  root.append(importer.node);

  const cloud = makeCard(t("Cloudflare丨临时公网"), "cloud", "");
  const tunnelActions = element("div", "mobile-remote-tunnel-actions");
  const toggleButton = button(t("连接 Cloudflare"), "play", t("连接"));
  toggleButton.node.classList.add("mobile-remote-primary");
  const restartButton = button(t("重新连接 Cloudflare"), "refresh", t("重新连接"));
  tunnelActions.append(toggleButton.node, restartButton.node);
  const autoLabel = element("label", "mobile-remote-autostart");
  const autoCheckbox = element("input", "mobile-remote-checkbox");
  autoCheckbox.type = "checkbox";
  autoLabel.append(autoCheckbox, element("span", "", t("Tailscale 不在线时自动连接")));
  const actionError = element("p", "mobile-remote-error");
  actionError.setAttribute("role", "alert");
  actionError.hidden = true;
  cloud.card.append(
    tunnelActions,
    autoLabel,
    actionError,
    element("p", "mobile-remote-note", t("手机浏览器输入上方网址即可，重启后网址会变化")),
  );

  const tail = makeCard(t("Tailscale丨私人网络"), "tailscale", "");
  const tailChoice = element("select", "mobile-remote-select");
  tailChoice.setAttribute("aria-label", t("选择 Tailscale 地址"));
  tailChoice.hidden = true;
  tail.card.insertBefore(tailChoice, tail.address);
  let tailUrls = [];

  function link(href, text) {
    const node = element("a", "mobile-remote-link", text);
    node.href = href;
    node.target = "_blank";
    node.rel = "noopener noreferrer";
    return node;
  }

  function list(items, ordered = false) {
    const node = element(ordered ? "ol" : "ul", "mobile-remote-list");
    items.forEach((item) => {
      const row = element("li", "");
      if (typeof item === "string") row.textContent = item;
      else row.append(...item);
      node.append(row);
    });
    return node;
  }

  const guide = element("section", "mobile-remote-card mobile-remote-guide");
  guide.setAttribute("aria-labelledby", "mobile-remote-guide-title");
  const guideTitle = element("h3", "mobile-remote-card-title", t("怎么选"));
  guideTitle.id = "mobile-remote-guide-title";
  const compare = element("div", "mobile-remote-compare");
  const cloudCol = element("div", "mobile-remote-compare-col");
  cloudCol.append(
    element("strong", "", "Cloudflare"),
    element("p", "mobile-remote-note", t("傻瓜式，适合完全不愿折腾的小白，代价是慢且稳定性较差。点「连接」就能出链接，手机不用装额外软件。")),
    element("p", "mobile-remote-note", t("适合偶尔外出看一眼。带宽有限，大图和刷新可能慢；重启后地址会变，要重新复制。")),
  );
  const tailCol = element("div", "mobile-remote-compare-col");
  tailCol.append(
    element("strong", "", "Tailscale"),
    element("p", "mobile-remote-note", t("稍微复杂一点：电脑和手机都要下载 Tailscale 并登录同一个账号。连上后更快、更稳，地址也更固定。")),
    element("p", "mobile-remote-note", t("适合经常用、要看大图或长时间开着。第一次配好之后，之后几乎不用管。")),
  );
  compare.append(cloudCol, tailCol);
  const tips = element("p", "mobile-remote-note", t("两者均为免费加密通道，Cloudflare 谁拿到链接都能打开；Tailscale 只有你账号下的设备能进。"));
  // 整句交给翻译，{link} 换成真实节点：按词序把句子拆成碎片，日语和韩语会拼歪。
  function tNodes(template, parts) {
    const nodes = [];
    const re = /\{(\w+)\}/g;
    let last = 0;
    let match;
    while ((match = re.exec(template))) {
      if (match.index > last) nodes.push(template.slice(last, match.index));
      nodes.push(parts[match[1]] ?? match[0]);
      last = match.index + match[0].length;
    }
    if (last < template.length) nodes.push(template.slice(last));
    return nodes;
  }

  function platformGuide(title, items) {
    const block = element("div", "mobile-remote-guide-block");
    block.append(element("strong", "", title), list(items, true));
    return block;
  }
  const installBody = element("div", "mobile-remote-install");
  installBody.hidden = true;
  installBody.append(
    platformGuide(t("电脑"), [
      tNodes(t("打开 {link}，安装 Windows 版。"), {
        link: link("https://tailscale.com/download/windows", t("电脑下载页")),
      }),
      t("用 Google、Microsoft 或邮箱登录，记住这个账号。"),
      t("右下角图标显示已连接。开机后保持在线。"),
      t("回到这个页面，Tailscale 卡片会出现地址。"),
    ]),
    platformGuide(t("安卓"), [
      tNodes(t("打开 {link}，用 Google Play 或官方 APK 安装。国内应用商店搜 Tailscale 也可以。"), {
        link: link("https://tailscale.com/download/android", t("安卓下载页")),
      }),
      t("用和电脑相同的账号登录。"),
      t("打开连接开关，系统要求允许 VPN 时选允许。"),
      t("复制这边的 Tailscale 地址，用手机浏览器打开。"),
    ]),
    platformGuide(t("苹果"), [
      tNodes(t("App Store 搜 Tailscale，或打开 {link}。"), {
        link: link("https://apps.apple.com/app/tailscale/id1470499037", t("App Store 下载页")),
      }),
      t("用和电脑相同的账号登录。"),
      t("打开连接开关，允许添加 VPN。"),
      t("复制这边的 Tailscale 地址，用 Safari 打开。"),
    ]),
  );
  const installButton = button(t("怎么装 Tailscale"), "info-circle", t("怎么装 Tailscale"));
  installButton.node.classList.add("mobile-remote-install-button");
  installButton.node.setAttribute("aria-expanded", "false");
  installButton.node.addEventListener("click", () => {
    const open = installBody.hidden;
    installBody.hidden = !open;
    installButton.node.setAttribute("aria-expanded", open ? "true" : "false");
  });
  guide.append(guideTitle, compare, tips, installButton.node, installBody);
  connectView.append(guide);
  container.replaceChildren(root);

  function visible() {
    return !disposed && root.isConnected && intersecting &&
      document.visibilityState === "visible" && root.getClientRects().length > 0 &&
      (typeof root.checkVisibility !== "function" ||
        root.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true }));
  }

  function current(token) {
    return !disposed && active && token === epoch;
  }

  function clearPoll() {
    window.clearTimeout(pollTimer);
    pollTimer = 0;
  }

  function cancelWork() {
    epoch += 1;
    clearPoll();
    for (const request of requests) {
      window.clearTimeout(request.timer);
      request.controller.abort();
    }
    requests.clear();
    reading = false;
    pendingAction = null;
  }

  function schedulePoll() {
    clearPoll();
    if (!active || reading || pendingAction || !visible()) return;
    pollTimer = window.setTimeout(() => {
      pollTimer = 0;
      void refresh();
    }, POLL_MS);
  }

  function showMessage(node, text) {
    setText(node, text);
    node.hidden = !text;
  }

  function fitUrlField(field) {
    field.style.height = "auto";
    field.style.height = `${Math.max(field.scrollHeight, 32)}px`;
  }

  function paintUrl(card, value, placeholder, usable) {
    const live = Boolean(value && usable);
    const shown = live ? value : (placeholder || "");
    if (card.field.value !== shown) {
      card.field.value = shown;
      card.feedback.hidden = true;
    }
    card.field.placeholder = live ? "" : (placeholder || "");
    card.usable = live;
    if (!live) card.restoreCopy?.();
    card.field.classList.toggle("is-status", !live);
    card.field.classList.toggle("is-masked", live && !card.revealed);
    card.field.title = live && card.revealed ? value : "";
    card.copy.node.disabled = !live || card.copyBusy;
    if (card.reveal) card.reveal.node.disabled = !live;
    card.open.node.disabled = !live;
    fitUrlField(card.field);
    window.requestAnimationFrame(() => fitUrlField(card.field));
  }

  function paintStatus(card, status) {
    const [label, tone] = status;
    setText(card.status, label);
    card.status.dataset.tone = tone;
  }

  function tunnelRunning(tunnel) {
    return Boolean(tunnel && (tunnel.enabled ||
      ["installing", "starting", "connected", "reconnecting"].includes(tunnel.state)));
  }

  function paint() {
    const tunnel = snapshot?.tunnel;
    const tailscale = snapshot?.tailscale;
    const busy = Boolean(pendingAction);
    showMessage(readError, readErrorText);
    showMessage(actionError, actionErrorText);
    paintStatus(cloud, tunnel ? tunnelStates()[tunnel.state] : [readErrorText ? t("未获取") : t("读取中"), "muted"]);
    paintStatus(tail, tailscale ? tailscaleStates()[tailscale.state] : [readErrorText ? t("未获取") : t("读取中"), "muted"]);

    const cloudUrl = tunnel?.state === "stopped" ? "" : mobileUrl(tunnel?.url);
    const cloudHint = tunnel?.state === "connected" && !cloudUrl
      ? t("暂未获取到有效链接，请刷新重试")
      : (t(tunnel?.message) || (tunnel ? t("连接后显示链接") : t("等待获取连接状态")));
    paintUrl(cloud, cloudUrl, cloudHint, tunnel?.state === "connected");
    showMessage(cloud.message, "");

    const running = tunnelRunning(tunnel);
    const tailOnline = tailscale?.state === "connected";
    const toggling = pendingAction && pendingAction.action !== "settings" && pendingAction.action !== "restart";
    toggleButton.node.disabled = !tunnel || busy || (tailOnline && !running);
    const toggleLabel = toggling ? (pendingAction.action === "stop" ? t("停止中") : t("连接中")) : (running ? t("停止") : t("连接"));
    setText(toggleButton.caption, toggleLabel);
    toggleButton.node.title = tailOnline && !running ? t("Tailscale 在线时无需连接 Cloudflare") : `${toggleLabel} Cloudflare`;
    toggleButton.node.setAttribute("aria-label", toggleButton.node.title);
    toggleButton.node.setAttribute("aria-busy", String(Boolean(toggling)));
    toggleButton.glyph.className = `mobile-remote-icon pi pi-${toggling ? "spinner mobile-remote-spinning" : (running ? "stop" : "play")}`;
    toggleButton.node.classList.toggle("mobile-remote-primary", !running && !tailOnline);
    restartButton.node.disabled = !tunnel || busy || tailOnline || (!running && !tunnel.binary_present);
    restartButton.glyph.classList.toggle("mobile-remote-spinning", pendingAction?.action === "restart");
    restartButton.node.setAttribute("aria-busy", String(pendingAction?.action === "restart"));
    autoCheckbox.disabled = !tunnel || busy;
    autoCheckbox.checked = pendingAction?.action === "settings" ? pendingAction.autostart : Boolean(tunnel?.autostart);

    const urls = tailscale?.state === "unconfigured" ? [] :
      [...new Set((tailscale?.urls || []).map(mobileUrl).filter(Boolean))];
    if (urls.length !== tailUrls.length || urls.some((url, index) => url !== tailUrls[index])) {
      const selected = tailChoice.value;
      tailUrls = urls;
      tailChoice.replaceChildren(...urls.map((url) => {
        const option = element("option", "", new URL(url).host);
        option.value = url;
        return option;
      }));
      tailChoice.value = urls.includes(selected) ? selected : (urls[0] || "");
    }
    tailChoice.hidden = urls.length < 2;
    const tailHint = tailscale?.state === "connected" && !urls.length
      ? t("暂未获取到有效链接，请刷新重试")
      : (t(tailscale?.message) || (tailscale?.state === "unconfigured"
        ? t("配置 Tailscale 后显示链接")
        : (tailscale ? t("暂无可用链接") : t("等待获取连接状态"))));
    paintUrl(tail, tailChoice.value || urls[0] || "", tailHint, tailscale?.state === "connected");
    showMessage(tail.message, "");
  }

  async function requestSnapshot(body) {
    const request = { controller: new AbortController(), timer: 0 };
    let timedOut = false;
    request.timer = window.setTimeout(() => {
      timedOut = true;
      request.controller.abort();
    }, body ? 30000 : 15000);
    requests.add(request);
    try {
      const response = await fetch(body ? `${CONNECTIONS_API}/tunnel` : CONNECTIONS_API, {
        method: body ? "POST" : "GET",
        cache: "no-store",
        credentials: "same-origin",
        signal: request.controller.signal,
        ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
      });
      const data = await response.json().catch(() => null);
      if (request.controller.signal.aborted) throw new Error(t("请求已取消"));
      if (!response.ok || data?.ok === false) {
        const detail = typeof data?.error === "string" ? data.error :
          (typeof data?.message === "string" ? data.message : `HTTP ${response.status}`);
        throw new Error(detail);
      }
      return validateSnapshot(data);
    } catch (error) {
      if (timedOut) throw new Error(t("请求超时，请刷新连接状态"));
      if (error instanceof TypeError) throw new Error(t("连接服务未响应，请确认 ComfyUI 仍在运行"));
      throw error;
    } finally {
      window.clearTimeout(request.timer);
      requests.delete(request);
    }
  }

  async function refresh({ afterAction = false } = {}) {
    if (!active || !visible() || reading || (pendingAction && !afterAction)) return;
    clearPoll();
    reading = true;
    const token = epoch;
    paint();
    try {
      const data = await requestSnapshot();
      if (!current(token)) return;
      snapshot = data;
      readErrorText = "";
    } catch (error) {
      if (!current(token)) return;
      const prefix = snapshot ? t("刷新失败，当前显示上次状态。") : t("读取连接状态失败。");
      readErrorText = prefix + (error.message || t("请稍后刷新重试"));
    } finally {
      if (current(token)) {
        reading = false;
        paint();
        schedulePoll();
      }
    }
  }

  async function tunnelAction(action, autostart) {
    if (!active || !visible() || pendingAction || !snapshot?.tunnel) return;
    // An older GET must never overwrite the result of a newer tunnel action.
    cancelWork();
    pendingAction = { action, ...(action === "settings" ? { autostart } : {}) };
    actionErrorText = "";
    const token = epoch;
    paint();
    try {
      const data = await requestSnapshot(pendingAction);
      if (!current(token)) return;
      snapshot = data;
      readErrorText = "";
    } catch (error) {
      if (!current(token)) return;
      actionErrorText = t("操作未完成。") + (error.message || t("请刷新后重试"));
    } finally {
      if (current(token)) {
        paint();
        // Read back even after a failed POST: the server may have accepted it.
        await refresh({ afterAction: true });
        if (current(token)) {
          pendingAction = null;
          paint();
          schedulePoll();
        }
      }
    }
  }

  function syncVisibility() {
    const next = visible();
    if (next === active) return;
    active = next;
    if (active) void refresh();
    else {
      cancelWork();
      paint();
    }
  }

  function pause() {
    active = false;
    cancelWork();
  }

  toggleButton.node.addEventListener("click", () => void tunnelAction(tunnelRunning(snapshot?.tunnel) ? "stop" : "start"));
  restartButton.node.addEventListener("click", () => void tunnelAction("restart"));
  autoCheckbox.addEventListener("change", () => void tunnelAction("settings", autoCheckbox.checked));
  tailChoice.addEventListener("change", paint);
  // 三个视图共用标题栏：连接页 / 标签管理 / 导入工作流
  let currentView = "connect";
  function showView(next) {
    const back = next !== "connect";
    if (back) currentView = next;
    connectView.hidden = back;
    tagsButton.node.hidden = back;
    updateButton.node.hidden = back;   // 子页右上角只留「返回」
    backButton.node.hidden = !back;
    // 只改标题文字：heading 里还挂着版本号小字，直接写 textContent 会把它抹掉
    setText(headingText, next === "tags" ? t("标签管理") : next === "import" ? t("导入工作流") : t("手机远程"));
    if (back && !backButton.node.parentNode) headerActions.prepend(backButton.node);
    if (next === "tags") void tagsManager.open(); else tagsManager.close();
    if (next === "import") void importer.open(); else importer.close();
    if (!back) {
      paint();
      (currentView === "tags" ? tagsButton.node : importButton.node).focus({ preventScroll: true });
    }
  }
  tagsButton.node.addEventListener("click", () => showView("tags"));
  backButton.node.addEventListener("click", () => showView("connect"));
  document.addEventListener("visibilitychange", syncVisibility);
  window.addEventListener("pagehide", pause);
  window.addEventListener("pageshow", syncVisibility);
  const observer = new IntersectionObserver((entries) => {
    intersecting = entries.some((entry) => entry.target === root && entry.isIntersecting);
    syncVisibility();
  });
  observer.observe(root);
  paint();
  syncVisibility();

  return {
    container,
    resume: syncVisibility,
    destroy() {
      if (disposed) return;
      disposed = true;
      active = false;
      cancelWork();
      observer.disconnect();
      document.removeEventListener("visibilitychange", syncVisibility);
      window.removeEventListener("pagehide", pause);
      window.removeEventListener("pageshow", syncVisibility);
      document.removeEventListener("click", closeLanguageMenu);
      document.removeEventListener("keydown", onLanguageKeydown);
      tagsManager.destroy();
      importer.destroy();
      root.remove();
    },
  };
}

// 侧边栏标题只在注册时定一次；能拿到标签对象就顺手改掉，拿不到就算了。
function refreshSidebarTabTitle() {
  try {
    const tabs = app.extensionManager?.getSidebarTabs?.();
    const list = Array.isArray(tabs) ? tabs : (tabs?.value ?? []);
    for (const tab of Array.from(list)) {
      if (tab?.id !== TAB_ID) continue;
      const label = t("手机远程");
      if ("title" in tab) tab.title = label;
      if ("label" in tab) tab.label = label;
      if ("tooltip" in tab) tab.tooltip = label;
    }
  } catch (error) {
    console.debug("[Mobile Remote] sidebar title refresh skipped", error);
  }
}

app.registerExtension({
  name: "ComfyUI.MobileRemote.Connections",
  setup() {
    if (registered) return;
    if (!document.getElementById("mobile-remote-styles")) {
      const stylesheet = document.createElement("link");
      stylesheet.id = "mobile-remote-styles";
      stylesheet.rel = "stylesheet";
      stylesheet.href = `${new URL("./remote.css", import.meta.url).href}?v=202610125`;
      document.head.append(stylesheet);
    }
    app.extensionManager.registerSidebarTab({
      id: TAB_ID,
      title: t("手机远程"),
      label: t("手机远程"),
      tooltip: t("手机远程"),
      icon: "mobile-remote-sidebar-icon",
      type: "custom",
      render(container) {
        if (mountedPanel?.container === container) {
          mountedPanel.resume();
          return;
        }
        mountedPanel?.destroy();
        mountedPanel = mountPanel(container);
      },
      // ComfyUI ExtensionSlot calls destroy() from onBeforeUnmount.
      destroy() {
        mountedPanel?.destroy();
        mountedPanel = null;
      },
    });
    // 语言换了要把面板整块重建（状态文案是渲染时取的），侧边栏标题顺带改一下：
    // 拿不到标签对象也不重注册，免得把侧边栏条目弄丢——刷新后自然会跟上。
    remoteRuntime.unsubscribeLocale?.();
    remoteRuntime.unsubscribeLocale = globalThis.MobileI18n?.onChange?.(() => {
      refreshSidebarTabTitle();
      const container = mountedPanel?.container;
      if (!container) return;
      mountedPanel.destroy();
      mountedPanel = mountPanel(container);
    }) ?? null;
    registered = true;
  },
});
