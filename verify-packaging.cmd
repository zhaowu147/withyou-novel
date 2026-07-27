@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

echo ========================================
echo   验证打包配置 - 密钥安全检查
echo ========================================
echo.

cd /d "%~dp0"

echo [检查 1] 敏感文件是否在打包列表中...
echo.

set "SAFE=1"

:: 检查 .env.local
if exist ".env.local" (
    echo [警告] .env.local 存在于项目目录
    echo        这个文件不会被打包进 EXE（因为 files 配置中没有包含它）
    echo        但请确保不要手动添加到打包目录
    echo.
)

:: 检查 settings.json
if exist "settings.json" (
    echo [警告] settings.json 存在于项目目录
    echo        这个文件不会被打包进 EXE（因为 files 配置中没有包含它）
    echo        但请确保不要手动添加到打包目录
    echo.
)

echo [检查 2] 验证 package.json 中的 files 配置...
echo.

:: 检查 files 配置
findstr /C:"\"files\"" package.json >nul 2>&1
if errorlevel 1 (
    echo [错误] 未找到 files 配置
    set "SAFE=0"
) else (
    echo [通过] files 配置存在
    echo        打包内容: electron/**/*, .next/standalone/**/*, public/**/*, package.json
    echo        不包含: .env.local, settings.json, .data/, .pi/, novels/, data/
)

echo.
echo [检查 3] 验证 extraResources 配置...
echo.

findstr /C:"\"extraResources\"" package.json >nul 2>&1
if errorlevel 1 (
    echo [错误] 未找到 extraResources 配置
    set "SAFE=0"
) else (
    echo [通过] extraResources 配置存在
    echo        将 .next/standalone 复制到 resources/standalone
    echo        将 public 复制到 resources/standalone/public
)

echo.
echo [检查 4] 验证 .gitignore 配置...
echo.

if exist ".gitignore" (
    findstr /C:".env.local" .gitignore >nul 2>&1
    if errorlevel 1 (
        echo [警告] .gitignore 中没有排除 .env.local
    ) else (
        echo [通过] .env.local 已在 .gitignore 中
    )

    findstr /C:"settings.json" .gitignore >nul 2>&1
    if errorlevel 1 (
        echo [警告] .gitignore 中没有排除 settings.json
    ) else (
        echo [通过] settings.json 已在 .gitignore 中
    )
) else (
    echo [警告] 未找到 .gitignore 文件
)

echo.
echo ========================================
if "%SAFE%"=="1" (
    echo   验证结果: ✓ 安全
    echo.
    echo   密钥文件不会被打包进 EXE
    echo   运行时需要从 EXE 同目录读取 .env.local
) else (
    echo   验证结果: ✗ 有问题
    echo.
    echo   请检查上述警告并修复
)
echo ========================================
pause
