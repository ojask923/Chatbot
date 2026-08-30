"""Chat message database model using SQLModel."""

from datetime import datetime, timezone
from typing import Optional
from sqlmodel import SQLModel, Field, Relationship


class ChatMessage(SQLModel, table=True):
    """Message representation in the database."""

    id: Optional[int] = Field(default=None, primary_key=True)
    session_id: str = Field(foreign_key="chatsession.id", index=True)
    role: str = Field(description="user, assistant, or system")
    content: str = Field(description="Message body text")
    tool_name: Optional[str] = Field(default=None, description="Optional tool name if triggered")
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))

    # Relationship
    session: Optional["ChatSession"] = Relationship(back_populates="messages")
