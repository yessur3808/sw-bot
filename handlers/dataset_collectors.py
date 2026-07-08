import hashlib
import json
import re
import random
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urljoin, urlparse

import feedparser
import requests
from bs4 import BeautifulSoup
from telegram import Update
from telegram.ext import CommandHandler, ContextTypes

import config
import db
from telemetry import instrument_command_handler
from admin import runtime_settings


DATASET_NAMES = {"facts", "quotes", "trivia", "polls", "discussions"}
MAX_TEXT_LEN = 500
ROOT = Path(__file__).resolve().parents[1]
DATASET_PATHS = {
    "facts": ROOT / "data" / "facts.json",
    "quotes": ROOT / "data" / "quotes.json",
    "trivia": ROOT / "data" / "trivia.json",
    "polls": ROOT / "data" / "polls.json",
    "discussions": ROOT / "data" / "discussions.json",
}

FACT_KEYWORDS = (
    "is",
    "was",
    "are",
    "has",
    "first",
    "canon",
    "appeared",
    "debut",
    "known",
)

QUOTE_PATTERN = re.compile(r'["\u201c]([^"\u201d]{18,260})["\u201d]')
TRIVIA_Q_PATTERN = re.compile(r"([^?.!]{18,220}\?)")
SPEAKER_PATTERN = re.compile(r"(?:-|\u2014)\s*([A-Z][A-Za-z0-9 .'-]{2,60})$")


def _is_starwars_domain(url):
    host = (urlparse(url).hostname or "").lower()
    return host == "starwars.com" or host.endswith(".starwars.com")


def _load_dataset(dataset_name):
    path = DATASET_PATHS.get(dataset_name)
    if not path or not path.exists():
        return []
    with path.open("r", encoding="utf-8") as handle:
        payload = json.load(handle)
    return payload if isinstance(payload, list) else []


def _save_dataset(dataset_name, payload):
    path = DATASET_PATHS.get(dataset_name)
    if not path:
        raise ValueError("unknown dataset")
    with path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
        handle.write("\n")


def _normalize_text(value):
    return " ".join((value or "").strip().split())


def _contains_star_wars(text):
    low = (text or "").lower()
    return "star wars" in low or "jedi" in low or "sith" in low or "skywalker" in low


def _dedupe_values(values):
    out = []
    seen = set()
    for raw in values or []:
        value = _normalize_text(str(raw or ""))
        if not value:
            continue
        key = value.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(value)
    return out


def _looks_like_english_sentence(text, min_words=4, require_question=False):
    value = _normalize_text(text)
    if not value:
        return False
    if len(value) < 18 or len(value) > 260:
        return False
    if require_question and not value.endswith("?"):
        return False
    alpha_ratio = sum(1 for ch in value if ch.isalpha()) / max(1, len(value))
    if alpha_ratio < 0.55:
        return False
    words = re.findall(r"[A-Za-z][A-Za-z'\\-]{1,}", value)
    if len(words) < max(1, int(min_words)):
        return False
    if value.isupper():
        return False
    return True


def _normalize_question_text(text):
    value = _normalize_text(text)
    if not value:
        return ""
    value = value.rstrip(".!? ")
    return f"{value}?"


def _normalize_choice_options(options, question_text, min_count=3, max_count=4):
    normalized_question = _normalize_text(question_text).lower()
    cleaned = []
    for raw in options or []:
        opt = _normalize_text(str(raw or ""))
        if len(opt) < 2 or len(opt) > 90:
            continue
        if opt.lower() == normalized_question:
            continue
        if not re.search(r"[A-Za-z]", opt):
            continue
        cleaned.append(opt)
    unique = _dedupe_values(cleaned)
    if len(unique) < int(min_count):
        return []
    return unique[: int(max_count)]


def _validate_question_candidate(question_text, options, answer_text=None):
    question = _normalize_question_text(question_text)
    if not _looks_like_english_sentence(question, min_words=4, require_question=True):
        return None

    normalized_options = _normalize_choice_options(options, question, min_count=3, max_count=4)
    if len(normalized_options) < 3:
        return None

    answer = _normalize_text(answer_text or "")
    if answer:
        answer_match = next((opt for opt in normalized_options if opt.lower() == answer.lower()), None)
        if answer_match:
            answer = answer_match
        else:
            return None

    return {
        "question": question,
        "options": normalized_options,
        "answer_text": answer,
    }


def _item_hash(*parts):
    raw = "|".join(_normalize_text(str(p)).lower() for p in parts if p is not None)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:24]


def _safe_get(url, timeout=18, headers=None):
    hdrs = {"User-Agent": "sw-bot-dataset-collector/1.0"}
    if headers:
        hdrs.update(headers)
    resp = requests.get(url, timeout=timeout, headers=hdrs)
    resp.raise_for_status()
    return resp


def _extract_starwars_news_links(base_url, limit):
    response = _safe_get(base_url)
    soup = BeautifulSoup(response.text, "html.parser")
    links = []
    seen = set()
    for anchor in soup.select("a[href*='/news/']"):
        href = _normalize_text(anchor.get("href", ""))
        if not href:
            continue
        url = urljoin(base_url, href)
        parsed = urlparse(url)
        if "/news/" not in parsed.path.lower():
            continue
        if parsed.path.lower().endswith("/news") or parsed.path.lower().endswith("/news/"):
            continue
        if url in seen:
            continue
        seen.add(url)
        links.append(url)
        if len(links) >= max(limit * 2, 10):
            break
    return links


def _extract_starwars_quotes_from_page(html):
    soup = BeautifulSoup(html, "html.parser")
    quotes = []
    selectors = ["blockquote", "q", ".pullquote", "[class*='quote']"]
    for selector in selectors:
        for node in soup.select(selector):
            text = _normalize_text(node.get_text(" ", strip=True))
            if len(text) < 18 or len(text) > 280:
                continue
            speaker = None
            speaker_match = SPEAKER_PATTERN.search(text)
            if speaker_match:
                speaker = _normalize_text(speaker_match.group(1))
                text = _normalize_text(SPEAKER_PATTERN.sub("", text))
            if text and text not in {q["quote"] for q in quotes}:
                quotes.append({"quote": text, "speaker": speaker})
            if len(quotes) >= 8:
                return quotes
    return quotes


def _fetch_starwars_news_quote_entries(source, limit):
    url = str(source.get("url") or "").strip()
    name = str(source.get("name") or "StarWars.com News").strip()
    tier = str(source.get("tier") or "scrape").strip().lower()
    out = []
    links = _extract_starwars_news_links(url, limit)
    for article_url in links:
        try:
            response = _safe_get(article_url)
        except Exception:
            continue
        page_quotes = _extract_starwars_quotes_from_page(response.text)
        if not page_quotes:
            continue
        soup = BeautifulSoup(response.text, "html.parser")
        title = _normalize_text(soup.title.get_text(" ", strip=True) if soup.title else "")
        for q in page_quotes:
            out.append(
                {
                    "title": title,
                    "url": article_url,
                    "text": q["quote"],
                    "quote_text": q["quote"],
                    "speaker": q.get("speaker"),
                    "source_name": name,
                    "source_url": url,
                    "source_tier": tier,
                    "parser_hint": "starwars_news_quotes",
                }
            )
            if len(out) >= limit:
                return out
    return out


def _fetch_starwars_databank_entries(source, limit):
    url = str(source.get("url") or "").strip()
    name = str(source.get("name") or "StarWars.com Databank").strip()
    tier = str(source.get("tier") or "scrape").strip().lower()
    response = _safe_get(url)
    soup = BeautifulSoup(response.text, "html.parser")

    names = []
    payload = []
    seen = set()
    for anchor in soup.select("a[href*='/databank/']"):
        label = _normalize_text(anchor.get_text(" ", strip=True))
        href = _normalize_text(anchor.get("href", ""))
        if len(label) < 3 or len(label) > 80 or not href:
            continue
        full_url = urljoin(url, href)
        if full_url in seen:
            continue
        seen.add(full_url)
        names.append(label)
        context = ""
        if anchor.parent:
            context = _normalize_text(anchor.parent.get_text(" ", strip=True))[:MAX_TEXT_LEN]
        payload.append(
            {
                "title": label,
                "url": full_url,
                "text": context,
                "source_name": name,
                "source_url": url,
                "source_tier": tier,
                "parser_hint": "starwars_databank",
            }
        )
        if len(payload) >= max(limit * 2, 16):
            break

    pool = list(dict.fromkeys(names))
    for row in payload:
        row["databank_pool"] = pool[:]
    return payload[:limit]


def _extract_json_items(payload):
    if isinstance(payload, list):
        return payload
    if not isinstance(payload, dict):
        return []
    for key in ("items", "results", "data", "articles", "entries"):
        value = payload.get(key)
        if isinstance(value, list):
            return value
    return []


def _fetch_source_entries(source, dataset_name, limit):
    tier = str(source.get("tier") or "rss").strip().lower()
    url = str(source.get("url") or "").strip()
    name = str(source.get("name") or "source").strip()
    meta = source.get("meta") or {}
    out = []

    if not url:
        return out

    if tier == "rss":
        parsed = feedparser.parse(url)
        for ent in (parsed.entries or [])[:limit]:
            title = _normalize_text(getattr(ent, "title", ""))
            link = _normalize_text(getattr(ent, "link", ""))
            summary = _normalize_text(getattr(ent, "summary", ""))
            if not title or not link:
                continue
            out.append(
                {
                    "title": title,
                    "url": link,
                    "text": summary,
                    "source_name": name,
                    "source_url": url,
                    "source_tier": tier,
                }
            )
        return out

    if tier == "api":
        payload = _safe_get(url, headers={"Accept": "application/json"}).json()
        rows = _extract_json_items(payload)
        for row in rows[:limit]:
            if not isinstance(row, dict):
                continue
            title = _normalize_text(str(row.get("title") or row.get("name") or row.get("headline") or ""))
            link = _normalize_text(str(row.get("url") or row.get("link") or row.get("permalink") or url))
            text = _normalize_text(str(row.get("summary") or row.get("description") or row.get("excerpt") or ""))
            if not title:
                continue
            out.append(
                {
                    "title": title,
                    "url": link,
                    "text": text,
                    "source_name": name,
                    "source_url": url,
                    "source_tier": tier,
                }
            )
        return out

    parser_name = str(meta.get("parser") or "").strip().lower()
    if tier == "scrape" and _is_starwars_domain(url):
        if dataset_name == "quotes" and (parser_name in ("", "generic", "starwars_news_quotes")) and "/news" in urlparse(url).path.lower():
            return _fetch_starwars_news_quote_entries(source, limit)
        if dataset_name == "trivia" and (parser_name in ("", "generic", "starwars_databank")) and "/databank" in urlparse(url).path.lower():
            return _fetch_starwars_databank_entries(source, limit)

    # scrape fallback
    html = _safe_get(url).text
    soup = BeautifulSoup(html, "html.parser")

    blockquotes = [_normalize_text(node.get_text(" ", strip=True)) for node in soup.select("blockquote")]
    paragraphs = [_normalize_text(node.get_text(" ", strip=True)) for node in soup.select("p")]
    anchors = soup.select("a[href]")

    for anchor in anchors[: max(limit * 2, 10)]:
        title = _normalize_text(anchor.get_text(" ", strip=True))
        href = _normalize_text(anchor.get("href", ""))
        if len(title) < 10 or not href:
            continue
        full_url = urljoin(url, href)
        context = ""
        if anchor.parent:
            context = _normalize_text(anchor.parent.get_text(" ", strip=True))[:MAX_TEXT_LEN]
        out.append(
            {
                "title": title,
                "url": full_url,
                "text": context,
                "source_name": name,
                "source_url": url,
                "source_tier": tier,
                "blockquotes": blockquotes[:8],
                "paragraphs": paragraphs[:24],
                "parser_hint": parser_name or "generic",
            }
        )
        if len(out) >= limit:
            break

    if not out:
        out.append(
            {
                "title": _normalize_text(soup.title.get_text(" ", strip=True) if soup.title else name),
                "url": url,
                "text": " ".join(paragraphs[:4])[:MAX_TEXT_LEN],
                "source_name": name,
                "source_url": url,
                "source_tier": tier,
                "blockquotes": blockquotes[:8],
                "paragraphs": paragraphs[:24],
                "parser_hint": parser_name or "generic",
            }
        )
    return out[:limit]


def _fact_candidates(entry):
    blob = " ".join([entry.get("title", ""), entry.get("text", "")]).strip()
    if not blob:
        return []

    # Split into sentence-like chunks and keep factual-looking lines.
    pieces = re.split(r"(?<=[.!?])\s+", blob)
    out = []
    for piece in pieces:
        clean = _normalize_text(piece)
        if len(clean) < 40 or len(clean) > 260:
            continue
        low = clean.lower()
        if not _contains_star_wars(clean):
            continue
        if not any(token in low for token in FACT_KEYWORDS):
            continue
        out.append({"text": clean, "confidence": 0.65})
        if len(out) >= 3:
            break
    return out


def _quote_candidates(entry):
    if entry.get("quote_text"):
        return [
            {
                "text": _normalize_text(entry.get("quote_text") or ""),
                "speaker": _normalize_text(entry.get("speaker") or ""),
                "confidence": 0.82,
            }
        ]

    out = []
    pool = []
    pool.extend(entry.get("blockquotes") or [])
    pool.append(entry.get("text") or "")
    pool.append(entry.get("title") or "")

    for chunk in pool:
        if not chunk:
            continue
        for match in QUOTE_PATTERN.findall(chunk):
            quote = _normalize_text(match)
            if len(quote) < 18:
                continue
            if not _contains_star_wars(f"{entry.get('title', '')} {entry.get('text', '')} {quote}"):
                continue
            out.append({"text": quote, "confidence": 0.62})
            if len(out) >= 3:
                return out

    # Fall back to quote-like short lines in blockquotes.
    for line in entry.get("blockquotes") or []:
        clean = _normalize_text(line)
        if 18 <= len(clean) <= 220:
            out.append({"text": clean, "confidence": 0.58})
            if len(out) >= 3:
                break
    return out


def _trivia_candidates(entry):
    if entry.get("parser_hint") == "starwars_databank" and entry.get("databank_pool"):
        correct = _normalize_text(entry.get("title") or "")
        pool = [_normalize_text(v) for v in (entry.get("databank_pool") or []) if _normalize_text(v)]
        distractors = [v for v in pool if v.lower() != correct.lower()]
        if len(distractors) >= 3 and correct:
            seed = int(hashlib.sha256(correct.encode("utf-8")).hexdigest()[:8], 16)
            rng = random.Random(seed)
            pick = rng.sample(distractors, 3)
            options = [correct] + pick
            rng.shuffle(options)
            validated = _validate_question_candidate(
                "Which of these appears as a Star Wars Databank entry in this source set?",
                options,
                answer_text=correct,
            )
            if validated:
                return [
                    {
                        "text": validated["question"],
                        "options": validated["options"],
                        "answer_text": validated["answer_text"],
                        "confidence": 0.74,
                    }
                ]

    out = []
    blob = " ".join((entry.get("title") or "", entry.get("text") or ""))
    for match in TRIVIA_Q_PATTERN.findall(blob):
        question = _normalize_question_text(match)
        if len(question) < 20:
            continue
        if "star wars" not in question.lower() and not _contains_star_wars(blob):
            continue
        # Fallback options are intentionally generic but unique and grammatically stable.
        validated = _validate_question_candidate(
            question,
            [
                "Option A",
                "Option B",
                "Option C",
                "Option D",
            ],
        )
        if not validated:
            continue
        out.append({"text": validated["question"], "options": validated["options"], "confidence": 0.57})
        if len(out) >= 3:
            break

    if out:
        return out

    # Create lightweight trivia prompts from headlines with fixed, valid options.
    title = _normalize_text(entry.get("title") or "")
    if len(title) >= 16 and _contains_star_wars(title):
        validated = _validate_question_candidate(
            f"Which statement best matches this headline: {title}?",
            [
                "It confirms official canon details",
                "It is likely fan speculation",
                "It focuses on production updates",
                "It is mostly unrelated context",
            ],
        )
        if validated:
            out.append({"text": validated["question"], "options": validated["options"], "confidence": 0.5})
    return out


def _poll_candidates(entry):
    title = _normalize_text(entry.get("title") or "")
    if len(title) < 14:
        return []
    if not _contains_star_wars(title):
        return []
    prompt = f"What do you think about this Star Wars update: {title}?"
    validated = _validate_question_candidate(
        prompt,
        [
            "Very excited",
            "Mostly positive",
            "Neutral",
            "Not excited",
        ],
    )
    if not validated:
        return []
    return [{"text": validated["question"], "options": validated["options"], "confidence": 0.54}]


def _discussion_candidates(entry):
    title = _normalize_text(entry.get("title") or "")
    if len(title) < 16:
        return []
    if not _contains_star_wars(title):
        return []
    prompt = f"Hot take debate: does '{title}' change your view of Star Wars canon direction?"
    return [{"text": prompt, "confidence": 0.56}]


def _extract_candidates_for_dataset(dataset_name, entry):
    if dataset_name == "facts":
        return _fact_candidates(entry)
    if dataset_name == "quotes":
        return _quote_candidates(entry)
    if dataset_name == "trivia":
        return _trivia_candidates(entry)
    if dataset_name == "polls":
        return _poll_candidates(entry)
    if dataset_name == "discussions":
        return _discussion_candidates(entry)
    return []


def ingest_dataset_sources():
    if not runtime_settings.get("enable_dataset_collectors"):
        return {
            "ok": False,
            "reason": "dataset-collectors-disabled",
            "saved": 0,
            "fetched": 0,
            "by_dataset": {},
            "errors": [],
        }

    sources = list(config.DATASET_SOURCES or [])
    per_source_limit = max(1, int(runtime_settings.get("dataset_collector_source_limit")))

    total_fetched = 0
    total_saved = 0
    by_dataset = {k: 0 for k in DATASET_NAMES}
    errors = []

    seen_candidate_signatures = set()

    for source in sources:
        dataset_name = str(source.get("dataset") or "").strip().lower()
        if dataset_name not in DATASET_NAMES:
            continue

        fetched = 0
        saved = 0
        try:
            entries = _fetch_source_entries(source, dataset_name, per_source_limit)
            fetched = len(entries)
            total_fetched += fetched

            for entry in entries:
                extracted = _extract_candidates_for_dataset(dataset_name, entry)
                for candidate in extracted:
                    text = _normalize_text(candidate.get("text") or "")
                    if not text:
                        continue

                    options = candidate.get("options") or []
                    answer_text = candidate.get("answer_text")
                    if dataset_name in ("trivia", "polls"):
                        validated = _validate_question_candidate(text, options, answer_text=answer_text)
                        if not validated:
                            continue
                        text = validated["question"]
                        options = validated["options"]
                        answer_text = validated["answer_text"]

                    signature = _item_hash(dataset_name, text, json.dumps(options or [], ensure_ascii=False))
                    if signature in seen_candidate_signatures:
                        continue
                    seen_candidate_signatures.add(signature)

                    key = _item_hash(dataset_name, text, entry.get("url"), entry.get("source_name"))
                    db.dataset_candidate_upsert(
                        {
                            "dataset_name": dataset_name,
                            "candidate_key": key,
                            "source_name": entry.get("source_name") or source.get("name") or "source",
                            "source_url": entry.get("url") or source.get("url") or "",
                            "source_tier": source.get("tier") or "rss",
                            "title": entry.get("title") or "",
                            "body_text": text[:MAX_TEXT_LEN],
                            "options_json": options,
                            "answer_text": answer_text,
                            "confidence": float(candidate.get("confidence") or 0.5),
                            "status": "candidate",
                            "source_meta": {
                                "dataset": dataset_name,
                                "ingested_at": datetime.now(timezone.utc).isoformat(),
                                "origin_url": source.get("url"),
                                "origin_name": source.get("name"),
                                "parser_hint": entry.get("parser_hint") or (source.get("meta") or {}).get("parser") or "generic",
                                "speaker": candidate.get("speaker") or entry.get("speaker") or "",
                            },
                        }
                    )
                    saved += 1
                    total_saved += 1
                    by_dataset[dataset_name] = by_dataset.get(dataset_name, 0) + 1

            db.log_ingestion_run(
                run_type="dataset",
                source_name=f"{source.get('name')} [{dataset_name}]",
                source_url=source.get("url") or "",
                status="ok",
                fetched_count=fetched,
                saved_count=saved,
            )
        except Exception as exc:
            errors.append(f"{source.get('name')}: {exc}")
            db.log_ingestion_run(
                run_type="dataset",
                source_name=f"{source.get('name')} [{dataset_name}]",
                source_url=source.get("url") or "",
                status="error",
                fetched_count=fetched,
                saved_count=saved,
                error=str(exc),
            )

    return {
        "ok": len(errors) == 0,
        "saved": total_saved,
        "fetched": total_fetched,
        "by_dataset": by_dataset,
        "errors": errors,
    }


async def dataset_ingest_job(context: ContextTypes.DEFAULT_TYPE):
    ingest_dataset_sources()


def _is_admin(update: Update):
    user = update.effective_user
    return bool(user and db.is_admin_user(user.id))


async def dataset_ingest_now_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not _is_admin(update):
        await update.message.reply_text("Admin only command.")
        return
    summary = ingest_dataset_sources()
    lines = [
        "Dataset collectors run completed:",
        f"- fetched={summary.get('fetched', 0)}",
        f"- saved={summary.get('saved', 0)}",
    ]
    for name, count in sorted((summary.get("by_dataset") or {}).items()):
        lines.append(f"- {name}: {count}")
    if summary.get("errors"):
        lines.append("Errors:")
        for err in summary["errors"][:6]:
            lines.append(f"- {err}")
    await update.message.reply_text("\n".join(lines))


async def dataset_candidates_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not _is_admin(update):
        await update.message.reply_text("Admin only command.")
        return

    dataset_name = None
    limit = 8
    if context.args:
        first = context.args[0].strip().lower()
        if first in DATASET_NAMES:
            dataset_name = first
        if first.isdigit():
            limit = max(1, min(20, int(first)))
    if len(context.args) >= 2 and context.args[1].isdigit():
        limit = max(1, min(20, int(context.args[1])))

    rows = db.list_dataset_candidates(dataset_name=dataset_name, status="candidate", limit=limit)
    if not rows:
        await update.message.reply_text("No dataset candidates found yet.")
        return

    title = f"Dataset candidates ({dataset_name or 'all'}):"
    lines = [title]
    for row in rows:
        rid = row.get("id") if hasattr(row, "get") else row[0]
        ds = row.get("dataset_name") if hasattr(row, "get") else row[1]
        text = row.get("body_text") if hasattr(row, "get") else row[7]
        source = row.get("source_name") if hasattr(row, "get") else row[3]
        try:
            confidence = float(row.get("confidence") if hasattr(row, "get") else row[10])
        except Exception:
            confidence = 0.0
        snippet = _normalize_text(text)[:140]
        lines.append(f"- #{rid} [{ds}] ({confidence:.2f}) {snippet} | source={source}")
    await update.message.reply_text("\n".join(lines))


def _parse_source_meta(raw):
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str) and raw.strip():
        try:
            parsed = json.loads(raw)
            return parsed if isinstance(parsed, dict) else {}
        except Exception:
            return {}
    return {}


def _normalize_candidate_item(dataset_name, row):
    body = _normalize_text(row.get("body_text") if hasattr(row, "get") else row[7])
    title = _normalize_text(row.get("title") if hasattr(row, "get") else row[6])
    source_name = _normalize_text(row.get("source_name") if hasattr(row, "get") else row[3])
    source_url = _normalize_text(row.get("source_url") if hasattr(row, "get") else row[4])
    source_tier = _normalize_text(row.get("source_tier") if hasattr(row, "get") else row[5])
    answer_text = _normalize_text((row.get("answer_text") if hasattr(row, "get") else row[9]) or "")
    options_raw = row.get("options_json") if hasattr(row, "get") else row[8]
    meta = _parse_source_meta(row.get("source_meta") if hasattr(row, "get") else row[12])

    options = []
    if isinstance(options_raw, list):
        options = [str(v).strip() for v in options_raw if str(v).strip()]
    elif isinstance(options_raw, str) and options_raw.strip():
        try:
            parsed = json.loads(options_raw)
            if isinstance(parsed, list):
                options = [str(v).strip() for v in parsed if str(v).strip()]
        except Exception:
            options = []

    source_obj = {
        "type": source_tier or "source",
        "title": source_name,
        "url": source_url,
    }

    if dataset_name == "facts":
        if not body:
            return None, "empty fact"
        return {
            "text": body,
            "category": "source_collected_fact",
            "topics": ["auto-collected", "source-ingest"],
            "source": source_obj,
        }, None

    if dataset_name == "quotes":
        if not body:
            return None, "empty quote"
        speaker = _normalize_text(meta.get("speaker") or "")
        quote_text = body
        if not speaker:
            match = SPEAKER_PATTERN.search(body)
            if match:
                speaker = _normalize_text(match.group(1))
                quote_text = _normalize_text(SPEAKER_PATTERN.sub("", body))
        return {
            "quote": quote_text,
            "speaker": speaker or "Unknown",
            "category": "source_collected_quote",
            "topics": ["auto-collected", "source-ingest"],
            "source": source_obj,
        }, None

    if dataset_name == "trivia":
        if not body:
            return None, "empty trivia"
        validated = _validate_question_candidate(body, options, answer_text=answer_text)
        if not validated:
            return None, "invalid trivia question/options"
        question = validated["question"]
        options = validated["options"]
        answer_text = validated.get("answer_text") or options[0]
        correct_idx = 0
        for idx, value in enumerate(options):
            if value.strip().lower() == answer_text.strip().lower():
                correct_idx = idx
                break
        return {
            "question": question,
            "options": options,
            "correct": correct_idx,
            "category": "source_collected_trivia",
            "topics": ["auto-collected", "source-ingest"],
            "source": source_obj,
        }, None

    if dataset_name == "polls":
        validated = _validate_question_candidate(
            body,
            options or ["Very excited", "Interested", "Neutral", "Not interested"],
        )
        if not validated:
            return None, "invalid poll question/options"
        return {
            "question": validated["question"],
            "options": validated["options"],
            "category": "source_collected_poll",
            "topics": ["auto-collected", "source-ingest"],
            "source": source_obj,
        }, None

    if dataset_name == "discussions":
        prompt = body if body.endswith("?") else f"{body}?"
        if len(options) < 2:
            options = ["Strongly agree", "Somewhat agree", "Somewhat disagree", "Strongly disagree"]
        return {
            "prompt": prompt,
            "stance_options": options,
            "category": "source_collected_discussion",
            "topics": ["auto-collected", "source-ingest"],
            "source": source_obj,
        }, None

    return None, "unsupported dataset"


def _dedupe_key_for_item(dataset_name, item):
    if dataset_name == "facts":
        return _normalize_text(item.get("text") or "").lower()
    if dataset_name == "quotes":
        return _normalize_text(item.get("quote") or "").lower()
    if dataset_name == "trivia":
        q = _normalize_text(item.get("question") or item.get("q") or "").lower()
        opts = [
            _normalize_text(v).lower()
            for v in (item.get("options") or [])
            if _normalize_text(v)
        ]
        return f"{q}|{'|'.join(opts)}"
    if dataset_name == "polls":
        q = _normalize_text(item.get("question") or item.get("q") or "").lower()
        opts = [
            _normalize_text(v).lower()
            for v in (item.get("options") or [])
            if _normalize_text(v)
        ]
        return f"{q}|{'|'.join(opts)}"
    if dataset_name == "discussions":
        return _normalize_text(item.get("prompt") or item.get("question") or "").lower()
    return ""


def approve_candidate(candidate_id):
    row = db.get_dataset_candidate(candidate_id)
    if not row:
        return {"ok": False, "reason": "not-found"}

    dataset_name = str(row.get("dataset_name") if hasattr(row, "get") else row[1]).strip().lower()
    if dataset_name not in DATASET_NAMES:
        return {"ok": False, "reason": "invalid-dataset"}

    item, err = _normalize_candidate_item(dataset_name, row)
    if err:
        return {"ok": False, "reason": err}

    payload = _load_dataset(dataset_name)
    key = _dedupe_key_for_item(dataset_name, item)
    existing = {_dedupe_key_for_item(dataset_name, v) for v in payload}
    if key in existing:
        db.set_dataset_candidate_status(candidate_id, "approved")
        return {"ok": True, "dataset": dataset_name, "duplicate": True, "size": len(payload)}

    payload.append(item)
    _save_dataset(dataset_name, payload)
    db.set_dataset_candidate_status(candidate_id, "approved")
    return {"ok": True, "dataset": dataset_name, "duplicate": False, "size": len(payload)}


def reject_candidate(candidate_id):
    row = db.get_dataset_candidate(candidate_id)
    if not row:
        return {"ok": False, "reason": "not-found"}
    db.set_dataset_candidate_status(candidate_id, "rejected")
    return {"ok": True}


def register(app):
    app.add_handler(CommandHandler("dataset_ingest_now", instrument_command_handler("dataset_ingest_now", dataset_ingest_now_cmd)))
    app.add_handler(CommandHandler("dataset_candidates", instrument_command_handler("dataset_candidates", dataset_candidates_cmd)))
