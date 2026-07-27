@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

echo ========================================
echo   WithYou Novel - 打包 EXE 工具
echo ========================================
echo.

:: 检查 Node.js
where node >nul 2>&1
if errorlevel 1 (
    echo [错误] 未找到 Node.js，请先安装 Node.js 20+
    pause
    exit /b 1
)

:: 检查 pnpm
where pnpm >nul 2>&1
if errorlevel 1 (
    echo [提示] 未找到 pnpm，正在安装...
    npm install -g pnpm
)

:: 进入项目目录
cd /d "%~dp0"

echo [1/2] 安装依赖...
call pnpm install --frozen-lockfile
if errorlevel 1 (
    echo [错误] 依赖安装失败
    pause
    exit /b 1
)

echo.
echo [2/2] 构建并打包安装程序...
call pnpm electron:build
if errorlevel 1 (
    echo [错误] 构建或打包失败
    pause
    exit /b 1
)

echo.
echo ========================================
echo   打包完成！
echo   输出目录: release\delivery\
echo.
echo   使用说明:
echo   1. 将 .env.example 复制为 .env.local
echo   2. 填入你的真实 API 密钥
echo   3. 安装后放到 %%APPDATA%%\WithYou Novel\.env.local
echo   4. 从开始菜单或桌面快捷方式启动
echo ========================================
pause
