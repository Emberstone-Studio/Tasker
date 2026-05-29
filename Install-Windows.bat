@echo off
set DEST=%USERPROFILE%\.claude\tasker
echo.
echo Installing Tasker to %DEST% ...
echo.
if not exist "%DEST%" mkdir "%DEST%"
xcopy /E /I /Y "%~dp0Tasker" "%DEST%"
echo.
echo Installing Claude Code skills ...
echo.
node "%DEST%\tasker.js"
echo.
echo Done. Reload VS Code (Ctrl+Shift+P ^> Reload Window), then run /tasker in any project.
echo.
pause
