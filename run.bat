@echo off
title Simple Local Chatbot
cd /d "%~dp0"
echo ===================================================
echo   Starting Simple Local Chatbot (FastAPI + LangGraph)
echo ===================================================

if not exist ".venv" (
    echo [INFO] Creating Python virtual environment in .venv ...
    python -m venv .venv
)

call .venv\Scripts\activate.bat

echo [INFO] Checking dependencies...
pip install -r requirements.txt

echo.
echo [INFO] Launching chatbot server...
python start.py

pause
