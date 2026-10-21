'use strict'

// The offline page is loaded by the shell with `?target=<server>`. It has no IPC bridge (the window
// that shows remote content has no preload), so "retry" is a plain same-origin navigation back to
// the configured server; the shell's navigation guard allows exactly that origin.
const target = new URLSearchParams(window.location.search).get('target')
const button = document.getElementById('retry')
const hint = document.getElementById('target')

if (typeof target === 'string' && target.length > 0) {
  try {
    hint.textContent = `目标：${new URL(target).host}`
  } catch {
    hint.textContent = ''
  }
}

button.addEventListener('click', () => {
  if (typeof target !== 'string' || target.length === 0) return
  button.disabled = true
  button.textContent = '正在重试…'
  window.location.replace(target)
})
