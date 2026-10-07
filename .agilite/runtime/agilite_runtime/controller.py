"""Cooperative native-host Controller binding in the existing TaskStore.

No host calls, model calls or second task ledger. Snapshots are caller-supplied;
validation does not authenticate the host or prove business acceptance.
"""
import json
import uuid
from pathlib import Path
from .evidence import StateConflict, canonical, nonempty

KEY = 'native_controller_v1'


def status(store):
    project = json.loads(store.db.execute("SELECT value FROM metadata WHERE key='project'").fetchone()[0])
    row = store.db.execute('SELECT value FROM metadata WHERE key=?', (KEY,)).fetchone()
    if row:
        value = json.loads(row[0])
        if value.get('project_id') != store.project['project_id']:
            raise StateConflict('controller belongs to another project')
        if value['root'] != project['root']:
            value.update(status='needs_revalidation', previous_root=value['root'],
                         root=project['root'], title=Path(project['root']).name + ' Controller')
        return value
    # Primary registered root is stable across worktrees; never name after a worktree.
    project = json.loads(store.db.execute("SELECT value FROM metadata WHERE key='project'").fetchone()[0])
    return {'version': 1, 'project_id': project['project_id'], 'root': project['root'],
            'title': Path(project['root']).name + ' Controller', 'revision': 0,
            'status': 'pending', 'thread_id': None, 'host_project_id': None,
            'effective_model': 'unknown', 'effective_effort': 'unknown'}


def transition(store, action, expected_revision, host_project_id=None, snapshot=None, evidence=None):
    if type(expected_revision) is not int or expected_revision < 0:
        raise StateConflict('expected_revision must be a nonnegative integer')
    with store._transaction():
        current = status(store)
        if current['revision'] != expected_revision:
            raise StateConflict('controller revision changed; read status before retry')
        updated = dict(current)
        if action == 'start':
            if current['status'] != 'pending':
                raise StateConflict('controller is bound or creation unresolved; never create again')
            nonempty(host_project_id, 'host_project_id')
            nonempty(evidence, 'saved project lookup evidence')
            updated.update(status='creating', host_project_id=host_project_id,
                           operation_id=uuid.uuid4().hex, evidence=evidence)
        elif action == 'bind':
            if current['status'] not in {'pending', 'creating', 'bound', 'needs_revalidation'}:
                raise StateConflict('controller binding state unsupported')
            if not isinstance(snapshot, dict):
                raise StateConflict('fresh native thread snapshot required')
            nonempty(evidence, 'native thread readback evidence')
            for key in ('id', 'projectId', 'hostId', 'cwd', 'title'):
                nonempty(snapshot.get(key), 'snapshot ' + key)
            if (snapshot['hostId'] != 'local' or snapshot['title'] != current['title']
                    or str(Path(snapshot['cwd']).resolve()) != str(Path(current['root']).resolve())):
                raise StateConflict('controller snapshot title, host or project root mismatch')
            expected_project = current['host_project_id'] or host_project_id
            if not expected_project or snapshot['projectId'] != expected_project:
                raise StateConflict('controller saved project mismatch')
            if current['thread_id'] and snapshot['id'] != current['thread_id']:
                raise StateConflict('cannot replace an existing Controller')
            updated.update(status='bound', thread_id=snapshot['id'], host_project_id=expected_project,
                           host_id='local', evidence=evidence)
        elif action == 'retry':
            if current['status'] != 'creating':
                raise StateConflict('only unresolved creation can be recovered')
            nonempty(evidence, 'fresh bounded host search and confirmed no-effect evidence')
            # Caller must explicitly establish no host effect. Unknown cannot reset.
            if snapshot != {'host_effect': 'confirmed_not_created'}:
                raise StateConflict('unknown host effect must reconcile, never retry creation')
            updated.update(status='pending', evidence=evidence)
        elif action in {'intake', 'delivery-open', 'delivery-record', 'delivery-close', 'delivery-retire'}:
            _delivery_action(store, updated, action, snapshot, evidence)
        else:
            raise StateConflict('unknown controller action')
        updated['revision'] += 1
        store.db.execute('INSERT OR REPLACE INTO metadata VALUES (?,?)', (KEY, canonical(updated)))
        return updated

# All observations below are declarations supplied by a native-host executor.
# They do not authenticate authorization or contact a Git remote.
DELIVERY_STEPS = {
    'artifact': ('acceptance',),
    'local': ('acceptance', 'commit'),
    'push': ('acceptance', 'commit', 'push'),
    'pr': ('acceptance', 'commit', 'push', 'pr', 'checks'),
    'merge': ('acceptance', 'commit', 'push', 'pr', 'checks', 'merge'),
}


def _text_fields(value, fields):
    for field in fields:
        nonempty(value.get(field), field)


def _oid(value):
    return isinstance(value, str) and len(value) in (40, 64) and all(c in '0123456789abcdef' for c in value)


def _delivery_action(store, current, action, value, evidence):
    if current['status'] != 'bound':
        raise StateConflict('bound Controller required for project delivery')
    if not isinstance(value, dict):
        raise StateConflict('snapshot object required')
    nonempty(evidence, 'source/readback evidence')
    goal = current.get('goal')
    expected = value.get('expected_goal_revision')
    if type(expected) is not int or expected != (goal['revision'] if goal else 0):
        raise StateConflict('goal revision conflict; reconcile dot and direct input before retry')
    if action == 'intake':
        source = value.get('source')
        if not isinstance(source, dict) or source.get('entry') not in {'dot', 'user'}:
            raise StateConflict('input source must be dot or user')
        _text_fields(source, ('message_ref', 'authorization_ref'))
        if source['entry'] == 'dot':
            _text_fields(source, ('coordination_ref',))
        _text_fields(value, ('goal_id', 'goal', 'acceptance'))
        same = goal and all(goal[k] == value[k] for k in ('goal_id', 'goal', 'acceptance'))
        revision = expected if same else expected + 1
        # Preserve every input and old delivery; they can never complete a newer goal.
        current.setdefault('inputs', []).append({'goal_revision': revision, 'source': source,
                                                 'goal_id': value['goal_id'], 'goal': value['goal'],
                                                 'acceptance': value['acceptance'], 'evidence': evidence})
        current['goal'] = {k: value[k] for k in ('goal_id', 'goal', 'acceptance')}
        current['goal']['revision'] = revision
        if not same:
            for batch in current.get('deliveries', {}).values():
                if batch['status'] == 'open':
                    batch['status'] = 'superseded'
        return
    if not goal:
        raise StateConflict('register current goal before delivery')
    _text_fields(value, ('delivery_id',))
    deliveries = current.setdefault('deliveries', {})
    if action == 'delivery-open':
        if value['delivery_id'] in deliveries:
            raise StateConflict('delivery ID already exists; use a new batch')
        mode = value.get('mode')
        if mode not in DELIVERY_STEPS:
            raise StateConflict('delivery mode must be artifact/local/push/pr/merge')
        _text_fields(value, ('authorization_ref', 'mode_reason'))
        tasks = value.get('tasks')
        if not isinstance(tasks, list) or not tasks:
            raise StateConflict('delivery must reference current TaskStore tasks')
        if len({item.get('task_id') for item in tasks if isinstance(item, dict)}) != len(tasks):
            raise StateConflict('delivery task references must be unique objects')
        for item in tasks:
            _text_fields(item, ('task_id',))
            task = store.task(item['task_id'])
            if type(item.get('revision')) is not int or item['revision'] != task['revision']:
                raise StateConflict('delivery task revision changed')
        deliveries[value['delivery_id']] = {
            'goal_id': goal['goal_id'], 'goal_revision': expected, 'tasks': tasks,
            'mode': mode, 'mode_reason': value['mode_reason'],
            'authorization_ref': value['authorization_ref'], 'status': 'open',
            'steps': {}, 'evidence': evidence}
        return
    batch = deliveries.get(value['delivery_id'])
    if action == 'delivery-retire':
        if not batch or batch['status'] not in {'open', 'superseded'}:
            raise StateConflict('only open/superseded batches can retire without completion')
        _text_fields(value, ('termination_ref', 'handoff_ref'))
        observation = value.get('observation')
        _resource_observation(store, batch, observation)
        batch.update(status='retired', termination_ref=value['termination_ref'],
                     handoff_ref=value['handoff_ref'], resource_closure=observation,
                     retirement_evidence=evidence, retired_at_goal_revision=expected)
        return
    if not batch or batch['goal_revision'] != expected or batch['goal_id'] != goal['goal_id']:
        raise StateConflict('delivery belongs to another goal version')
    if batch['status'] != 'open':
        raise StateConflict('delivery is closed or superseded')
    for item in batch['tasks']:
        if store.task(item['task_id'])['revision'] != item['revision']:
            raise StateConflict('delivery task revision changed; open a new batch')
    if action == 'delivery-record':
        step = value.get('step')
        sequence = DELIVERY_STEPS[batch['mode']] + ('resources',)
        if step not in sequence or step in batch['steps']:
            raise StateConflict('unknown or already recorded step; open new batch for changed evidence')
        if any(prior not in batch['steps'] for prior in sequence[:sequence.index(step)]):
            raise StateConflict('record preceding delivery stages first')
        observation = value.get('observation')
        if not isinstance(observation, dict):
            raise StateConflict('delivery observation object required')
        if step == 'acceptance':
            _text_fields(observation, ('accepted_by', 'result_ref'))
        elif step in {'commit', 'push', 'pr', 'checks', 'merge'}:
            if not _oid(observation.get('head')):
                raise StateConflict('full subject head OID required')
            if step != 'commit' and observation['head'] != batch['steps']['commit']['observation']['head']:
                raise StateConflict('remote evidence must match delivered subject head')
            fields = {'commit': ('branch',), 'push': ('remote', 'ref'),
                      'pr': ('url', 'base'), 'checks': ('checks_ref', 'review_ref'),
                      'merge': ('url', 'target_ref')}[step]
            _text_fields(observation, fields)
            if step == 'checks' and observation.get('result') != 'passed':
                raise StateConflict('checks and review must pass for the current head')
            if step == 'merge' and (observation.get('state') != 'MERGED'
                    or observation.get('merge_method') not in {'merge', 'squash', 'rebase'}
                    or not _oid(observation.get('merge_commit')) or not _oid(observation.get('target_head'))):
                raise StateConflict('actual merged state, strategy, merge commit and target head readback required')
            if step == 'merge' and observation['url'] != batch['steps']['pr']['observation']['url']:
                raise StateConflict('merged PR must match delivered PR')
        elif step == 'resources':
            _resource_observation(store, batch, observation)
        batch['steps'][step] = {'goal_revision': expected, 'observation': observation, 'evidence': evidence}
    elif action == 'delivery-close':
        if any(step not in batch['steps'] for step in DELIVERY_STEPS[batch['mode']] + ('resources',)):
            raise StateConflict('delivery stages or resource closure missing; local done is insufficient')
        if any(store.task(item['task_id'])['status'] != 'done' for item in batch['tasks']):
            raise StateConflict('all referenced TaskStore tasks must be done; obsolete is not acceptance')
        batch.update(status='closed', closure_evidence=evidence)
    else:
        raise StateConflict('unknown delivery action')


def _resource_observation(store, batch, observation):
    if not isinstance(observation, dict):
        raise StateConflict('resource observation object required')
    if observation.get('disposition') not in {'archived', 'retained', 'none'}:
        raise StateConflict('resources require archived/retained/none disposition')
    _text_fields(observation, ('inventory_ref', 'host_readback_ref', 'reason'))
    if observation['disposition'] == 'retained':
        retention = observation.get('retention')
        if not isinstance(retention, dict):
            raise StateConflict('retained resources require explicit retention inventory')
        _text_fields(retention, ('owner_ref', 'location_ref', 'recovery_ref', 'authorization_ref'))
        refs = retention.get('resource_refs')
        if not isinstance(refs, list) or not refs:
            raise StateConflict('retained resource refs required')
        for ref in refs:
            nonempty(ref, 'retained resource ref')

    if observation.get('unresolved') != []:
        raise StateConflict('unresolved running sessions, approvals or cleanup effects')
    # Protect this delivery's TaskStore resources; unrelated work stays alone.
    for item in batch['tasks']:
        task_id = item['task_id']
        if store.db.execute('SELECT 1 FROM reservations r JOIN attempts a USING(attempt_id) WHERE a.task_id=?', (task_id,)).fetchone():
            raise StateConflict('delivery still owns TaskStore reservations')
        if store.db.execute("SELECT 1 FROM integrations WHERE task_id=? AND status NOT IN ('completed','cancelled','needs_revision')", (task_id,)).fetchone():
            raise StateConflict('delivery still has pending integration')
        if store.db.execute("SELECT 1 FROM attempts WHERE task_id=? AND status NOT IN ('integrated','abandoned')", (task_id,)).fetchone():
            raise StateConflict('delivery still has unresolved attempts')
