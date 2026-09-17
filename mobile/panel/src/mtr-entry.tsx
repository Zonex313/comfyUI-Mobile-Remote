/* Reference panel UI; phone draft is authoritative. No desktop commands or queue API. */
import { createRoot } from 'react-dom/client'
import { useRef, useState } from 'react'
import { WorkflowTopBarMenu } from '@/components/WorkflowPanel/WorkflowTopBarControls/WorkflowTopBarMenu'
import { useDismissOnOutsideClick } from '@/hooks/useDismissOnOutsideClick'
import './index.css'
import './mtr-entry.css'
import { WorkflowPanel } from '@/components/WorkflowPanel'
import { PhoneWorkflowMinimap } from '@/components/WorkflowPanel/PhoneWorkflowMinimap'
import { usePhoneFocusStore } from '@/hooks/usePhoneFocus'
import { useWorkflowStore } from '@/hooks/useWorkflow'
import { useSeedStore } from '@/hooks/useSeed'
import { useBookmarksStore } from '@/hooks/useBookmarks'
import { useParameterSectionFoldsStore } from '@/hooks/useParameterSectionFolds'
import { useConnectionSectionFoldsStore } from '@/hooks/useConnectionSectionFolds'
import { ensureLocaleLoaded, useLocaleStore } from '@/i18n'
import * as api from '@/api/client'
import { getInputWidgetDefinitions, getWidgetDefinitions } from '@/utils/widgetDefinitions'
import type { Workflow, WorkflowNode } from '@/api/types'

const LOCALES: Record<string, string> = { zh: 'zh-CN', en: 'en', ja: 'ja', ko: 'ko' }
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x))
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
type Identity = { workflowId: string; snapshot: string; epoch: number }
function definitions(node: WorkflowNode) {
  const types = useWorkflowStore.getState().nodeTypes
  const defs = [...getWidgetDefinitions(types, node), ...getInputWidgetDefinitions(types, node)]
  // The reference renderer handles implicit seed mode slots separately from descriptors.
  // Expose the same unoccupied slot to the host bridge, without guessing over a real input.
  if (Array.isArray(node.widgets_values) && !defs.some(d => d.name === 'control_after_generate')) {
    const seed = defs.find(d => d.type === 'INT' && ['seed','noise_seed'].includes(d.inputName || d.name))
    const index = seed ? seed.widgetIndex + 1 : -1
    const mode = node.widgets_values[index]
    if (index >= 0 && !defs.some(d => d.widgetIndex === index) && ['fixed','randomize','increment','decrement'].includes(String(mode))) {
      defs.push({name:'control_after_generate',inputName:'control_after_generate',type:'COMBO',widgetIndex:index,value:mode,isCombo:true,connected:false,inputIndex:-1})
    }
  }
  return defs
}
// Root parameter values and modes are the only graph data the phone may change.
// Existing subgraphs remain intact; their custom serialization stays desktop-owned.
function immutableShape(workflow: Workflow | null) {
  if (!workflow) return ''
  const {nodes, ...rest} = workflow
  return JSON.stringify({...rest, nodes:nodes.map(({widgets_values, mode, title, color, bgcolor, flags, ...node}) => node)})
}
function controls() {
  return new Map((useWorkflowStore.getState().workflow?.nodes || []).map(n => [String(n.id), clone(n)]))
}

function PhonePanelControls() {
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const close = () => setOpen(false)
  const noop = () => undefined
  useDismissOnOutsideClick({open, onDismiss:close, triggerRef:buttonRef, contentRef:menuRef})
  return <div className="phone-panel-floating-controls absolute top-0 right-2 z-50"><WorkflowTopBarMenu open={open} buttonRef={buttonRef} menuRef={menuRef} onToggle={() => setOpen(!open)} onClose={close} onGoToQueue={noop} onGoToOutputs={noop} onAddNode={noop} onAddGroup={noop} onOpenWorkflowActions={noop} onReloadWorkflow={noop} /></div>
}

function mountPanel(container: HTMLElement, options: {locale?: string} = {}) {
  const root = createRoot(container)
  let identity: Identity = { workflowId: '', snapshot: '', epoch: -1 }
  let request = 0
  let applying = false
  let loaded = false
  let disposed = false
  let previous = new Map<string, WorkflowNode>()
  let lastView: unknown = null
  let lastSeeds: unknown = null
  let acceptedWorkflow: Workflow | null = null
  let lockedShape = ''
  let ready: Promise<void> = Promise.resolve()
  const notify = (action: string, extra = {}) => parent.postMessage({type: 'mtr-panel', action, ...identity, ...extra}, location.origin)
  const matches = (data: Identity) => data.workflowId === identity.workflowId && data.snapshot === identity.snapshot && data.epoch === identity.epoch
  const setLocale = async (locale: string) => {
    const next = LOCALES[locale] || 'zh-CN'
    useLocaleStore.getState().setLocale(next as never)
    await ensureLocaleLoaded(next as never)
  }
  void setLocale(options.locale || 'zh')

  const view = () => {
    const s = useWorkflowStore.getState()
    const stable = (key: string) => s.pointerByHierarchicalKey[key] || key
    const map = (v: Record<string, unknown>) => Object.fromEntries(Object.entries(v).map(([k,x]) => [stable(k),x]))
    return {
      hidden: map(s.hiddenItems), collapsed: map(s.collapsedItems), connectionButtonsVisible: s.connectionButtonsVisible,
      bookmarks: useBookmarksStore.getState().bookmarkedItems.map(stable),
      parameters: useParameterSectionFoldsStore.getState().collapsedItemKeys.map(stable),
      connections: useConnectionSectionFoldsStore.getState().collapsedItemKeys.map(stable),
      labels: Object.fromEntries((s.workflow?.nodes || []).map(n => [String(n.id), {title:n.title, color:n.color, bgcolor:n.bgcolor}])),
    }
  }
  const collect = () => {
    if (!loaded || applying || disposed) return
    const currentWorkflow = useWorkflowStore.getState().workflow
    if (currentWorkflow !== acceptedWorkflow) {
      if (immutableShape(currentWorkflow) !== lockedShape) {
        applying = true
        acceptedWorkflow = acceptedWorkflow ? clone(acceptedWorkflow) : null
        useWorkflowStore.setState({workflow:acceptedWorkflow})
        applying = false
        notify('error', {reason:'unsupported-edit'})
        return
      }
      acceptedWorkflow = currentWorkflow
    }
    const after = controls()
    const changes: any = { values: {}, node_modes: {}, widget_values: {}, seed_modes: {} }
    for (const [id, node] of after) {
      const before = previous.get(id)
      if (!before) continue
      if (node.mode !== before.mode) changes.node_modes[id] = Number(node.mode || 0)
      if (!equal(node.widgets_values, before.widgets_values)) {
        const defs = definitions(node)
        const current: any = node.widgets_values || []
        const oldValues: any = before.widgets_values || []
        const scalar = (v: unknown) => v === null || ['string','number','boolean'].includes(typeof v)
        const unmatched = Object.keys(current).some(k => !equal(current[k], oldValues[k]) && (!scalar(current[k]) || !defs.some(d => (Array.isArray(current) ? String(d.widgetIndex) : (d.inputName || d.name)) === k)))
        if (unmatched) changes.widget_values[id] = node.widgets_values
        for (const def of defs) {
          const name = def.inputName || def.name
          const index = def.widgetIndex
          const values: any = node.widgets_values || []
          const old: any = before.widgets_values || []
          const value = Array.isArray(values) ? values[index] : values[name]
          if (equal(value, Array.isArray(old) ? old[index] : old[name])) continue
          if (name === 'control_after_generate') {
            const seed = definitions(node).find(d => /(?:^|_)seed$/.test(d.inputName || d.name))
            if (seed) changes.seed_modes[id + '::' + (seed.inputName || seed.name)] = value
          } else if (value === null || ['string','number','boolean'].includes(typeof value)) {
            changes.values[id + '::' + name] = value
          }
        }
      }
    }
    const seedModes = useSeedStore.getState().seedModes
    if (!equal(lastSeeds, seedModes)) {
      for (const [id, mode] of Object.entries(seedModes)) {
        const node = after.get(id)
        const seed = node && definitions(node).find(d => /(?:^|_)seed$/.test(d.inputName || d.name))
        if (seed) changes.seed_modes[id + '::' + (seed.inputName || seed.name)] = mode
      }
      lastSeeds = clone(seedModes)
    }
    const nextView = view()
    if (!equal(nextView, lastView)) { changes.view = nextView; lastView = nextView }
    previous = after
    if (Object.values(changes).some(x => x && Object.keys(x).length)) notify('edit', { value: changes })
  }
  const applyValues = (data: any) => {
    if (!loaded) return
    applying = true
    try {
      for (const [key, raw] of Object.entries(data.values || {})) {
        const sep = key.lastIndexOf('::')
        if (sep < 1) continue
        const id = key.slice(0,sep), name = key.slice(sep+2)
        const s = useWorkflowStore.getState()
        const node = s.workflow?.nodes.find(n => String(n.id) === id)
        if (!node) continue
        const def = definitions(node).find(d => (d.inputName || d.name) === name)
        if (!def || raw === '__random__') continue
        const value = ['INT','FLOAT'].includes(def.type) && typeof raw === 'string' && raw.trim() && Number.isFinite(Number(raw)) ? Number(raw) : raw
        const current: any = node.widgets_values || []
        if (!equal(Array.isArray(current) ? current[def.widgetIndex] : current[name], value)) {
          s.updateNodeWidget(node.itemKey as never, def.widgetIndex, value, name)
        }
      }
      for (const [key, mode] of Object.entries(data.seed_modes || {})) {
        const id = key.slice(0,key.lastIndexOf('::'))
        const s = useWorkflowStore.getState(), node = s.workflow?.nodes.find(n => String(n.id) === id)
        if (!node || !['fixed','randomize','increment','decrement'].includes(String(mode))) continue
        const def = definitions(node).find(d => (d.inputName || d.name) === 'control_after_generate')
        if (def) s.updateNodeWidget(node.itemKey as never, def.widgetIndex, mode, 'control_after_generate')
        useSeedStore.setState({ seedModes: {...useSeedStore.getState().seedModes, [id]: mode as never} })
      }
      previous = controls(); lastSeeds = clone(useSeedStore.getState().seedModes)
    } finally { applying = false }
  }
  const setWorkflow = async (data: any) => {
    const generation = ++request
    identity = { workflowId: data.workflowId, snapshot: data.snapshot, epoch: data.epoch }
    loaded = false
    usePhoneFocusStore.getState().setFocusKey(null)
    container.style.visibility = 'hidden'
    try {
      const body = data.value || {}
      if (!body.workflow?.nodes) { useWorkflowStore.setState({workflow:null}); container.style.visibility='visible'; return }
      const types = useWorkflowStore.getState().nodeTypes || await api.getNodeTypes()
      await ensureLocaleLoaded(useLocaleStore.getState().locale)
      if (disposed || generation !== request) return
      applying = true
      useWorkflowStore.getState().setNodeTypes(types)
      const wf = clone(body.workflow) as Workflow
      for (const node of wf.nodes) {
        const id = String(node.id)
        if ([0,4].includes(body.node_modes?.[id])) node.mode = body.node_modes[id]
        if (body.widget_values?.[id] !== undefined) node.widgets_values = clone(body.widget_values[id])
        const label = body.view?.labels?.[id]
        if (label) Object.assign(node, label)
      }
      useWorkflowStore.getState().loadWorkflow(wf, body.name || '', {replaceActive:true})
      const s = useWorkflowStore.getState(), v = body.view || {}
      const local = (key: string) => s.itemKeyByPointer[key] || key
      const map = (value: any) => Object.fromEntries(Object.entries(value || {}).map(([k,x]) => [local(k),x]))
      useWorkflowStore.setState({hiddenItems:map(v.hidden), collapsedItems:map(v.collapsed), connectionButtonsVisible:v.connectionButtonsVisible !== false})
      useBookmarksStore.setState({bookmarkedItems:(v.bookmarks || []).map(local)})
      useParameterSectionFoldsStore.setState({collapsedItemKeys:(v.parameters || []).map(local)})
      useConnectionSectionFoldsStore.setState({collapsedItemKeys:(v.connections || []).map(local)})
      useSeedStore.setState({seedModes:{},seedLastValues:{}})
      loaded = true
      applyValues(body)
      acceptedWorkflow = useWorkflowStore.getState().workflow
      lockedShape = immutableShape(acceptedWorkflow)
      previous = controls(); lastView = view(); lastSeeds = clone(useSeedStore.getState().seedModes)
      applying = false
      container.style.visibility = 'visible'
      renderPanel()
      notify('loaded')
    } catch (error) {
      if (generation !== request || disposed) return
      loaded = false; applying = false; container.style.visibility = 'visible'
      container.style.visibility = 'hidden'
      notify('error', {message: String(error instanceof Error ? error.message : error)})
    }
  }
  const unsubscribes = [useWorkflowStore, useSeedStore, useBookmarksStore, useParameterSectionFoldsStore, useConnectionSectionFoldsStore].map(store => store.subscribe(collect))
  const renderPanel = () => root.render(<div key={`${identity.workflowId}/${identity.snapshot}/${identity.epoch}`} className="mtr-panel-shell relative flex flex-col h-full min-h-0"><PhoneWorkflowMinimap /><div className="relative flex-1 min-h-0"><WorkflowPanel visible onImageClick={() => undefined} /></div><PhonePanelControls /></div>)
  renderPanel()
  return {
    receive(data: any) {
      if (data.action === 'viewport') {
        const height = Number(data.value?.availableHeight)
        if (Number.isFinite(height) && height > 0) container.style.setProperty('--phone-minimap-height', `${height / 3}px`)
        for (const [field, variable] of [['visibleTop', '--phone-panel-visible-top'], ['visibleBottom', '--phone-panel-visible-bottom']]) {
          const value = Number(data.value?.[field])
          if (Number.isFinite(value) && value >= 0) container.style.setProperty(variable, `${value}px`)
        }
        return
      }
      if (data.action === 'clear') { request++; loaded=false; usePhoneFocusStore.getState().setFocusKey(null); identity={...identity,epoch:data.epoch}; container.style.visibility='hidden'; return }
      if (data.action === 'workflow') { ready = setWorkflow(data); return }
      if (data.action === 'locale') { void setLocale(String(data.value)); return }
      if (!matches(data)) return
      if (data.action === 'values') { void ready.then(() => {if(matches(data)) applyValues(data.value || {})}); return }
      if (data.action === 'flush') {
        const active = document.activeElement
        if (active instanceof HTMLElement) active.blur()
        void ready.then(() => {
          if (!matches(data)) return
          if (!loaded) { notify('error',{message:'Panel is not ready'}); return }
          collect(); notify('flushed',{requestId:data.requestId})
        })
      }
    },
    destroy() {disposed=true;request++;unsubscribes.forEach(fn=>fn());root.unmount()},
  }
}
declare global { var MobileRemotePanel: {mount: typeof mountPanel} | undefined }
globalThis.MobileRemotePanel = {mount: mountPanel}
