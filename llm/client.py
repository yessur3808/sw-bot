import time

import requests

import config


def _provider_endpoint(provider):
    if config.LLM_API_BASE_URL:
        return config.LLM_API_BASE_URL.rstrip("/") + "/chat/completions"
    if provider == "groq":
        return "https://api.groq.com/openai/v1/chat/completions"
    return "https://openrouter.ai/api/v1/chat/completions"


def _build_headers(provider):
    headers = {
        "Authorization": f"Bearer {config.LLM_API_KEY}",
        "Content-Type": "application/json",
    }
    if provider == "openrouter":
        headers["HTTP-Referer"] = "https://github.com/yessur3808/sw-bot"
        headers["X-Title"] = "Star Wars Bot"
    return headers


def _extract_text(payload):
    choices = payload.get("choices") or []
    if not choices:
        return ""
    first = choices[0] or {}
    message = first.get("message") or {}
    content = message.get("content") or ""
    if isinstance(content, list):
        chunks = []
        for item in content:
            if isinstance(item, dict):
                text = item.get("text")
                if text:
                    chunks.append(str(text))
        return " ".join(chunks).strip()
    return str(content).strip()


def generate_reply(messages):
    if not config.LLM_ENABLED:
        return {
            "ok": False,
            "error": "llm-disabled",
            "provider": config.LLM_PROVIDER,
            "model": config.LLM_MODEL,
        }
    if not config.LLM_API_KEY:
        return {
            "ok": False,
            "error": "missing-api-key",
            "provider": config.LLM_PROVIDER,
            "model": config.LLM_MODEL,
        }

    provider = config.LLM_PROVIDER or "openrouter"
    payload = {
        "model": config.LLM_MODEL,
        "messages": messages,
        "max_tokens": max(32, int(config.LLM_MAX_TOKENS)),
        "temperature": max(0.1, float(config.LLM_TEMPERATURE)),
    }

    started = time.perf_counter()
    try:
        response = requests.post(
            _provider_endpoint(provider),
            json=payload,
            headers=_build_headers(provider),
            timeout=max(5, int(config.LLM_TIMEOUT_SECONDS)),
        )
        response.raise_for_status()
        data = response.json()
        text = _extract_text(data)
        elapsed_ms = int((time.perf_counter() - started) * 1000)
        if not text:
            return {
                "ok": False,
                "error": "empty-response",
                "provider": provider,
                "model": config.LLM_MODEL,
                "latency_ms": elapsed_ms,
            }
        return {
            "ok": True,
            "text": text,
            "provider": provider,
            "model": config.LLM_MODEL,
            "latency_ms": elapsed_ms,
        }
    except Exception as exc:
        elapsed_ms = int((time.perf_counter() - started) * 1000)
        return {
            "ok": False,
            "error": str(exc),
            "provider": provider,
            "model": config.LLM_MODEL,
            "latency_ms": elapsed_ms,
        }
