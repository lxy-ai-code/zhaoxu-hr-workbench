const terminalRunKey=runtime=>{
  const run=runtime?.lastRun;
  return run?.id&&run.finishedAt&&run.status!=='running'?`${run.id}:${run.finishedAt}`:'';
};

/** A status poll is not a workspace refresh. Keep completion/recovery pending
 * until a safe moment, then consume it exactly once without invoking a job. */
export function inboxRefreshDecision({loadedRuntime,currentRuntime,pending=false,recovered=false,hidden=false,hasOverlay=false,inputFocused=false,hasUnsavedForm=false,busy=false,view='conversations'}={}) {
  const current=terminalRunKey(currentRuntime),loaded=terminalRunKey(loadedRuntime);
  const needed=Boolean(pending||recovered||(current&&current!==loaded));
  const safe=['conversations','settings','automations'].includes(view)&&!hidden&&!hasOverlay&&!inputFocused&&!hasUnsavedForm&&!busy;
  return {pending:needed,refresh:needed&&safe};
}

const count=value=>Number.isFinite(value)&&value>=0?value:0;
export function inboxDisplayStats(runtime={},workspace={}) {
  const queue=Array.isArray(workspace.inboxQueue)?workspace.inboxQueue:[];
  const active=queue.filter(item=>item.baselineFingerprint!==item.fingerprint);
  const last=runtime.lastRun||{};
  return {
    lastRunAt:last.finishedAt||runtime.settings?.lastRunAt||null,
    nextRunAt:runtime.nextRunAt||runtime.settings?.nextRunAt||null,
    newConversations:count(last.sync?.imported),
    collected:count(last.collected),
    failed:count(last.failed),
    pendingCollection:Number.isFinite(runtime.queue?.pendingCollection)?count(runtime.queue.pendingCollection):active.filter(item=>item.collectedFingerprint!==item.fingerprint).length,
    pendingAnalysis:Number.isFinite(runtime.queue?.pendingAnalysis)?count(runtime.queue.pendingAnalysis):active.filter(item=>item.collectedFingerprint===item.fingerprint&&(item.analyzedFingerprint!==item.fingerprint||Boolean(item.analysisFingerprint&&item.analyzedSourceFingerprint!==item.analysisFingerprint))).length,
  };
}

export function isCurrentWorkspaceSnapshot(snapshot,loaded) {
  return !Number.isFinite(snapshot?.revision)||!Number.isFinite(loaded?.revision)||snapshot.revision>=loaded.revision;
}
