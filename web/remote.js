import { app } from "../../scripts/app.js";
import { createPresetManager } from "./preset-manager.js?v=202609202";

const TAB_ID = "mobile-remote";
const POLL_MS = 3000;
const CONNECTIONS_API = "/mobile/api/connections";
const TUNNEL_STATES = {
  stopped: ["未连接", "muted"],
  installing: ["安装中", "pending"],
  starting: ["连接中", "pending"],
  connected: ["已连接", "success"],
  reconnecting: ["重连中", "pending"],
  error: ["连接异常", "error"],
};
const TAILSCALE_STATES = {
  connected: ["已连接", "success"],
  unconfigured: ["未配置", "muted"],
  offline: ["未在线", "muted"],
};

let mountedPanel = null;
let registered = false;

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
    !Object.hasOwn(TUNNEL_STATES, tunnel?.state) ||
    typeof tunnel.url !== "string" ||
    typeof tunnel.message !== "string" ||
    typeof tunnel.autostart !== "boolean" ||
    typeof tunnel.enabled !== "boolean" ||
    typeof tunnel.binary_present !== "boolean" ||
    !Object.hasOwn(TAILSCALE_STATES, tailscale?.state) ||
    !Array.isArray(tailscale.urls) ||
    !tailscale.urls.every((url) => typeof url === "string") ||
    typeof tailscale.message !== "string"
  ) throw new Error("返回的连接状态不完整，请刷新重试");
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
  field.setAttribute("aria-label", "复制链接");
  document.body.append(field);
  try {
    field.focus({ preventScroll: true });
    field.select();
    field.setSelectionRange(0, value.length);
    if (!document.execCommand("copy")) throw new Error("复制未成功，请选中地址手动复制");
  } finally {
    field.remove();
    if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
  }
}

const TAG_NODE_TYPE = "MobileTagCLIPTextEncode";

// 把自制节点放到画布正中央；返回空串表示成功，否则是错误说明。
function addTagNodeToCanvas() {
  const graph = app?.graph;
  const factory = globalThis.LiteGraph;
  if (!graph || typeof factory?.createNode !== "function") return "画布还没准备好";
  const node = factory.createNode(TAG_NODE_TYPE);
  if (!node) return "找不到节点类型，确认插件已加载后刷新页面";
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
  root.setAttribute("aria-label", "手机远程连接");
  const header = element("header", "mobile-remote-header");
  const heading = element("h2", "mobile-remote-heading", "手机远程");
  const refreshButton = button("刷新连接状态", "refresh");
  const tagsButton = button("标签管理", "list", "标签管理");
  tagsButton.node.classList.add("mobile-remote-tags-entry");
  const backButton = button("返回连接", "arrow-left", "返回");
  backButton.node.classList.add("mobile-remote-tags-back");
  backButton.node.hidden = true;
  const headerActions = element("div", "mobile-remote-header-actions");
  headerActions.append(tagsButton.node, refreshButton.node);
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
  let manualLoading = false;
  let pendingAction = null;
  let readErrorText = "";
  let actionErrorText = "";
  const requests = new Set();

  function makeCard(name, kind, subtitle) {
    const card = element("section", `mobile-remote-card mobile-remote-${kind}`);
    const cardHeader = element("div", "mobile-remote-card-header");
    const titleGroup = element("div", "mobile-remote-card-title-group");
    const title = element("h3", "mobile-remote-card-title", name);
    title.id = `mobile-remote-${kind}-title`;
    card.setAttribute("aria-labelledby", title.id);
    titleGroup.append(title, element("p", "mobile-remote-subtitle", subtitle));
    const status = element("span", "mobile-remote-status", "读取中");
    status.dataset.tone = "muted";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    status.setAttribute("aria-atomic", "true");
    cardHeader.append(titleGroup, status);
    const address = element("div", "mobile-remote-address");
    const field = element("textarea", "mobile-remote-url");
    field.id = `mobile-remote-${kind}-url`;
    field.setAttribute("aria-label", `${name} 访问地址`);
    field.readOnly = true;
    field.rows = 1;
    field.spellcheck = false;
    field.autocomplete = "off";
    field.dir = "ltr";
    field.placeholder = "正在获取连接状态";
    field.classList.add("is-masked");
    const urlActions = element("div", "mobile-remote-url-actions");
    const copy = button(`复制 ${name} 链接`, "copy");
    const reveal = button(`显示 ${name} 链接`, "eye");
    const open = button(`打开 ${name} 链接`, "external-link");
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
      reveal.node.title = "按住显示明文";
      reveal.node.setAttribute("aria-label", "按住显示明文");
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
      copy.glyph.hidden = false;
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
          copy.node.classList.add("is-copied");
          setText(copy.caption, "已复制");
          copy.glyph.hidden = true;
          window.clearTimeout(result.copyTimer);
          result.copyTimer = window.setTimeout(() => {
            if (!disposed) restoreCopyButton();
          }, 3000);
        }
      } catch {
        if (!disposed && field.value === value) {
          restoreCopyButton();
          feedback.dataset.tone = "error";
          setText(feedback, "复制未成功，请选中地址手动复制");
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
    "公网链接暴露是非常危险的事，所以即便是临时公网，也请务必保护好自己的链接避免外泄！",
  ));
  connectView.append(warning);

  const workflowNote = element("section", "mobile-remote-card");
  workflowNote.append(element("p", "mobile-remote-note", "工作流处于打开状态才可以被手机读取"));
  connectView.append(workflowNote);

  const nodeCard = element("section", "mobile-remote-card");
  const nodeButton = button("把随机标签节点加入画布", "plus", "加入随机标签节点");
  nodeButton.node.classList.add("mobile-remote-primary");
  nodeButton.node.addEventListener("click", () => {
    const error = addTagNodeToCanvas();
    const original = "加入随机标签节点";
    nodeButton.caption.textContent = error ? "加入失败" : "已加入画布";
    window.setTimeout(() => { nodeButton.caption.textContent = original; }, 2000);
  });
  nodeCard.append(nodeButton.node);
  // 上移一行：排在公网链接警告下面、「工作流处于打开状态」那句提示上面
  // （workflowNote 是上面那句提示的元素，直接用，别再声明同名变量）
  if (workflowNote?.parentElement) workflowNote.before(nodeCard);
  else connectView.append(nodeCard);

  const cloud = makeCard("Cloudflare", "cloud", "临时公网");
  const tunnelActions = element("div", "mobile-remote-tunnel-actions");
  const toggleButton = button("连接 Cloudflare", "play", "连接");
  toggleButton.node.classList.add("mobile-remote-primary");
  const restartButton = button("重新连接 Cloudflare", "refresh", "重新连接");
  tunnelActions.append(toggleButton.node, restartButton.node);
  const autoLabel = element("label", "mobile-remote-autostart");
  const autoCheckbox = element("input", "mobile-remote-checkbox");
  autoCheckbox.type = "checkbox";
  autoLabel.append(autoCheckbox, element("span", "", "Tailscale 不在线时自动连接"));
  const actionError = element("p", "mobile-remote-error");
  actionError.setAttribute("role", "alert");
  actionError.hidden = true;
  cloud.card.append(
    tunnelActions,
    autoLabel,
    actionError,
    element("p", "mobile-remote-note", "手机浏览器输入上方网址即可，重启后网址会变化"),
  );

  const tail = makeCard("Tailscale", "tailscale", "私人网络");
  const tailChoice = element("select", "mobile-remote-select");
  tailChoice.setAttribute("aria-label", "选择 Tailscale 地址");
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
  const guideTitle = element("h3", "mobile-remote-card-title", "怎么选");
  guideTitle.id = "mobile-remote-guide-title";
  const compare = element("div", "mobile-remote-compare");
  const cloudCol = element("div", "mobile-remote-compare-col");
  cloudCol.append(
    element("strong", "", "Cloudflare"),
    element("p", "mobile-remote-note", "傻瓜式，适合完全不愿折腾的小白，代价是慢且稳定性较差。点「连接」就能出链接，手机不用装额外软件。"),
    element("p", "mobile-remote-note", "适合偶尔外出看一眼。带宽有限，大图和刷新可能慢；重启后地址会变，要重新复制。"),
  );
  const tailCol = element("div", "mobile-remote-compare-col");
  tailCol.append(
    element("strong", "", "Tailscale"),
    element("p", "mobile-remote-note", "稍微复杂一点：电脑和手机都要下载 Tailscale 并登录同一个账号。连上后更快、更稳，地址也更固定。"),
    element("p", "mobile-remote-note", "适合经常用、要看大图或长时间开着。第一次配好之后，之后几乎不用管。"),
  );
  compare.append(cloudCol, tailCol);
  const tips = element("p", "mobile-remote-note", "两者均为免费加密通道，Cloudflare 谁拿到链接都能打开；Tailscale 只有你账号下的设备能进。");
  function platformGuide(title, items) {
    const block = element("div", "mobile-remote-guide-block");
    block.append(element("strong", "", title), list(items, true));
    return block;
  }
  const installBody = element("div", "mobile-remote-install");
  installBody.hidden = true;
  installBody.append(
    platformGuide("电脑", [
      ["打开 ", link("https://tailscale.com/download/windows", "电脑下载页"), "，安装 Windows 版。"],
      "用 Google、Microsoft 或邮箱登录，记住这个账号。",
      "右下角图标显示已连接。开机后保持在线。",
      "回到这个页面，Tailscale 卡片会出现地址。",
    ]),
    platformGuide("安卓", [
      ["打开 ", link("https://tailscale.com/download/android", "安卓下载页"), "，用 Google Play 或官方 APK 安装。国内应用商店搜 Tailscale 也可以。"],
      "用和电脑相同的账号登录。",
      "打开连接开关，系统要求允许 VPN 时选允许。",
      "复制这边的 Tailscale 地址，用手机浏览器打开。",
    ]),
    platformGuide("苹果", [
      ["App Store 搜 Tailscale，或打开 ", link("https://apps.apple.com/app/tailscale/id1470499037", "App Store 下载页"), "。"],
      "用和电脑相同的账号登录。",
      "打开连接开关，允许添加 VPN。",
      "复制这边的 Tailscale 地址，用 Safari 打开。",
    ]),
  );
  const installButton = button("怎么装 Tailscale", "info-circle", "怎么装 Tailscale");
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
    manualLoading = false;
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
    refreshButton.node.disabled = reading || busy;
    refreshButton.glyph.classList.toggle("mobile-remote-spinning", manualLoading || (!snapshot && reading));
    refreshButton.node.setAttribute("aria-busy", String(reading));
    showMessage(readError, readErrorText);
    showMessage(actionError, actionErrorText);
    paintStatus(cloud, tunnel ? TUNNEL_STATES[tunnel.state] : [readErrorText ? "未获取" : "读取中", "muted"]);
    paintStatus(tail, tailscale ? TAILSCALE_STATES[tailscale.state] : [readErrorText ? "未获取" : "读取中", "muted"]);

    const cloudUrl = tunnel?.state === "stopped" ? "" : mobileUrl(tunnel?.url);
    const cloudHint = tunnel?.state === "connected" && !cloudUrl
      ? "暂未获取到有效链接，请刷新重试"
      : (tunnel?.message || (tunnel ? "连接后显示链接" : "等待获取连接状态"));
    paintUrl(cloud, cloudUrl, cloudHint, tunnel?.state === "connected");
    showMessage(cloud.message, "");

    const running = tunnelRunning(tunnel);
    const tailOnline = tailscale?.state === "connected";
    const toggling = pendingAction && pendingAction.action !== "settings" && pendingAction.action !== "restart";
    toggleButton.node.disabled = !tunnel || busy || (tailOnline && !running);
    const toggleLabel = toggling ? (pendingAction.action === "stop" ? "停止中" : "连接中") : (running ? "停止" : "连接");
    setText(toggleButton.caption, toggleLabel);
    toggleButton.node.title = tailOnline && !running ? "Tailscale 在线时无需连接 Cloudflare" : `${toggleLabel} Cloudflare`;
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
      ? "暂未获取到有效链接，请刷新重试"
      : (tailscale?.message || (tailscale?.state === "unconfigured"
        ? "配置 Tailscale 后显示链接"
        : (tailscale ? "暂无可用链接" : "等待获取连接状态")));
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
      if (request.controller.signal.aborted) throw new Error("请求已取消");
      if (!response.ok || data?.ok === false) {
        const detail = typeof data?.error === "string" ? data.error :
          (typeof data?.message === "string" ? data.message : `HTTP ${response.status}`);
        throw new Error(detail);
      }
      return validateSnapshot(data);
    } catch (error) {
      if (timedOut) throw new Error("请求超时，请刷新连接状态");
      if (error instanceof TypeError) throw new Error("连接服务未响应，请确认 ComfyUI 仍在运行");
      throw error;
    } finally {
      window.clearTimeout(request.timer);
      requests.delete(request);
    }
  }

  async function refresh({ manual = false, afterAction = false } = {}) {
    if (!active || !visible() || reading || (pendingAction && !afterAction)) return;
    clearPoll();
    reading = true;
    manualLoading = manual;
    if (manual) actionErrorText = "";
    const token = epoch;
    paint();
    try {
      const data = await requestSnapshot();
      if (!current(token)) return;
      snapshot = data;
      readErrorText = "";
    } catch (error) {
      if (!current(token)) return;
      const prefix = snapshot ? "刷新失败，当前显示上次状态。" : "读取连接状态失败。";
      readErrorText = `${prefix}${error.message || "请稍后刷新重试"}`;
    } finally {
      if (current(token)) {
        reading = false;
        manualLoading = false;
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
      actionErrorText = `操作未完成。${error.message || "请刷新后重试"}`;
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

  refreshButton.node.addEventListener("click", () => void refresh({ manual: true }));
  toggleButton.node.addEventListener("click", () => void tunnelAction(tunnelRunning(snapshot?.tunnel) ? "stop" : "start"));
  restartButton.node.addEventListener("click", () => void tunnelAction("restart"));
  autoCheckbox.addEventListener("change", () => void tunnelAction("settings", autoCheckbox.checked));
  tailChoice.addEventListener("change", paint);
  function showTags(open) {
    connectView.hidden = open;
    tagsButton.node.hidden = open;
    refreshButton.node.hidden = open;
    backButton.node.hidden = !open;
    heading.textContent = open ? "标签管理" : "手机远程";
    if (open) {
      if (!backButton.node.parentNode) headerActions.prepend(backButton.node);
      void tagsManager.open();
    } else {
      tagsManager.close();
      paint();
      tagsButton.node.focus({ preventScroll: true });
    }
  }
  tagsButton.node.addEventListener("click", () => showTags(true));
  backButton.node.addEventListener("click", () => showTags(false));
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
      tagsManager.destroy();
      root.remove();
    },
  };
}

app.registerExtension({
  name: "ComfyUI.MobileRemote.Connections",
  setup() {
    if (registered) return;
    if (!document.getElementById("mobile-remote-styles")) {
      const stylesheet = document.createElement("link");
      stylesheet.id = "mobile-remote-styles";
      stylesheet.rel = "stylesheet";
      stylesheet.href = `${new URL("./remote.css", import.meta.url).href}?v=202609220`;
      document.head.append(stylesheet);
    }
    app.extensionManager.registerSidebarTab({
      id: TAB_ID,
      title: "手机远程",
      label: "手机远程",
      tooltip: "手机远程",
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
    registered = true;
  },
});
