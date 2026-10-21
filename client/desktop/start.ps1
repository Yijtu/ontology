# 启动桌面客户端。
#
# 双击 start.cmd 即可；本文件负责：检查 Node/pnpm → 首次安装依赖 → 编译 → 启动 Electron。
# 出错时窗口会停住并显示原因，不会一闪而过。
$ErrorActionPreference = 'Stop'

function Stop-WithMessage([string]$message) {
  Write-Host ''
  Write-Host "启动失败：$message" -ForegroundColor Red
  Write-Host ''
  Read-Host '按回车关闭'
  exit 1
}

try {
  Set-Location -LiteralPath $PSScriptRoot

  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Stop-WithMessage '未找到 Node.js，请先安装 Node.js 22+ 并重新打开终端。'
  }
  if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
    Stop-WithMessage '未找到 pnpm，请先运行 "npm install -g pnpm"。'
  }

  if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'node_modules'))) {
    Write-Host '首次启动：正在安装依赖（需要下载 Electron，约几分钟）…' -ForegroundColor Cyan
    pnpm install
    if ($LASTEXITCODE -ne 0) { Stop-WithMessage '依赖安装失败，请检查网络后重试。' }
  }

  Write-Host '正在编译客户端…' -ForegroundColor Cyan
  pnpm run build
  if ($LASTEXITCODE -ne 0) { Stop-WithMessage '编译失败，请查看上面的报错。' }

  Write-Host '正在启动 Ontology Core 客户端…' -ForegroundColor Cyan
  Write-Host '首次启动会要求填写服务端地址；本机演示可用 http://127.0.0.1:3001，令牌留空即可。'
  pnpm exec electron .
  if ($LASTEXITCODE -ne 0) { Stop-WithMessage "Electron 退出，代码 $LASTEXITCODE。" }
}
catch {
  Stop-WithMessage $_.Exception.Message
}
