/* 手机远程插件「高级」页入口。
 *
 * 这里**不重写**节点控制界面：直接挂参考项目（comfyui-mobile-frontend，MIT）
 * 的真实组件 WorkflowPanel，UI 与交互与它完全一致。
 * 我们只做三件接驳的事：
 *   1. 数据：从本插件自己的接口取电脑端同步下来的原生工作流
 *      （GET /mobile/api/panel/workflow/<id>），节点定义走 ComfyUI 原生 /api/object_info。
 *   2. 语言：跟随手机页当前的界面语言（本插件自己那套 locale）。
 *   3. 回写：面板里改过的值/状态做差分，回写成本插件的「手机 → 电脑端」指令
 *      POST /mobile/api/desktop/commands，保证电脑画布真的跟着变。
 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import './index.css'
import './mtr-entry.css'
import { WorkflowPanel } from '@/components/WorkflowPanel'
import { useWorkflowStore } from '@/hooks/useWorkflow'
import { useWorkflowErrorsStore } from '@/hooks/useWorkflowErrors'
import { ensureLocaleLoaded, useLocaleStore } from '@/i18n'
import * as api from '@/api/client'
import { getInputWidgetDefinitions, getWidgetDefinitions } from '@/utils/widgetDefinitions'
import type { Workflow, WorkflowNode } from '@/api/types'

const LOG_PREFIX = '[Mobile Remote panel]'
const COMMAND_URL = '/mobile/api/desktop/commands'
const LOCALE_ALIASES: Record<string, string> = {
  zh: 'zh-CN', 'zh-cn': 'zh-CN', 'zh-tw': 'zh-TW', en: 'en', ja: 'ja', ko: 'ko',
}

type PanelOptions = { workflowId?: string; locale?: string }
type PanelHandle = {
  setWorkflow: (workflowId: string) => Promise<void>
  setLocale: (locale: string) => void
  /** 宿主（手机页）把参数值推过来：两边共用一份值。 */
  setValues: (values: Record<string, unknown>) => void
  destroy: () => void
}

/* ---------------------------------------------------------------- 回写桥 */
/* 面板改的是它自己内存里的工作流。我们做的是「快照差分 → 指令」：
 * 不侵入它的组件代码，任何一处改动（控件值、旁路、隐藏、标题、颜色）都能被
 * 统一捕获，再交给本插件既有的指令通道送到电脑端。 */
type NodeSnapshot = {
  mode: number
  title: string
  color: string
  hidden: boolean
  collapsed: boolean
  widgets: string
}

function snapshotNodes(workflow: Workflow | null): Map<string, NodeSnapshot> {
  const map = new Map<string, NodeSnapshot>()
  const nodes = (workflow?.nodes ?? []) as WorkflowNode[]
  for (const node of nodes) {
    if (!node || node.id === undefined || node.id === null) continue
    const flags = (node.flags ?? {}) as Record<string, unknown>
    map.set(String(node.id), {
      mode: Number(node.mode ?? 0),
      title: String(node.title ?? ''),
      color: String(node.color ?? ''),
      hidden: Boolean(flags.hidden),
      collapsed: Boolean(flags.collapsed),
      widgets: JSON.stringify(node.widgets_values ?? null),
    })
  }
  return map
}

function widgetsOf(node: WorkflowNode): unknown[] {
  return Array.isArray(node.widgets_values) ? node.widgets_values : []
}

/* 面板的控件清单：普通控件与下拉（COMBO）分成两个列表，这里合成"下标 → 输入名"。 */
function widgetNameByIndex(node: WorkflowNode, nodeTypes: unknown): Map<number, string> {
  const map = new Map<number, string>()
  try {
    const groups = [
      getWidgetDefinitions(nodeTypes as never, node),
      getInputWidgetDefinitions(nodeTypes as never, node),
    ]
    for (const list of groups) {
      for (const def of list) {
        if (def && typeof def.widgetIndex === 'number') {
          map.set(def.widgetIndex, String(def.inputName ?? def.name ?? ''))
        }
      }
    }
  } catch (error) {
    console.debug(LOG_PREFIX + ' 控件清单解析失败', error)
  }
  return map
}

/* 控件下标 → 提交用的输入名：优先 inputName（动态下拉的子项名），否则 name。 */
function inputNameForWidget(node: WorkflowNode, index: number, nodeTypes: unknown): string {
  return widgetNameByIndex(node, nodeTypes).get(index) ?? ''
}

/* 反向：手机给的输入名 → 面板里这一格的下标（-1 表示面板没有这一格）。 */
function widgetIndexForInput(node: WorkflowNode, input: string, nodeTypes: unknown): number {
  for (const [index, name] of widgetNameByIndex(node, nodeTypes)) {
    if (name === input) return index
  }
  return -1
}

function notifyParent(payload: Record<string, unknown>): void {
  try {
    ;(globalThis.parent ?? globalThis).postMessage({ type: 'mtr-panel', ...payload }, '*')
  } catch (error) {
    console.debug(LOG_PREFIX + ' 通知宿主失败', error)
  }
}

function postCommand(payload: Record<string, unknown>): void {
  try {
    void fetch(COMMAND_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).catch(() => undefined)
  } catch (error) {
    console.debug(LOG_PREFIX + ' 指令发送失败', error)
  }
}

function diffAndPush(
  workflowId: string,
  previous: Map<string, NodeSnapshot>,
  workflow: Workflow | null,
): Map<string, NodeSnapshot> {
  const next = snapshotNodes(workflow)
  if (!workflowId || previous.size === 0) return next
  const nodes = (workflow?.nodes ?? []) as WorkflowNode[]
  const byId = new Map(nodes.map((node) => [String(node.id), node]))
  for (const [id, after] of next) {
    const before = previous.get(id)
    const node = byId.get(id)
    if (!node) continue
    if (!before) continue
    if (before.mode !== after.mode) {
      postCommand({ workflow_id: workflowId, node_id: id, input: 'action', action: 'bypass', value: after.mode === 4 })
    }
    if (before.hidden !== after.hidden) {
      postCommand({ workflow_id: workflowId, node_id: id, input: 'action', action: 'hide', value: after.hidden })
    }
    if (before.collapsed !== after.collapsed) {
      postCommand({ workflow_id: workflowId, node_id: id, input: 'action', action: 'collapse', value: after.collapsed })
    }
    if (before.title !== after.title) {
      postCommand({ workflow_id: workflowId, node_id: id, input: 'action', action: 'rename', value: after.title })
    }
    if (before.color !== after.color) {
      postCommand({ workflow_id: workflowId, node_id: id, input: 'action', action: 'color', value: after.color })
    }
    if (before.widgets !== after.widgets) {
      const beforeValues = JSON.parse(before.widgets ?? 'null')
      const afterValues = widgetsOf(node)
      const list = Array.isArray(beforeValues) ? beforeValues : []
      const nodeTypes = useWorkflowStore.getState().nodeTypes
      for (let index = 0; index < afterValues.length; index += 1) {
        if (JSON.stringify(list[index]) === JSON.stringify(afterValues[index])) continue
        const input = inputNameForWidget(node, index, nodeTypes)
        if (!input) continue
        postCommand({ workflow_id: workflowId, node_id: id, input, value: afterValues[index] })
        // 同时告诉手机：草稿里也写一份，回生成页点「生成」用的就是它。
        notifyParent({ action: 'value', nodeId: id, input, value: afterValues[index] })
      }
    }
  }
  return next
}

/* ------------------------------------------------------------------ 挂载 */
function mountPanel(container: HTMLElement, options: PanelOptions = {}): PanelHandle {
  container.classList.add('mtr-panel-host')
  const host = document.createElement('div')
  host.className = 'mtr-panel-root'
  container.replaceChildren(host)

  const root: Root = createRoot(host)
  let workflowId = String(options.workflowId ?? '')
  let snapshot = new Map<string, NodeSnapshot>()
  let loading = false
  let unsubscribed = false
  // 手机那边推过来的值正在写入面板 store：这期间既不回写桌面指令，也不回声给手机，
  // 否则会变成自己改自己、并且把"只改手机"的值顺手推到电脑画布上。
  let applyingParent = false

  // 手机推过来的值写进面板 store：优先走它的 updateNodeWidget（保留它的归一化逻辑），
  // 拿不到 itemKey 时直接改 widgets_values 再触发一次 store 更新。
  const applyParentValues = (values: Record<string, unknown>) => {
    const current = useWorkflowStore.getState()
    const workflow = current.workflow
    if (!workflow || !values) return
    const nodes = (workflow.nodes ?? []) as WorkflowNode[]
    const nodeTypes = current.nodeTypes
    let touched = false
    applyingParent = true
    try {
      for (const [key, value] of Object.entries(values)) {
        const sep = key.indexOf('::')
        if (sep <= 0) continue
        const nodeId = key.slice(0, sep)
        const input = key.slice(sep + 2)
        const node = nodes.find((item) => String(item.id) === nodeId)
        if (!node) continue
        const index = widgetIndexForInput(node, input, nodeTypes)
        if (index < 0) continue
        if (JSON.stringify(widgetsOf(node)[index]) === JSON.stringify(value)) continue
        const itemKey = String((node as unknown as { itemKey?: string }).itemKey ?? '')
        const update = useWorkflowStore.getState().updateNodeWidget
        if (itemKey && typeof update === 'function') {
          update(itemKey as never, index, value, input)
        } else {
          const next = [...widgetsOf(node)]
          next[index] = value
          node.widgets_values = next
        }
        touched = true
      }
      if (touched && !useWorkflowStore.getState().workflow?.nodes?.length) {
        // 兜底分支改的是同一个对象，这里推一次引用让 React 重渲染。
        useWorkflowStore.setState({ workflow: { ...workflow } as never })
      }
    } catch (error) {
      console.warn(LOG_PREFIX + ' 应用宿主参数失败', error)
    } finally {
      // 等这一轮渲染落定再放开，并刷新快照：这些是"手机推来的"，不该再回写桌面。
      setTimeout(() => {
        applyingParent = false
        snapshot = snapshotNodes(useWorkflowStore.getState().workflow)
      }, 0)
    }
  }

  const applyLocale = (locale?: string) => {
    const id = LOCALE_ALIASES[String(locale ?? '').toLowerCase()]
    if (!id) return
    if (useLocaleStore.getState().locale === id) return
    useLocaleStore.getState().setLocale(id as never)
  }
  applyLocale(options.locale)

  const loadWorkflow = async (id: string) => {
    if (!id) return
    loading = true
    try {
      const [response, nodeTypes] = await Promise.all([
        fetch('/mobile/api/panel/workflow/' + encodeURIComponent(id), { cache: 'no-store' }),
        useWorkflowStore.getState().nodeTypes ? Promise.resolve(null) : api.getNodeTypes().catch(() => null),
      ])
      if (nodeTypes) useWorkflowStore.getState().setNodeTypes(nodeTypes)
      const body = await response.json().catch(() => null)
      if (!response.ok || !body || !body.workflow) {
        const message = (body && body.error) || '无法读取这个工作流的原始数据'
        useWorkflowErrorsStore.getState().setError(message)
        console.warn(LOG_PREFIX + ' ' + message)
        return
      }
      await ensureLocaleLoaded(useLocaleStore.getState().locale)
      useWorkflowStore.getState().loadWorkflow(body.workflow as Workflow, body.name || '', { replaceActive: true })
      snapshot = snapshotNodes(useWorkflowStore.getState().workflow)
      useWorkflowErrorsStore.getState().clearError?.()
      // 工作流就位了：再报一次 ready，宿主收到后会把这边的值整批推过来。
      notifyParent({ action: 'ready' })
    } catch (error) {
      console.error(LOG_PREFIX + ' 加载工作流失败', error)
    } finally {
      loading = false
    }
  }

  // 差分只在面板空闲（没在加载）时跑，避免把我们自己灌进去的数据当成用户改动。
  useWorkflowStore.subscribe((state) => {
    if (unsubscribed || loading || applyingParent || !workflowId) return
    snapshot = diffAndPush(workflowId, snapshot, state.workflow)
  })

  root.render(
    <StrictMode>
      <div className="mtr-panel-shell">
        <WorkflowPanel visible onImageClick={() => undefined} />
      </div>
    </StrictMode>,
  )

  if (workflowId) void loadWorkflow(workflowId)

  return {
    setWorkflow: (id: string) => {
      workflowId = String(id ?? '')
      return loadWorkflow(workflowId)
    },
    setLocale: (locale: string) => {
      applyLocale(locale)
      void ensureLocaleLoaded(useLocaleStore.getState().locale)
    },
    setValues: (values: Record<string, unknown>) => {
      applyParentValues(values)
    },
    destroy: () => {
      unsubscribed = true
      try { root.unmount() } catch (error) { console.debug(LOG_PREFIX + ' 卸载异常', error) }
      container.replaceChildren()
    },
  }
}

declare global {
  // eslint-disable-next-line no-var
  var MobileRemotePanel: { mount: typeof mountPanel } | undefined
}

globalThis.MobileRemotePanel = { mount: mountPanel }
console.info(LOG_PREFIX + ' ready')
