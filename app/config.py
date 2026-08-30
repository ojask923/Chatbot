import os
from typing import Literal
from dotenv import load_dotenv, find_dotenv
from pydantic_settings import BaseSettings, SettingsConfigDict

ENV_FILE_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env")
load_dotenv(ENV_FILE_PATH, override=True)


class Settings(BaseSettings):
    """Application settings loaded from environment or .env file."""

    model_config = SettingsConfigDict(
        env_file=ENV_FILE_PATH,
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # Server settings
    HOST: str = "127.0.0.1"
    PORT: int = 8000
    DEBUG: bool = True
    APP_NAME: str = "Simple Local Chatbot"
    VERSION: str = "1.0.0"

    # Default LLM configurations
    DEFAULT_PROVIDER: Literal["groq", "ollama", "openai", "gemini", "anthropic"] = "groq"
    DEFAULT_MODEL: str = "openai/gpt-oss-120b"
    TEMPERATURE: float = 0.7

    # API Keys
    OPENAI_API_KEY: str = ""
    GEMINI_API_KEY: str = ""
    GROQ_API_KEY: str = ""
    ANTHROPIC_API_KEY: str = ""

    # Ollama settings
    OLLAMA_BASE_URL: str = "http://localhost:11434"

    # Database settings (defaults to local SQLite, can be PostgreSQL)
    DATABASE_URL: str = "sqlite:///./chatbot.db"

    # Features
    ENABLE_TOOLS: bool = True


settings = Settings()
