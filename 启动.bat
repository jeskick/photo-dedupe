@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 未找到 Node.js。请先安装 https://nodejs.org/ 后重新打开本文件。
  pause
  exit /b 1
)
if not exist ".venv\Scripts\python.exe" (
  echo 正在准备画面比对环境，第一次需要联网，请稍候...
  where py >nul 2>nul
  if not errorlevel 1 (
    py -3 -m venv .venv
  ) else (
    where python >nul 2>nul
    if errorlevel 1 (
      echo 未找到 Python。完全相同的文件仍可查重。
      echo 画面相似和 HEIC 预览需要 Python 3.12：https://www.python.org/downloads/
      goto start
    )
    python -m venv .venv
  )
  if not exist ".venv\Scripts\python.exe" (
    echo Python 环境没有准备好，将只查重内容完全相同的文件。
    goto start
  )
  ".venv\Scripts\python.exe" -m pip install -r python\requirements.txt
  if errorlevel 1 (
    echo 画面比对库安装失败。完全相同的文件仍可查重。
  )
)
:start
node src\server.js
if errorlevel 1 pause
