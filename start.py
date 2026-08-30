"""Interactive launcher for the Simple Local Chatbot."""

import os
import sys
import subprocess
import webbrowser
import time
import threading


def check_and_install_dependencies():
    print("=" * 60)
    print("[*] Starting Simple Local Chatbot...")
    print("=" * 60)

    req_file = os.path.join(os.path.dirname(__file__), "requirements.txt")
    if os.path.exists(req_file):
        try:
            import fastapi
            import uvicorn
            import langgraph
            import pydantic
            import sqlmodel
        except ImportError:
            print("[INFO] Installing required dependencies from requirements.txt...")
            subprocess.check_call([sys.executable, "-m", "pip", "install", "-r", req_file])
            print("[OK] Dependencies installed successfully!")


def open_browser():
    time.sleep(1.5)
    url = "http://127.0.0.1:8000"
    print(f"[INFO] Opening Web Chat UI in your browser: {url}")
    webbrowser.open(url)


def main():
    check_and_install_dependencies()

    # Launch browser in a background thread
    threading.Thread(target=open_browser, daemon=True).start()

    import uvicorn
    from app.config import settings

    print(f"\n[SERVER] Running at: http://{settings.HOST}:{settings.PORT}")
    print("[INFO] Press Ctrl + C in this terminal to stop the server.\n")

    uvicorn.run("main:app", host=settings.HOST, port=settings.PORT, reload=settings.DEBUG)


if __name__ == "__main__":
    main()
