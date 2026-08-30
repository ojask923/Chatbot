"""Agent tools for the chatbot."""

import math
import datetime
from langchain_core.tools import tool


@tool
def calculate(expression: str) -> str:
    """Evaluate a mathematical expression safely.
    Examples: '2 + 2', 'sqrt(144) * 3', 'sin(radians(90))', '2 ** 8'.
    """
    allowed_names = {
        k: v for k, v in math.__dict__.items() if not k.startswith("__")
    }
    allowed_names.update({
        "abs": abs,
        "round": round,
        "min": min,
        "max": max,
        "sum": sum,
        "pow": pow,
    })
    try:
        # Clean expression
        clean_expr = expression.strip()
        result = eval(clean_expr, {"__builtins__": {}}, allowed_names)
        return f"Result of `{expression}` = {result}"
    except Exception as e:
        return f"Error evaluating expression '{expression}': {str(e)}"


@tool
def get_current_time(timezone: str = "local") -> str:
    """Get the current date, time, and day of the week."""
    now = datetime.datetime.now()
    return f"Current date and time: {now.strftime('%A, %Y-%m-%d %H:%M:%S')} ({timezone} time)"


@tool
def search_web(query: str) -> str:
    """Search the web for up-to-date information, news, or general knowledge using DuckDuckGo."""
    try:
        from duckduckgo_search import DDGS
        with DDGS() as ddgs:
            results = list(ddgs.text(query, max_results=3))
            if not results:
                return f"No search results found for query: '{query}'"
            formatted = []
            for i, r in enumerate(results, 1):
                formatted.append(f"{i}. [{r.get('title', 'No Title')}]({r.get('href', '')}): {r.get('body', '')}")
            return "\n\n".join(formatted)
    except Exception as e:
        return f"Web search could not be completed: {str(e)}"


def get_available_tools():
    """Return the list of active tools for the agent."""
    return [calculate, get_current_time, search_web]
