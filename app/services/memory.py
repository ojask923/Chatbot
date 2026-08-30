"""Long-Term Memory service (mem0 + pgvector / local vector fallback)."""

import os
import asyncio
from typing import Optional, List, Dict, Any
from datetime import datetime, timezone
from sqlmodel import SQLModel, Field, Session, select

from app.config import settings
from app.services.database import db_service


class UserMemory(SQLModel, table=True):
    """Fallback database table for long-term user facts and memories."""

    id: Optional[int] = Field(default=None, primary_key=True)
    user_id: str = Field(index=True)
    memory_text: str = Field(description="The extracted fact or preference")
    category: Optional[str] = Field(default="general")
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class MemoryService:
    """Enterprise-grade long-term memory management for users."""

    def __init__(self):
        self._mem0_instance = None
        self._use_mem0 = False
        self._initialized = False

    async def initialize(self):
        """Initialize mem0 with pgvector if configured, or fallback to database memory store."""
        if self._initialized:
            return

        db_url = settings.DATABASE_URL
        has_openai = bool(settings.OPENAI_API_KEY)

        # If PostgreSQL with pgvector and OpenAI/Ollama is configured, use mem0 AsyncMemory
        if db_url.startswith("postgresql") and has_openai:
            try:
                from mem0 import AsyncMemory
                # Parse postgres connection
                from urllib.parse import urlparse
                parsed = urlparse(db_url)
                
                config = {
                    "vector_store": {
                        "provider": "pgvector",
                        "config": {
                            "collection_name": "user_memories",
                            "dbname": parsed.path.lstrip("/"),
                            "user": parsed.username,
                            "password": parsed.password,
                            "host": parsed.hostname,
                            "port": parsed.port or 5432,
                        },
                    },
                    "llm": {
                        "provider": "openai",
                        "config": {"model": "gpt-4o-mini", "api_key": settings.OPENAI_API_KEY},
                    },
                    "embedder": {
                        "provider": "openai",
                        "config": {"model": "text-embedding-3-small", "api_key": settings.OPENAI_API_KEY},
                    },
                }
                self._mem0_instance = await AsyncMemory.from_config(config)
                self._use_mem0 = True
                print("[INFO] mem0 with pgvector initialized for long-term memory!")
            except Exception as e:
                print(f"[WARNING] Could not initialize mem0 pgvector, using DB memory fallback: {e}")
                self._use_mem0 = False
        else:
            self._use_mem0 = False

        self._initialized = True

    async def search(self, user_id: str, query: str) -> str:
        """Search relevant long-term memories for a user to inject into system prompt."""
        if not user_id:
            return ""

        await self.initialize()

        if self._use_mem0 and self._mem0_instance:
            try:
                results = await self._mem0_instance.search(user_id=str(user_id), query=query)
                if results and "results" in results:
                    return "\n".join([f"- {r['memory']}" for r in results["results"]])
            except Exception as e:
                print(f"[WARNING] mem0 search error: {e}")

        # Fallback to local DB memory search
        try:
            with Session(db_service.engine) as db:
                statement = select(UserMemory).where(UserMemory.user_id == str(user_id))
                memories = db.exec(statement).all()
                if not memories:
                    return ""
                
                # Simple keyword matching / recent memories
                query_words = set(query.lower().split())
                matched = []
                for m in memories:
                    mem_words = set(m.memory_text.lower().split())
                    if query_words & mem_words or len(memories) <= 5:
                        matched.append(f"- {m.memory_text}")
                
                return "\n".join(matched[:5]) if matched else "\n".join([f"- {m.memory_text}" for m in memories[-5:]])
        except Exception as e:
            print(f"[WARNING] Database memory search error: {e}")
            return ""

    async def add(self, user_id: str, messages: List[Dict[str, str]], metadata: Optional[Dict[str, Any]] = None):
        """Extract and persist facts from conversation to long-term memory."""
        if not user_id or not messages:
            return

        await self.initialize()

        if self._use_mem0 and self._mem0_instance:
            try:
                await self._mem0_instance.add(messages, user_id=str(user_id), metadata=metadata)
                return
            except Exception as e:
                print(f"[WARNING] mem0 add error: {e}")

        # Intelligent local extraction fallback (detecting personal facts, preferences, names)
        try:
            user_text = next((m["content"] for m in messages if m.get("role") == "user"), "")
            if not user_text:
                return

            lower = user_text.lower()
            fact_indicators = ["my name is", "i am", "i live in", "i prefer", "i like", "i work as", "my goal is", "remember that", "always use"]
            
            for ind in fact_indicators:
                if ind in lower:
                    # Save fact to DB
                    with Session(db_service.engine) as db:
                        # Check duplicate
                        existing = db.exec(
                            select(UserMemory).where(
                                UserMemory.user_id == str(user_id),
                                UserMemory.memory_text == user_text,
                            )
                        ).first()
                        if not existing:
                            mem = UserMemory(user_id=str(user_id), memory_text=user_text, category="preference")
                            db.add(mem)
                            db.commit()
                    break
        except Exception as e:
            print(f"[WARNING] Memory save error: {e}")

    async def get_all(self, user_id: str) -> List[Dict[str, Any]]:
        """Get all stored long-term memories for a user."""
        if not user_id:
            return []

        await self.initialize()

        if self._use_mem0 and self._mem0_instance:
            try:
                res = await self._mem0_instance.get_all(user_id=str(user_id))
                return res.get("results", [])
            except Exception:
                pass

        try:
            with Session(db_service.engine) as db:
                memories = db.exec(select(UserMemory).where(UserMemory.user_id == str(user_id))).all()
                return [
                    {
                        "id": m.id,
                        "memory": m.memory_text,
                        "created_at": m.created_at.isoformat(),
                        "category": m.category,
                    }
                    for m in memories
                ]
        except Exception:
            return []

    async def delete(self, user_id: str, memory_id: int):
        """Delete a specific memory."""
        try:
            with Session(db_service.engine) as db:
                mem = db.get(UserMemory, memory_id)
                if mem and mem.user_id == str(user_id):
                    db.delete(mem)
                    db.commit()
                    return True
        except Exception:
            pass
        return False

    async def clear_all(self, user_id: str):
        """Delete all memories for a user."""
        try:
            with Session(db_service.engine) as db:
                mems = db.exec(select(UserMemory).where(UserMemory.user_id == str(user_id))).all()
                for m in mems:
                    db.delete(m)
                db.commit()
        except Exception:
            pass


memory_service = MemoryService()
