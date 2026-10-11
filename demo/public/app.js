/**
 * demo/public/app.js — tiny frontend for the task list (no framework).
 *
 * Progressive enhancement: the list renders from /api/tasks; the form posts
 * to /api/tasks; each row toggles via /api/tasks/:id/done. Errors are
 * announced in #status (assertive) so keyboard + screen-reader users hear
 * them; the list itself is a polite live region.
 */

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...options,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `request failed (${res.status})`);
  return body;
}

function setStatus(message) {
  document.getElementById('status').textContent = message ?? '';
}

function render(tasks) {
  const list = document.getElementById('list');
  const empty = document.getElementById('empty');
  list.textContent = '';
  empty.hidden = tasks.length !== 0;
  for (const task of tasks) {
    const li = document.createElement('li');
    if (task.done) li.classList.add('done');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = Boolean(task.done);
    box.setAttribute('aria-label', `Mark "${task.title}" ${task.done ? 'not done' : 'done'}`);
    box.addEventListener('change', async () => {
      try {
        await api(`/api/tasks/${encodeURIComponent(task.id)}/done`, {
          method: 'POST',
          body: JSON.stringify({ done: box.checked }),
        });
        await refresh();
      } catch (err) {
        setStatus(err.message);
        box.checked = !box.checked;
      }
    });
    const label = document.createElement('span');
    label.textContent = task.title;
    li.append(box, label);
    list.append(li);
  }
}

async function refresh() {
  try {
    setStatus('');
    render(await api('/api/tasks'));
  } catch (err) {
    setStatus(err.message);
  }
}

document.getElementById('add').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = document.getElementById('title');
  const title = input.value.trim();
  if (!title) {
    setStatus('Give the task a title first.');
    input.focus();
    return;
  }
  try {
    setStatus('');
    await api('/api/tasks', { method: 'POST', body: JSON.stringify({ title }) });
    input.value = '';
    input.focus();
    await refresh();
  } catch (err) {
    setStatus(err.message);
  }
});

refresh();
