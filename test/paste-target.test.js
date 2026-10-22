const { test } = require('node:test');
const assert = require('node:assert/strict');
const { targetIdentity, PasteTargetSession, PasteDelivery } = require('../src/paste-target');
const app = (pid = 111) => ({ pid, bundleId: `test.app${pid}`, launchTime: 123.456, name: `App ${pid}`, windowPoint: { x: -1200, y: 10 }, icon: 'not retained' });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { resolve, promise }; };

test('paste identities are immutable snapshots and require PID, bundle and launch time', () => {
  const original = app(), target = targetIdentity(original, 999);
  original.pid = 222; original.windowPoint.x = 20;
  assert.equal(target.pid, 111); assert.equal(target.windowPoint.x, -1200); assert.ok(Object.isFrozen(target)); assert.ok(Object.isFrozen(target.windowPoint)); assert.equal(target.icon, undefined);
  for (const change of [{ pid: 999 }, { pid: 0 }, { pid: 0x80000000 }, { pid: 1.5 }, { pid: '111' }, { bundleId: '../invalid' }, { launchTime: 0 }, { launchTime: NaN }, { launchTime: '123' }]) assert.equal(targetIdentity({ ...app(), ...change }, 999), null);
  assert.equal(targetIdentity({ ...app(), name: '', windowPoint: { x: Infinity, y: 1 } }, 999).name, app().bundleId);
  assert.equal(targetIdentity({ ...app(), windowPoint: { x: Infinity, y: 1 } }, 999).windowPoint, undefined);
});
test('self foreground retains only a live panel target, while failed and unknown reads clear stale identities', async () => {
  let front = app(); const errors = [], targets = new PasteTargetSession({ ownPID: 999, read: async () => { if (front instanceof Error) throw front; return front; }, onError: error => errors.push(error) });
  await targets.refresh(); const original = targets.snapshot(); front = { pid: 999 };
  await targets.refresh(true); assert.equal(targets.snapshot(), original);
  await targets.refresh(false); assert.equal(targets.snapshot(), null);
  front = app(); await targets.refresh(); front = new Error('read failed'); await targets.refresh(true); assert.equal(targets.snapshot(), null); assert.equal(errors.length, 1);
  front = app(); await targets.refresh(); front = {}; await targets.refresh(true); assert.equal(targets.snapshot(), null);
});
test('out-of-order foreground replies never replace a newer target or clear its pending request', async () => {
  const jobs = [], targets = new PasteTargetSession({ ownPID: 999, read: () => { const job = deferred(); jobs.push(job); return job.promise; } });
  const first = targets.refresh(), second = targets.refresh(); assert.equal(targets.snapshot(), null); assert.equal(targets.pending, true);
  jobs[0].resolve(app(111)); assert.equal(await first, false); assert.equal(targets.pending, true);
  jobs[1].resolve(app(222)); assert.equal(await second, true); assert.equal(targets.snapshot().pid, 222);
  const third = targets.refresh(), fourth = targets.refresh(); jobs[3].resolve(app(444)); await fourth; jobs[2].resolve(app(333)); assert.equal(await third, false); assert.equal(targets.snapshot().pid, 444);
});
test('cancelling a pending open invalidates its response and clears the previous target', async () => {
  const job = deferred(), targets = new PasteTargetSession({ ownPID: 999, read: async () => app() }); await targets.refresh();
  targets.read = () => job.promise;
  const pending = targets.refresh(); assert.equal(targets.snapshot(), null); targets.cancel(); job.resolve(app()); assert.equal(await pending, false); assert.equal(targets.snapshot(), null); assert.equal(targets.pending, false);
});
test('overlapping self-foreground refreshes retain the currently displayed identity until commit', async () => {
  const targets = new PasteTargetSession({ ownPID: 999, read: async () => app() }); await targets.refresh(); const original = targets.snapshot(), jobs = [];
  targets.read = () => { const job = deferred(); jobs.push(job); return job.promise; };
  const first = targets.refresh(true), second = targets.refresh(true); assert.equal(targets.snapshot(), original);
  jobs[1].resolve({ pid: 999 }); await second; jobs[0].resolve({ pid: 999 }); assert.equal(await first, false); assert.equal(targets.snapshot(), original);
});
test('permission waits cannot redirect a request to a subsequently discovered application', async () => {
  let front = app(); const targets = new PasteTargetSession({ ownPID: 999, read: async () => front }); await targets.refresh(); const target = targets.snapshot();
  const job = deferred(), sent = [], delivery = new PasteDelivery({ permission: () => job.promise, activate: async value => { sent.push(value); return { ok: true }; }, dismiss() {}, recover() {} });
  const pending = delivery.deliver({ paste: true, pasteTarget: 'application', target }); front = app(222); await targets.refresh(); job.resolve({ accessibility: true });
  assert.deepEqual(await pending, { ok: true, copied: true }); assert.equal(sent[0].pid, 111); assert.equal(targets.snapshot().pid, 222);
});
test('copy-only mode never probes permissions or activates an application', async () => {
  let dismissed = 0; const delivery = new PasteDelivery({ permission: () => { throw Error('Unexpected permission read'); }, activate: () => { throw Error('Unexpected paste'); }, dismiss: () => { dismissed += 1; } });
  for (const context of [{ paste: false, pasteTarget: 'application' }, { paste: true, pasteTarget: 'clipboard' }]) assert.deepEqual(await delivery.deliver(context), { ok: true, copied: true });
  assert.equal(dismissed, 2);
});
test('unknown targets, denied permissions and permission failures report that the content was already copied', async () => {
  let activated = 0, dismissed = 0, reads = 0; const errors = [], delivery = new PasteDelivery({ permission: async () => { reads += 1; return { accessibility: false }; }, activate: () => { activated += 1; }, dismiss: () => { dismissed += 1; }, onError: error => errors.push(error) });
  const context = { paste: true, pasteTarget: 'application', target: null };
  assert.match((await delivery.deliver(context)).error, /未能确认目标/); assert.equal(reads, 0);
  context.target = targetIdentity(app(), 999); assert.match((await delivery.deliver(context)).error, /授权辅助功能/);
  delivery.permission = async () => { throw Error('helper unavailable'); }; const result = await delivery.deliver(context); assert.equal(result.ok, false); assert.equal(result.copied, true); assert.match(result.error, /无法检查/);
  assert.equal(activated, 0); assert.equal(dismissed, 0); assert.equal(errors.length, 1);
});
test('native activation failures and recovery failures preserve copied status and permit retry', async () => {
  const errors = []; let dismissed = 0, recovered = 0;
  const delivery = new PasteDelivery({ permission: async () => ({ accessibility: true }), activate: async () => { throw Error('native activation failed'); },
    dismiss: () => { dismissed += 1; }, recover: async () => { recovered += 1; throw Error('panel recovery failed'); }, onError: error => errors.push(error) });
  const context = { paste: true, pasteTarget: 'application', target: targetIdentity(app(), 999) };
  assert.deepEqual(await delivery.deliver(context), { ok: false, copied: true, error: '目标应用不可用，内容已复制到剪贴板，请手动粘贴或重试。' }); assert.equal(dismissed, 1); assert.equal(recovered, 1); assert.equal(errors.length, 2);
  delivery.activate = async () => ({ ok: false }); delivery.recover = async () => { recovered += 1; }; assert.equal((await delivery.deliver(context)).ok, false);
  delivery.activate = async () => ({ ok: true }); assert.equal((await delivery.deliver(context)).ok, true); assert.equal(recovered, 2);
});
