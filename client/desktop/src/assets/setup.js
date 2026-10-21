'use strict'

const serverUrl = document.getElementById('serverUrl')
const token = document.getElementById('token')
const status = document.getElementById('status')
const test = document.getElementById('test')
const connect = document.getElementById('connect')

function setStatus(message, kind) {
  status.textContent = message
  status.className = kind === undefined ? '' : kind
}

function busy(value) {
  test.disabled = value
  connect.disabled = value
}

async function readExisting() {
  try {
    const current = await window.coreSetup.current()
    if (typeof current.serverUrl === 'string' && current.serverUrl.length > 0) {
      serverUrl.value = current.serverUrl
      serverUrl.focus()
      setStatus('已保存过服务端地址，请重新输入访问令牌。', 'error')
    }
  } catch {
    // The preload bridge is missing only if the shell is broken; the form still works when typed.
  }
}

test.addEventListener('click', async () => {
  busy(true)
  setStatus('正在测试…')
  try {
    const result = await window.coreSetup.probe({ serverUrl: serverUrl.value, token: token.value })
    setStatus(result.message, result.ok ? 'ok' : 'error')
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '测试失败', 'error')
  } finally {
    busy(false)
  }
})

connect.addEventListener('click', async () => {
  busy(true)
  setStatus('正在连接…')
  try {
    const result = await window.coreSetup.connect({ serverUrl: serverUrl.value, token: token.value })
    if (!result.ok) setStatus(result.message, 'error')
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '连接失败', 'error')
  } finally {
    busy(false)
  }
})

form_enter()
function form_enter() {
  for (const input of [serverUrl, token]) {
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') connect.click()
    })
  }
}

void readExisting()
