const VERSION = /^(?:0|[1-9]\d{0,6})(?:\.(?:0|[1-9]\d{0,6})){2}$/;

function versionNumber(value) {
  return typeof value === 'string' && VERSION.test(value)
    ? value.split('.').map(Number)
    : null;
}

function versionReached(current, target) {
  const actual = versionNumber(current);
  const expected = versionNumber(target);
  if (!actual || !expected) return false;
  const difference = actual.findIndex((part, index) => part !== expected[index]);
  return difference === -1 || actual[difference] > expected[difference];
}

export function createWorkbenchUpdate({
  request,
  reload = () => location.reload(),
  canReload = () => true,
  wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
  now = Date.now,
  pollDuration = 15 * 60_000,
} = {}) {
  let slot;
  let notice;
  let checking = false;
  let updating = false;

  function draw() {
    if (!slot) return;
    slot.hidden = !notice;
    slot.replaceChildren();
    if (!notice) return;

    const doc = slot.ownerDocument;
    const banner = doc.createElement('section');
    banner.className = 'workbench-update';
    banner.setAttribute('aria-label', '工作台更新');
    const copy = doc.createElement('div');
    copy.setAttribute('role', 'status');
    const title = doc.createElement('strong');
    title.textContent = notice.title;
    const detail = doc.createElement('p');
    detail.textContent = notice.detail;
    copy.append(title, detail);
    banner.append(copy);
    if (notice.action) {
      const action = notice.action;
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = 'btn primary';
      button.textContent = notice.actionLabel;
      button.disabled = checking || updating;
      button.addEventListener('click', () => { void action(); });
      banner.append(button);
    }
    slot.append(banner);
  }

  function show(next) {
    notice = next;
    draw();
  }

  function showFailure(message, target) {
    const canRetry = Boolean(versionNumber(target));
    show({
      title: '更新未完成',
      detail: message || '请稍后再试。',
      actionLabel: canRetry ? '重试更新' : '重新检查',
      action: canRetry ? () => install(target) : check,
    });
  }

  async function watch(target) {
    const deadline = now() + pollDuration;
    while (now() < deadline) {
      await wait(2500);
      let update;
      try { update = await request('/api/updates?status=1'); }
      catch { continue; } // The workbench briefly disconnects when the installer starts the new version.
      target ||= update.latestVersion;
      if (update.status === 'failed') {
        showFailure(update.message, target);
        return;
      }
      if (versionReached(update.currentVersion, target)) {
        if (canReload()) reload();
        else show({
          title: `已更新至 v${update.currentVersion}`,
          detail: '请先保存页面上正在编辑的内容，再刷新。',
          actionLabel: '刷新页面',
          action: reload,
        });
        return;
      }
    }
    showFailure('暂时无法确认更新结果，可重新检查当前版本。');
  }

  function showProgress(target) {
    show({
      title: versionNumber(target) ? `正在更新至 v${target}` : '正在更新工作台',
      detail: '下载完成后工作台会短暂重启，请保留此页面。',
    });
  }

  async function install(target) {
    if (updating) return;
    updating = true;
    showProgress(target);
    try {
      const result = await request('/api/updates', 'POST', { version: target });
      if (result.status === 'failed') showFailure(result.message, target);
      else await watch(target);
    } catch (error) {
      showFailure(error.message);
    } finally {
      updating = false;
      draw();
    }
  }

  async function check() {
    if (checking || updating) return;
    checking = true;
    draw();
    try {
      const result = await request('/api/updates');
      const target = result.latestVersion;
      if (result.status === 'running') {
        showProgress(target);
        await watch(target);
      } else if (result.status === 'available' && versionNumber(target)) {
        show({
          title: `发现新版 v${target}`,
          detail: '更新保留本地候选人资料、简历和配置。',
          actionLabel: '立即更新',
          action: () => install(target),
        });
      } else if (result.status === 'failed') {
        showFailure(result.message, target);
      } else if (result.status === 'unavailable') {
        show({ title: '暂时无法检查更新', detail: '你可以继续使用当前版本。', actionLabel: '重新检查', action: check });
      } else show(null);
    } catch {
      // A local development server or a temporarily unavailable API should not block startup.
      show(null);
    } finally {
      checking = false;
      draw();
    }
  }

  return { check, mount(container) { slot = container; draw(); } };
}
