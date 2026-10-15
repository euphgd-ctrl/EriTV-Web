/* Installable/offline browser layer for the Linux Mastery Lab portal. */
(() => {
  'use strict';

  const nativeFetch = window.fetch.bind(window);
  const PAGE_IS_GITHUB = location.hostname.endsWith('.github.io');
  const SETTINGS_KEY = 'lml-controller-url-v1';
  const STATE_KEY = 'lml-pwa-state-v1';
  const DEFAULT_CONTROLLER = 'http://192.168.7.155:8080';
  const localState = readState();
  let pack = null;
  let controllerConnected = false;

  function readState() {
    try {
      const value = JSON.parse(localStorage.getItem(STATE_KEY) || '{}');
      return value && typeof value === 'object' ? value : {};
    } catch (_) { return {}; }
  }
  function saveState() {
    try { localStorage.setItem(STATE_KEY, JSON.stringify(localState)); } catch (_) {}
  }
  function apiBase() {
    const saved = localStorage.getItem(SETTINGS_KEY);
    return (saved || (PAGE_IS_GITHUB ? '' : location.origin)).replace(/\/+$/, '');
  }
  function baseIsBlocked(base) {
    try { return location.protocol === 'https:' && new URL(base).protocol === 'http:'; }
    catch (_) { return true; }
  }
  function status(message, state) {
    const el = document.getElementById('connection-indicator');
    if (!el) return;
    el.textContent = message;
    el.dataset.state = state || 'offline';
  }
  function jsonResponse(data, code) {
    return new Response(JSON.stringify(data), {
      status: code || 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }
  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function parseBody(init) {
    try { return JSON.parse(init && init.body ? init.body : '{}'); } catch (_) { return {}; }
  }
  function ensureObject(parent, key) {
    if (!parent[key] || typeof parent[key] !== 'object') parent[key] = {};
    return parent[key];
  }
  function taskRecord(tid) {
    return ensureObject(ensureObject(localState, 'tasks'), tid);
  }
  function practiceRecord(tid) {
    return ensureObject(ensureObject(localState, 'anatomy'), tid);
  }
  function cachedRemote(key) {
    return ensureObject(localState, 'remote')[key];
  }
  function rememberRemote(path, data) {
    const remote = ensureObject(localState, 'remote');
    if (path === '/api/tasks' || path === '/api/curriculum' || path === '/api/stats' || path === '/api/recall') {
      remote[path] = data;
    }
    const lessonMatch = path.match(/^\/api\/tasks\/(Q\d{2})\/(lesson|enrichment|walkthrough|anatomy|anatomy\/progress)$/);
    if (lessonMatch) {
      const key = lessonMatch[2].replace('/', '-');
      ensureObject(ensureObject(remote, key), lessonMatch[1])[key === 'anatomy-progress' ? 'progress' : 'content'] = data;
    }
    const progressMatch = path.match(/^\/api\/tasks\/(Q\d{2})\/anatomy\/progress$/);
    if (progressMatch) {
      const state = practiceRecord(progressMatch[1]);
      state.progress = data;
      state.records = Object.fromEntries((data.concepts || []).map(row => [row.concept_id, {
        attempts: row.attempts || 0, successes: row.successes || 0,
        independent_success: !!row.independent_success, hinted_success: !!row.hinted_success,
        hint_count: row.hint_count || 0, comparison_correct: !!row.comparison_correct,
        variation_successes: row.variation_successes || 0,
        misconception_counts: row.misconception_counts || {},
      }]));
    }
    if (path.startsWith('/api/tasks/') && path.endsWith('/complete') && typeof data.completed === 'boolean') {
      taskRecord(data.task).completed = data.completed;
    }
    if (path.includes('/anatomy/') && data.progress && data.task) {
      practiceRecord(data.task).progress = data.progress;
    }
    saveState();
  }

  const packReady = nativeFetch(new URL('./offline-pack.json', location.href), { cache: 'no-cache' })
    .then(response => {
      if (!response.ok) throw new Error('Offline lesson pack unavailable');
      return response.json();
    })
    .then(value => { pack = value; return value; })
    .catch(() => { pack = null; return null; });

  function taskList() {
    const remote = cachedRemote('/api/tasks');
    const source = remote || pack.tasks;
    return clone(source).map(task => {
      const local = taskRecord(task.id);
      return {
        ...task,
        completed: typeof local.completed === 'boolean' ? local.completed : !!task.completed,
      };
    });
  }
  function curriculumData() {
    const remote = cachedRemote('/api/curriculum');
    const result = clone(remote || pack.curriculum);
    const tasks = taskList();
    let completed = 0;
    let passed = 0;
    result.modules.forEach(module => {
      let done = 0;
      let verified = 0;
      module.tasks.forEach(item => {
        const task = tasks.find(candidate => candidate.id === item.id);
        if (!task) return;
        item.completed = !!task.completed;
        item.passed = !!task.passed;
        item.locked = false;
        done += Number(item.completed);
        verified += Number(item.passed);
        completed += Number(item.completed);
        passed += Number(item.passed);
      });
      module.done = done;
      module.verified = verified;
    });
    result.completed = completed;
    result.passed = passed;
    result.total = tasks.length;
    const unpassed = tasks.filter(task => !task.passed);
    result.next_up = unpassed[0] ? unpassed[0].id : null;
    return result;
  }
  function statsData() {
    const remote = cachedRemote('/api/stats');
    if (remote) return remote;
    const tasks = taskList();
    const dates = Object.values(ensureObject(localState, 'tasks'))
      .map(item => item.lastPractice && new Date(item.lastPractice).toDateString())
      .filter(Boolean);
    const unique = [...new Set(dates)];
    const today = new Date().toDateString();
    const streak = unique.includes(today) ? unique.length : 0;
    return {
      streak,
      passed: tasks.filter(task => task.passed).length,
      completed: tasks.filter(task => task.completed).length,
      total_attempts: tasks.reduce((sum, task) => sum + Number(task.attempts || 0), 0),
      recent: [],
      offline: true,
    };
  }
  function recallData() {
    const remote = cachedRemote('/api/recall');
    if (remote) return remote;
    const now = Date.now();
    return Object.entries(ensureObject(localState, 'tasks'))
      .filter(([, task]) => task.lastPractice && now - Date.parse(task.lastPractice) >= 86400000)
      .map(([task]) => ({ task }));
  }

  function emptyProgress(tid) {
    return {
      task: tid, concepts: [], guidance: 'guided', recommended_guidance: 'guided',
      manual_override: false, independent_challenges: 0, comparison_evidence: false,
      independent_evidence: 0, required_independent_evidence: 0,
      successful_variations: 0, capstone_evidence: false,
      capstone_independent_evidence: false, durable_mastery: false, grading_independent: false,
    };
  }
  function anatomyProgress(tid) {
    const data = pack.anatomy[tid];
    const local = practiceRecord(tid);
    const state = local.progress || cachedRemote('/api/tasks/' + tid + '/anatomy-progress') || emptyProgress(tid);
    const records = local.records || state.records || {};
    const commands = data.commands || [];
    const commandConcepts = commands.map(command => command.challenge.concept_id);
    const comparisonConcepts = (data.comparisons || []).map(item => item.concept_id);
    const conceptIds = [...commandConcepts, ...comparisonConcepts, data.capstone.concept_id,
      ...(data.misconceptions || []).map(item => `${tid}:retry:${item.id}`)];
    const concepts = conceptIds.map(id => {
      const row = records[id] || {};
      return {
        concept_id: id,
        attempts: Number(row.attempts || 0),
        successes: Number(row.successes || 0),
        independent_success: !!row.independent_success,
        hinted_success: !!row.hinted_success,
        hint_count: Number(row.hint_count || 0),
        comparison_correct: !!row.comparison_correct,
        variation_successes: Number(row.variation_successes || 0),
        misconception_counts: row.misconception_counts || {},
      };
    });
    const independent = concepts.filter(row => commandConcepts.includes(row.concept_id) && row.independent_success).length;
    const comparisonEvidence = comparisonConcepts.some(id => records[id] && records[id].comparison_correct);
    const capstone = records[data.capstone.concept_id] || {};
    const target = Math.min(2, commands.length);
    const recommended = independent >= target && (!comparisonConcepts.length || comparisonEvidence) ? 'independent' :
      (concepts.some(row => row.attempts > 0) ? 'supported' : 'guided');
    const guidance = state.manual_override ? (state.guidance || recommended) : recommended;
    return {
      ...emptyProgress(tid),
      ...state,
      task: tid,
      concepts,
      guidance,
      recommended_guidance: recommended,
      manual_override: !!state.manual_override,
      independent_challenges: independent,
      comparison_evidence: comparisonEvidence,
      independent_evidence: independent,
      required_independent_evidence: target,
      capstone_evidence: !!capstone.capstone_success,
      capstone_independent_evidence: !!capstone.capstone_independent_success,
      durable_mastery: independent >= target && comparisonEvidence && !!capstone.capstone_independent_success,
      grading_independent: independent >= target,
      records,
    };
  }
  function recordEvent(tid, conceptId, event, details) {
    const state = practiceRecord(tid);
    const records = ensureObject(state, 'records');
    const record = ensureObject(records, conceptId);
    record.attempts = Number(record.attempts || 0) + (event === 'hint' || event === 'prediction' ? 0 : 1);
    if (details && details.success) {
      record.successes = Number(record.successes || 0) + 1;
      if (details.independent) record.independent_success = true;
      if (details.hinted) record.hinted_success = true;
      if (!record.first_success) record.first_success = new Date().toISOString();
      record.last_success = new Date().toISOString();
    }
    if (details && details.misconception) {
      const counts = ensureObject(record, 'misconception_counts');
      counts[details.misconception] = Number(counts[details.misconception] || 0) + 1;
    }
    if (event === 'hint') record.hint_count = Number(record.hint_count || 0) + 1;
    if (event === 'prediction' && details) record.comparison_correct = !!details.success;
    if (event === 'variation' && details && details.success) record.variation_successes = Number(record.variation_successes || 0) + 1;
    if (event === 'capstone' && details && details.success) {
      record.capstone_success = true;
      record.capstone_independent_success = !!details.independent;
    }
    state.progress = anatomyProgress(tid);
    state.progress.records = records;
    saveState();
    return anatomyProgress(tid);
  }
  function shellWords(text) {
    const words = [];
    let word = '', quote = '', escaped = false;
    for (const char of String(text || '').trim()) {
      if (escaped) { word += char; escaped = false; continue; }
      if (char === '\\' && quote !== "'") { escaped = true; continue; }
      if (quote) { if (char === quote) quote = ''; else word += char; continue; }
      if (char === '"' || char === "'") { quote = char; continue; }
      if (/\s/.test(char)) { if (word) { words.push(word); word = ''; } continue; }
      word += char;
    }
    if (escaped) word += '\\';
    if (word) words.push(word);
    return words;
  }
  function sameCommand(left, right) {
    const a = shellWords(left), b = shellWords(right);
    return a.length === b.length && a.every((token, index) => token === b[index]);
  }
  function misconception(data, id) {
    return (data.misconceptions || []).find(item => item.id === id) || null;
  }
  function diagnose(data, command, answer, host) {
    let id = 'MISSING_OPERAND';
    const expected = shellWords(command.command);
    const actual = shellWords(answer);
    if (host !== command.host) id = 'TARGET_HOST';
    else if (!actual.length || actual[0] !== expected[0]) id = 'COMMAND_SELECTION';
    else if (expected.some(token => !actual.includes(token))) id = actual.length < expected.length ? 'MISSING_OPERAND' : 'WRONG_OPERAND';
    else id = 'WRONG_OPERAND';
    const lesson = misconception(data, id);
    return {
      outcome: 'semantically_incorrect',
      misconception: id,
      message: lesson ? `${lesson.observable} ${lesson.likely}` : 'Compare each option and operand with the task objective.',
      micro_lesson: lesson || undefined,
    };
  }
  function localCheck(tid, anatomy, body) {
    if (body.command_id === 'capstone') return checkCapstone(tid, anatomy, body);
    const command = anatomy.commands.find(item => item.id === body.command_id);
    if (!command) return { outcome: 'unsupported', message: 'Unknown command challenge.' };
    let result = sameCommand(body.answer, command.command)
      ? { outcome: 'correct', message: 'Correct. The command was checked locally and was not sent to a lab machine.' }
      : diagnose(anatomy, command, body.answer, body.host);
    const progress = recordEvent(tid, command.challenge.concept_id, 'attempt', {
      success: ['correct', 'correct_alternative'].includes(result.outcome),
      independent: body.mode === 'type' && Number(body.hints_used || 0) === 0,
      hinted: Number(body.hints_used || 0) > 0,
      misconception: result.misconception,
    });
    result.progress = progress;
    return result;
  }
  function checkCapstone(tid, anatomy, body) {
    const capstone = anatomy.capstone;
    const requiredHost = (capstone.required_hosts || [capstone.host])[0];
    const lines = String(body.answer || '').split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
    const positions = {};
    const missing = [];
    (capstone.reference_solution || []).forEach((step, index) => {
      const found = lines.findIndex(line => sameCommand(line, step.command));
      if (found < 0) missing.push(step.id);
      else positions[step.id] = found;
    });
    let result;
    if (body.host !== requiredHost) {
      const lesson = misconception(anatomy, 'TARGET_HOST');
      result = { outcome: 'semantically_incorrect', misconception: 'TARGET_HOST', message: lesson?.observable || `Select ${requiredHost}.`, micro_lesson: lesson || undefined };
    } else if (missing.length) {
      result = { outcome: 'missing_required_operation', message: 'The complete task plan is missing one or more required operations.', missing };
    } else {
      const badEdge = (capstone.dependencies || []).find(edge => positions[edge.before] > positions[edge.after]);
      if (badEdge) result = { outcome: 'dependency_error', message: `Complete ${badEdge.before} before ${badEdge.after}.` };
      else result = { outcome: 'correct', message: 'The required command sequence and dependencies are present. This check is a simulator; it does not run commands.' };
    }
    result.progress = recordEvent(tid, capstone.concept_id, 'capstone', {
      success: result.outcome === 'correct', independent: Number(body.hints_used || 0) === 0,
      misconception: result.misconception,
    });
    return result;
  }
  function offlineApi(path, method, init) {
    if (!pack) return jsonResponse({ error: 'Offline lesson pack is not available.', offline: true }, 503);
    const body = parseBody(init);
    if (path === '/api/tasks' && method === 'GET') return jsonResponse(taskList());
    if (path === '/api/curriculum' && method === 'GET') return jsonResponse(curriculumData());
    if (path === '/api/recall' && method === 'GET') return jsonResponse(recallData());
    if (path === '/api/stats' && method === 'GET') return jsonResponse(statsData());
    const match = path.match(/^\/api\/tasks\/(Q\d{2})\/(.+)$/);
    if (!match) return jsonResponse({ error: 'Unsupported offline request.', offline: true }, 503);
    const [, tid, route] = match;
    const lesson = pack.lessons[tid];
    if (!lesson) return jsonResponse({ error: 'Unknown task.' }, 404);
    if (route === 'lesson' && method === 'GET') return jsonResponse(cachedRemote('/api/tasks/' + tid + '/lesson') || lesson);
    if (route === 'enrichment' && method === 'GET') return jsonResponse(pack.enrichments[tid]);
    if (route === 'walkthrough' && method === 'GET') return jsonResponse(pack.walkthroughs[tid]);
    if (route === 'anatomy' && method === 'GET') return jsonResponse(pack.anatomy[tid]);
    if (route === 'anatomy/progress' && method === 'GET') return jsonResponse(anatomyProgress(tid));
    if (route === 'anatomy/progress' && method === 'POST') {
      const state = practiceRecord(tid);
      if (body.guidance === null || body.guidance === 'auto') {
        state.progress = { ...anatomyProgress(tid), manual_override: false };
      } else if (['guided', 'supported', 'independent'].includes(body.guidance)) {
        state.progress = { ...anatomyProgress(tid), guidance: body.guidance, manual_override: true };
      }
      saveState();
      return jsonResponse(anatomyProgress(tid));
    }
    if (route.startsWith('anatomy/') && method === 'POST') {
      const data = pack.anatomy[tid];
      if (route === 'anatomy/check') return jsonResponse(localCheck(tid, data, body));
      if (route === 'anatomy/predict') {
        const item = data.comparisons.find(entry => entry.id === body.comparison_id);
        if (!item) return jsonResponse({ outcome: 'unsupported', message: 'Unknown comparison.' }, 404);
        const success = Number(body.selected_index) === item.correct_index;
        const progress = recordEvent(tid, item.concept_id, 'prediction', { success });
        return jsonResponse({ outcome: success ? 'correct' : 'semantically_incorrect', correct_index: item.correct_index, explanation: item.explanation, verification: item.verify, progress });
      }
      if (route === 'anatomy/hint') {
        const item = body.command_id === 'capstone' ? data.capstone : data.commands.find(entry => entry.id === body.command_id)?.challenge;
        if (!item) return jsonResponse({ error: 'Unknown challenge.' }, 404);
        const id = body.command_id === 'capstone' ? data.capstone.concept_id : item.concept_id;
        const hintState = ensureObject(ensureObject(practiceRecord(tid), 'hintCursor'), id);
        if (body.reset) { hintState.cursor = 0; return jsonResponse({ reset: true, progress: anatomyProgress(tid) }); }
        const hints = item.hints || [];
        const index = Math.min(Number(hintState.cursor || 0), Math.max(hints.length - 1, 0));
        hintState.cursor = Number(hintState.cursor || 0) + 1;
        const progress = recordEvent(tid, id, 'hint', {});
        saveState();
        return jsonResponse({ hint: hints[index] || 'Break the objective into host, operation, target, and verification.', index, complete: index + 1 >= hints.length, progress });
      }
      if (route === 'anatomy/retry') {
        const item = misconception(data, body.misconception_id);
        if (!item || !item.retry_command) return jsonResponse({ outcome: 'unsupported', message: 'No safe local checker is available for this retry.' }, 400);
        const expectedHost = lesson.commands[0]?.host;
        const success = sameCommand(body.answer, item.retry_command) && (body.misconception_id !== 'TARGET_HOST' || body.host === expectedHost);
        const result = success ? { outcome: 'correct', message: 'Correct. The retry was evaluated locally.' } : {
          outcome: 'semantically_incorrect', misconception: item.id, message: item.observable || 'Check the host and command operands.', micro_lesson: item,
        };
        result.progress = recordEvent(tid, `${tid}:retry:${item.id}`, 'variation', { success, misconception: success ? null : item.id });
        return jsonResponse(result);
      }
    }
    if (route === 'complete' && method === 'POST') {
      const state = taskRecord(tid);
      state.completed = !!body.completed;
      state.lastPractice = new Date().toISOString();
      saveState();
      queueWrite(path, init);
      return jsonResponse({ task: tid, completed: state.completed, offline: true });
    }
    if (route === 'hint' && method === 'GET') {
      const task = taskRecord(tid);
      const cursor = Number(task.hintCursor || 0);
      task.hintCursor = cursor + 1;
      const hints = [
        `Confirm which host owns the files or service in the ${tid} objective.`,
        'Separate prerequisites, state changes, persistence, and verification into distinct steps.',
        'Use the Teach Me tab to study one guided step, then try the next command from memory.',
      ];
      saveState();
      return jsonResponse({ hints: [hints[Math.min(cursor, hints.length - 1)]], attempts: Number(task.attempts || 0) });
    }
    if (['fixture', 'reset', 'grade'].includes(route)) {
      return jsonResponse({ offline: true, error: 'Connect to the lab controller to set up, reset, or grade a live VM.' });
    }
    if (route.startsWith('anatomy/')) return jsonResponse({ error: 'Unsupported offline anatomy request.', offline: true }, 503);
    return jsonResponse({ error: 'Unsupported offline request.', offline: true }, 503);
  }

  function queueWrite(path, init) {
    if (!apiBase() || baseIsBlocked(apiBase())) return;
    const queue = ensureObject(localState, 'pendingWrites');
    const items = Array.isArray(queue.items) ? queue.items : (queue.items = []);
    if (items.length < 100) items.push({ path, method: init.method, headers: init.headers, body: init.body });
    saveState();
  }
  async function flushWrites() {
    const base = apiBase();
    const queue = localState.pendingWrites && localState.pendingWrites.items;
    if (!base || baseIsBlocked(base) || !Array.isArray(queue) || !queue.length) return;
    while (queue.length) {
      const item = queue[0];
      try {
        const response = await nativeFetch(new URL(item.path, base), {
          method: item.method || 'POST', headers: item.headers || {}, body: item.body,
          mode: 'cors', credentials: 'omit', cache: 'no-store',
        });
        if (!response.ok) break;
        queue.shift(); saveState();
      } catch (_) { break; }
    }
  }
  window.addEventListener('online', flushWrites);

  window.fetch = async function (input, init) {
    let rawUrl = typeof input === 'string' ? input : (input && input.url) || '';
    let parsed;
    try { parsed = new URL(rawUrl, location.href); } catch (_) { return nativeFetch(input, init); }
    if (!parsed.pathname.startsWith('/api/')) return nativeFetch(input, init);
    await packReady;
    const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
    const base = apiBase();
    if (base && !baseIsBlocked(base)) {
      try {
        const target = new URL(parsed.pathname + parsed.search, base);
        const options = { ...(init || {}), mode: 'cors', credentials: 'omit', cache: 'no-store' };
        const response = await nativeFetch(target.href, options);
        if (response.ok) {
          controllerConnected = true;
          status('Controller connected · live lab actions available', 'online');
          try { rememberRemote(parsed.pathname, await response.clone().json()); } catch (_) {}
          return response;
        }
        if (response.status !== 404 && !parsed.pathname.includes('/anatomy/')) return response;
      } catch (_) {}
    } else if (base && baseIsBlocked(base)) {
      status('Offline lessons ready · HTTP controller needs its portal opened directly or HTTPS', 'offline');
    }
    controllerConnected = false;
    if (pack) status('Offline lesson pack ready · connect the controller for VM actions', 'offline');
    const fallback = offlineApi(parsed.pathname, method, init || {});
    if (method === 'POST' && parsed.pathname.includes('/anatomy/') && fallback.ok) queueWrite(parsed.pathname, init || {});
    return fallback;
  };

  function saveController(value) {
    const trimmed = String(value || '').trim().replace(/\/+$/, '');
    if (!trimmed) localStorage.removeItem(SETTINGS_KEY);
    else {
      const url = new URL(trimmed.includes('://') ? trimmed : `http://${trimmed}`);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Use an http or https controller address.');
      localStorage.setItem(SETTINGS_KEY, url.origin);
    }
  }
  async function testController(value) {
    let base = String(value || '').trim().replace(/\/+$/, '') || apiBase();
    if (!base) throw new Error('Enter the controller URL first.');
    if (baseIsBlocked(base)) throw new Error('This page is HTTPS and browsers block HTTP API calls. Open the controller portal directly or use an HTTPS address reachable over VPN.');
    const response = await nativeFetch(new URL('/api/tasks', base), { mode: 'cors', credentials: 'omit', cache: 'no-store' });
    if (!response.ok) throw new Error(`Controller responded with HTTP ${response.status}.`);
    controllerConnected = true;
    status('Controller connected · live lab actions available', 'online');
    await flushWrites();
    return response.json();
  }
  function openLiveTask(tid, route) {
    const base = apiBase() || (PAGE_IS_GITHUB ? DEFAULT_CONTROLLER : location.origin);
    const url = new URL(route || '/', base);
    if (tid && /^Q\d{2}$/.test(tid)) url.searchParams.set('task', tid);
    window.open(url.href, '_blank', 'noopener');
  }
  function openTerminal(host, task) {
    const base = apiBase() || (PAGE_IS_GITHUB ? DEFAULT_CONTROLLER : location.origin);
    const url = new URL('/terminal', base);
    if (['workstation', 'servera', 'serverb'].includes(host)) url.searchParams.set('host', host);
    if (task && /^Q\d{2}$/.test(task)) url.searchParams.set('task', task);
    window.open(url.href, '_blank', 'noopener');
  }

  function setupSettings() {
    const button = document.getElementById('settings-button');
    const dialog = document.getElementById('pwa-settings');
    const form = document.getElementById('settings-form');
    if (!button || !dialog || !form) return;
    const input = document.getElementById('controller-url');
    const saved = localStorage.getItem(SETTINGS_KEY);
    if (input) input.value = saved || (PAGE_IS_GITHUB ? DEFAULT_CONTROLLER : location.origin);
    button.addEventListener('click', () => dialog.showModal());
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const message = document.getElementById('settings-message');
      try {
        saveController(input.value);
        if (!input.value.trim()) {
          controllerConnected = false;
          status('Offline lesson pack ready · no controller selected', 'offline');
          message.textContent = 'Saved. The lessons remain available offline.';
          return;
        }
        message.textContent = 'Testing controller…';
        await testController(input.value);
        message.textContent = 'Connected. Grading, setup, reset, and terminal are ready.';
      } catch (error) {
        controllerConnected = false;
        status('Offline lessons ready · controller unavailable', 'offline');
        message.textContent = error.message || 'Could not connect to the controller.';
      }
    });
    const close = document.getElementById('settings-close');
    if (close) close.addEventListener('click', () => dialog.close());
    const openPortal = document.getElementById('open-controller');
    if (openPortal) openPortal.addEventListener('click', () => openLiveTask(null, '/'));
    const help = document.getElementById('install-help');
    if (help) help.textContent = /iPhone|iPad|iPod/i.test(navigator.userAgent)
      ? 'On iPhone/iPad: open this page in Safari, tap Share, then Add to Home Screen.'
      : 'On Android: open the browser menu and choose Install app or Add to Home screen.';
  }

  function installControls() {
    const button = document.getElementById('install-button');
    if (!button) return;
    let installPrompt = null;
    window.addEventListener('beforeinstallprompt', event => {
      event.preventDefault(); installPrompt = event; button.hidden = false;
    });
    button.addEventListener('click', async () => {
      if (!installPrompt) { document.getElementById('settings-button')?.click(); return; }
      installPrompt.prompt();
      await installPrompt.userChoice;
      installPrompt = null; button.hidden = true;
    });
    window.addEventListener('appinstalled', () => { button.hidden = true; });
  }

  function registerWorker() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('./sw.js', { scope: './' }).then(registration => registration.update()).catch(() => {});
    let refreshed = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (refreshed) return;
      refreshed = true;
      location.reload();
    });
  }

  setupSettings();
  installControls();
  registerWorker();
  packReady.then(value => {
    if (value && !controllerConnected) status('Offline lesson pack ready · connect the controller for VM actions', 'offline');
    if (!value) status('Offline lesson pack could not load · refresh while online', 'offline');
  });

  window.LMLPwa = Object.freeze({
    ready: packReady,
    apiBase,
    isControllerConnected: () => controllerConnected,
    openTerminal,
    openLiveTask,
    testController,
  });
})();
