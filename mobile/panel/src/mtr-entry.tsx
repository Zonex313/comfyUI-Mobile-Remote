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
import { getWidgetDefinitions } from '@/utils/widgetDefinitions'
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

/* 控件下标 → 提交用的输入名：优先 inputName（动态下拉的子项名），否则 name。 */
function inputNameForWidget(node: WorkflowNode, index: number, nodeTypes: unknown): string {
  try {
    const defs = getWidgetDefinitions(nodeTypes as never, node)
    const hit = defs.find((def) => def.widgetIndex === index)
    if (hit) return String(hit.inputName ?? hit.name ?? '')
    const comboDefs = getWidgetDefinitions(nodeTypes as never, node)
    const comboHit = comboDefs.find((def) => def.widgetIndex === index)
    return comboHit ? String(comboHit.inputName ?? comboHit.name ?? '') : ''
  } catch (error) {
    console.debug(LOG_PREFIX + ' 控件名解析失败', error)
    return ''
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
    } catch (error) {
      console.error(LOG_PREFIX + ' 加载工作流失败', error)
    } finally {
      loading = false
    }
  }

  // 差分只在面板空闲（没在加载）时跑，避免把我们自己灌进去的数据当成用户改动。
  useWorkflowStore.subscribe((state) => {
    if (unsubscribed || loading || !workflowId) return
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
