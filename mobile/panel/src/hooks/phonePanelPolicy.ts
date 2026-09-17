// The embedded UI exposes settings on an immutable topology, never graph editing.
export const phoneObjectActions = new Set([
  'toggle-bookmark', 'bookmark', 'toggle-bypass', 'hide-node', 'bypass-all',
  'unbypass-all', 'hide-container', 'fold-all', 'show-hidden-nodes',
])
export const phoneToolbarActions = new Set(['search', 'hide-show', 'fold-all', 'unfold-all', 'clear-bookmarks'])
export const phoneWidgetActions = new Set(['copy-value', 'reset-value', 'restore-default'])
export const phoneBlockedActions = [
  'deleteNode','collapseSetGetNodes','duplicateNode','pasteClipboard','copyContainer',
  'duplicateContainer','pasteIntoContainer','connectNodes','disconnectInput',
  'connectBoundaryInput','connectBoundaryOutput','disconnectBoundaryLink','addBoundaryInput',
  'addBoundaryOutput','promoteWidget','setPromotedWidgetForm','demoteWidget','moveBoundarySlot',
  'removeBoundarySlot','forkSubgraphType','renameSubgraphType','deleteSubgraphType',
  'replaceSubgraphInstance','addNode','addGroupNearNode','addNodeAndConnect',
  'popWidgetToPrimitive','commitRepositionLayout','copySelectedItems','createGroupFromItems',
  'deleteSelectedItems','moveItemsIntoSubgraph','removeHarvestedNodes','deleteContainer',
  'updateContainerTitle','convertImageOutputNode','renameSetGetNode','enterSubgraph',
  'setScopeInstance','navigateToSubgraphTrail','setScopeTrail','queueWorkflow',
  'queueWidgetVariations','createSubgraphFromSelection','dissolveSubgraph',
]
