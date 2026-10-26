async page => {
  await page.waitForFunction(() => window.characterCenter?.ready === true, { timeout: 30000 });
  const result = await page.evaluate(async () => {
    const app = window.characterCenter;
    if (!app.state().component || app.state().ready) throw Error('Local components only; no cloud test authorized by this script');
    const cases = {
      native: ['native:stand01', 'native:thinking01', 'gesture:wave'],
      reading: ['activity:sit_down', 'activity:take_book_seated', 'activity:read_seated',
        'activity:page_turn_seated', 'activity:read_look_up', 'activity:close_book', 'activity:put_book_seated'],
      incompatible: ['native:stand01'],
    };
    const name = window.__bodyAuditCase ?? 'native', actions = cases[name];
    if (!actions) throw Error('Unknown component audit');
    const prior = app.state().body.rows.length;
    const start = performance.now(), snapshots = [];
    const accepted = app.componentCommand({ operation: 'replace', actions: actions.map(action => ({ action, anchor: 'immediate', delay_ms: 0 })) });
    const limit = name === 'reading' ? 90000 : 30000;
    let state;
    while (performance.now() - start < limit) {
      await new Promise(resolve => setTimeout(resolve, 100)); state = app.state();
      const body = state.body, actor = body.actorState;
      snapshots.push({ at: performance.now() - start, executor: body.executor, active: body.active?.action,
        phase: actor.phase, support: actor.support, contacts: actor.contacts, root: actor.root,
        hands: actor.hands, book: actor.props.book && { visible: actor.props.book.visible, attachment: actor.props.book.attachment,
          position: actor.props.book.position, gripError: actor.props.book.contact?.error },
        leftWrist: actor.bones.leftWrist, rightWrist: actor.bones.rightWrist, head: actor.bones.head });
      if (state.renderFault) break;
      const rows = body.rows.slice(prior);
      if (rows.length === actions.length && rows.every(row => ['completed', 'rejected', 'cancelled', 'failed'].includes(row.status))) break;
    }
    const rows = state.body.rows.slice(prior), result = { case: name, cloudCalls: 0, scope: 'manually commanded component acceptance',
      accepted, elapsedMs: performance.now() - start, renderFault: state.renderFault,
      complete: rows.length === actions.length && rows.every(row => row.status === 'completed'),
      rows: rows.map(row => ({ action: row.action, status: row.status, reason: row.reason, displayedAt: row.displayedAt, completedAt: row.completedAt })),
      state: { executor: state.body.executor, support: state.body.actorState.support, hands: state.body.actorState.hands,
        book: state.body.actorState.props.book }, snapshots };
    window.__bodyAuditResult = result;
    return result;
  });
  console.log(JSON.stringify({ ...result, snapshots: result.snapshots.length }));
}
