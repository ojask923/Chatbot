"""LangGraph agent workflow with multi-provider LLM support and in-memory checkpointing."""

import os
import json
import asyncio
from typing import AsyncGenerator, Dict, Any, List, Optional
from langchain_core.messages import (
    BaseMessage,
    HumanMessage,
    AIMessage,
    SystemMessage,
    ToolMessage,
)
from langgraph.graph import StateGraph, START, END, MessagesState
from langgraph.checkpoint.memory import MemorySaver
from langgraph.prebuilt import ToolNode, tools_condition

from app.config import settings
from app.agent.tools import get_available_tools
from app.services.memory import memory_service





def get_llm(
    provider: Optional[str] = None,
    model: Optional[str] = None,
    temperature: float = 0.7,
    bind_tools: bool = True,
):
    """Factory to instantiate and configure LLM based on provider."""
    provider = (provider or settings.DEFAULT_PROVIDER).lower()
    tools = get_available_tools() if settings.ENABLE_TOOLS and bind_tools else []

    if provider == "openai":
        from langchain_openai import ChatOpenAI
        llm = ChatOpenAI(
            model=model or settings.DEFAULT_MODEL or "gpt-4o-mini",
            temperature=temperature,
            api_key=settings.OPENAI_API_KEY or None,
        )
        return llm.bind_tools(tools) if tools else llm

    elif provider == "gemini":
        from langchain_google_genai import ChatGoogleGenerativeAI
        llm = ChatGoogleGenerativeAI(
            model=model or "gemini-1.5-flash",
            temperature=temperature,
            google_api_key=settings.GEMINI_API_KEY or None,
        )
        return llm.bind_tools(tools) if tools else llm

    elif provider == "groq":
        from langchain_groq import ChatGroq
        llm = ChatGroq(
            model_name=model or settings.DEFAULT_MODEL or "llama-3.3-70b-versatile",
            temperature=temperature,
            api_key=settings.GROQ_API_KEY or os.environ.get("GROQ_API_KEY"),
        )
        return llm.bind_tools(tools) if tools else llm

    elif provider == "anthropic":
        from langchain_anthropic import ChatAnthropic
        llm = ChatAnthropic(
            model_name=model or "claude-3-5-sonnet-20241022",
            temperature=temperature,
            api_key=settings.ANTHROPIC_API_KEY or None,
        )
        return llm.bind_tools(tools) if tools else llm

    elif provider == "ollama":
        from langchain_community.chat_models import ChatOllama
        llm = ChatOllama(
            base_url=settings.OLLAMA_BASE_URL,
            model=model or "llama3.2",
            temperature=temperature,
        )
        return llm.bind_tools(tools) if tools else llm

    raise ValueError(f"Unsupported LLM provider: '{provider}'. Supported providers: groq, ollama, openai, gemini, anthropic")


class ChatAgent:
    """Manages the LangGraph compilation, in-memory checkpointer, and execution."""

    def __init__(self):
        self.checkpointer = MemorySaver()
        self.tools = get_available_tools()
        self._compiled_graphs: Dict[str, Any] = {}

    def build_graph(self, provider: Optional[str] = None, model: Optional[str] = None, temperature: float = 0.7):
        """Construct a compiled StateGraph for the selected provider & model."""
        provider = provider or settings.DEFAULT_PROVIDER
        llm = get_llm(provider, model, temperature, bind_tools=True)
        tool_node = ToolNode(self.tools)

        async def call_model(state: MessagesState):
            messages = state["messages"]
            response = await llm.ainvoke(messages)
            return {"messages": [response]}

        # Define Graph
        workflow = StateGraph(MessagesState)
        workflow.add_node("agent", call_model)
        workflow.add_node("tools", tool_node)

        workflow.add_edge(START, "agent")
        workflow.add_conditional_edges(
            "agent",
            tools_condition,
        )
        workflow.add_edge("tools", "agent")

        return workflow.compile(checkpointer=self.checkpointer)

    async def get_response(
        self,
        message: str,
        session_id: str = "default",
        user_id: str = "default_user",
        provider: Optional[str] = None,
        model: Optional[str] = None,
        system_prompt: Optional[str] = None,
        temperature: float = 0.7,
    ) -> Dict[str, Any]:
        """Invoke the graph and return the final reply with long-term memory integration."""
        provider = provider or settings.DEFAULT_PROVIDER
        graph = self.build_graph(provider, model, temperature)
        config = {"configurable": {"thread_id": session_id}}

        # 1. Search Long-Term Memory
        memories = await memory_service.search(user_id=user_id, query=message)
        enhanced_prompt = system_prompt or "You are a helpful, smart AI assistant."
        if memories:
            enhanced_prompt += f"\n\n<remembered_facts>\nHere are facts you remember about this user across past conversations:\n{memories}\n</remembered_facts>"

        input_messages = [SystemMessage(content=enhanced_prompt), HumanMessage(content=message)]

        result = await graph.ainvoke({"messages": input_messages}, config=config)
        all_messages = result.get("messages", [])
        last_ai_msg = next((m for m in reversed(all_messages) if isinstance(m, AIMessage) and m.content), None)
        content = last_ai_msg.content if last_ai_msg else "No response generated."

        # 2. Asynchronously save new facts to Long-Term Memory
        asyncio.create_task(
            memory_service.add(
                user_id=user_id,
                messages=[{"role": "user", "content": message}, {"role": "assistant", "content": content}],
            )
        )

        return {
            "content": content,
            "session_id": session_id,
            "provider": provider,
            "model": model,
            "memories_used": bool(memories),
        }

    async def stream_response(
        self,
        message: str,
        session_id: str = "default",
        user_id: str = "default_user",
        provider: Optional[str] = None,
        model: Optional[str] = None,
        system_prompt: Optional[str] = None,
        temperature: float = 0.7,
    ) -> AsyncGenerator[Dict[str, Any], None]:
        """Stream response tokens and tool call notifications with long-term memory."""
        provider_clean = (provider or settings.DEFAULT_PROVIDER).lower()

        # 1. Search Long-Term Memory
        memories = await memory_service.search(user_id=user_id, query=message)
        enhanced_prompt = system_prompt or "You are a helpful, smart AI assistant."
        if memories:
            enhanced_prompt += f"\n\n<remembered_facts>\nHere are facts you remember about this user across past conversations:\n{memories}\n</remembered_facts>"

        # Real LLM / LangGraph streaming
        graph = self.build_graph(provider_clean, model, temperature)
        config = {"configurable": {"thread_id": session_id}}
        input_messages = [SystemMessage(content=enhanced_prompt), HumanMessage(content=message)]

        accumulated_text = ""
        async for event in graph.astream_events({"messages": input_messages}, config=config, version="v2"):
            kind = event.get("event")

            # Stream LLM tokens
            if kind == "on_chat_model_stream":
                chunk = event["data"].get("chunk")
                if chunk and chunk.content:
                    if isinstance(chunk.content, str):
                        accumulated_text += chunk.content
                        yield {"type": "token", "content": chunk.content}
                    elif isinstance(chunk.content, list):
                        for part in chunk.content:
                            if isinstance(part, dict) and "text" in part:
                                accumulated_text += part["text"]
                                yield {"type": "token", "content": part["text"]}

            # Tool started
            elif kind == "on_tool_start":
                tool_name = event.get("name", "tool")
                tool_args = event.get("data", {}).get("input", {})
                yield {"type": "tool_start", "name": tool_name, "args": tool_args}

            # Tool ended
            elif kind == "on_tool_end":
                tool_name = event.get("name", "tool")
                tool_output = str(event.get("data", {}).get("output", ""))
                yield {"type": "tool_end", "name": tool_name, "result": tool_output}

        # Save to Long-Term Memory in background
        if accumulated_text:
            asyncio.create_task(
                memory_service.add(
                    user_id=user_id,
                    messages=[{"role": "user", "content": message}, {"role": "assistant", "content": accumulated_text}],
                )
            )

        yield {"type": "done"}

    def get_history(self, session_id: str) -> List[Dict[str, str]]:
        """Retrieve stored chat history for a session."""
        config = {"configurable": {"thread_id": session_id}}
        checkpoint = self.checkpointer.get(config)
        if not checkpoint:
            return []

        messages = checkpoint.get("channel_values", {}).get("messages", [])
        history = []
        for msg in messages:
            if isinstance(msg, HumanMessage):
                history.append({"role": "user", "content": msg.content})
            elif isinstance(msg, AIMessage) and msg.content:
                history.append({"role": "assistant", "content": msg.content})
        return history

    def clear_history(self, session_id: str):
        """Clear memory for a given session ID."""
        try:
            if hasattr(self.checkpointer, "storage"):
                self.checkpointer.storage.pop(session_id, None)
        except Exception:
            pass


agent = ChatAgent()
