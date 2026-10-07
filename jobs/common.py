"""Shared runtime for every GitHub Actions job.

Public-repo rules (BUILD_PLAN.md section 13), enforced here so each job cannot forget:
  * log() prints step names, counts and pass/fail only. Never a transcript, caption, brand
    text, file name, link or id. scripts/validators/no-content-in-logs.mjs refuses print()
    anywhere else in jobs/.
  * Every call to the Worker is signed: HMAC-SHA256(secret, f"{ts}.{body}") in headers, plus
    the job nonce. The spec is fetched, never passed through GitHub.
  * Storage only through the Worker: download_input() streams a file with a signed GET,
    upload_output() writes one with the signed chunked upload. A job holds no storage keys;
    the Worker decides which keys each job type may read and write (worker/lib/jobStorage.ts).
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import sys
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any

WORK = Path(os.environ.get("JOB_WORK_DIR", "jobs/work"))


_QUOTED = re.compile(r"(['\"`]).*?\1")
_PATH = re.compile(r"(?:[A-Za-z]:)?(?:[\\/][^\s:'\"]+)+")


def safe_detail(message: str) -> str:
    """An exception message made safe for a public log: first line only, anything quoted (which
    can be her script, a file name or a value) replaced by '…', paths cut to their file name,
    at most 160 characters. Library errors stay readable: "'NoneType' object is not callable"
    becomes "'…' object is not callable"."""
    first = (message or "").strip().splitlines()[0] if (message or "").strip() else ""
    first = _QUOTED.sub("'…'", first)
    first = _PATH.sub(lambda m: Path(m.group(0)).name, first)
    return first[:160]


def _content_strings(value: Any, out: list[str]) -> list[str]:
    """Every text in a job spec (her script, notes, file keys…), whole and sentence by sentence."""
    if isinstance(value, str):
        if len(value) >= 6:
            out.append(value)
            out.extend(p.strip() for p in re.split(r"[.!?\n]+", value) if len(p.strip()) >= 8)
    elif isinstance(value, dict):
        for v in value.values():
            _content_strings(v, out)
    elif isinstance(value, (list, tuple)):
        for v in value:
            _content_strings(v, out)
    return out


def failure_fields(e: BaseException, spec: Any = None) -> dict[str, str]:
    """What a failed job logs: the exception class, the innermost frame as file:line (library
    code, never her content), and the safe message with every text from the job's own spec
    removed as well as anything quoted. A job failure is never silent (26 Sep 2026: a voice job
    died logging only "job.failed")."""
    frames = traceback.extract_tb(e.__traceback__)
    where = f"{Path(frames[-1].filename).name}:{frames[-1].lineno}" if frames else "-"
    message = str(e)
    for text in sorted(_content_strings(spec, []), key=len, reverse=True):
        message = message.replace(text, "…")
    return {"error": type(e).__name__[:40], "where": where[:40], "detail": safe_detail(message)}


def log(step: str, **fields: Any) -> None:
    """The only allowed output. Values are numbers, booleans or short enums; the one text field
    is `detail`, always passed through safe_detail()."""
    safe: dict[str, Any] = {}
    for k, v in fields.items():
        if k == "detail" and isinstance(v, str):
            safe[k] = safe_detail(v)
        elif isinstance(v, (int, float, bool)) or v is None:
            safe[k] = v
        elif isinstance(v, str) and len(v) <= 40 and " " not in v:
            safe[k] = v
        else:
            safe[k] = "[redacted]"
    sys.stdout.write(json.dumps({"step": step, **safe}) + "\n")
    sys.stdout.flush()


# ---------- OpenRouter: the ONE place a job talks to the model ----------
# "openrouter/free" routes each call to whichever free model is up; reasoning models spend
# max_tokens thinking and can stop mid-answer (finish_reason "length"). Phase 0 live test,
# 25 Sep 2026: a 2,500-token budget came back as JSON cut off mid-sentence. An answer that
# stopped for length is asked again with four times the room (up to 16,000). The
# `jobs-one-openrouter-client` validator keeps every job on this function.
OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
OPENROUTER_MAX_TOKENS_CEILING = 16_000


def openrouter_content(key: str, payload: dict[str, Any], timeout: float = 180, usable: Any = None) -> tuple[str, dict[str, Any]]:
    """POST a chat completion; returns (content, raw response). HTTP errors propagate.

    `usable(content) -> bool`: when an answer that stopped for length is not usable, ask again
    with more room (at most twice)."""
    body = dict(payload)
    data: dict[str, Any] = {}
    content = ""
    for _ in range(3):
        req = urllib.request.Request(OPENROUTER_URL, data=json.dumps(body).encode(), method="POST", headers={
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "X-Title": "Sample Studio",
        })
        with urllib.request.urlopen(req, timeout=timeout) as res:
            data = json.loads(res.read().decode())
        choice = (data.get("choices") or [{}])[0]
        content = (choice.get("message") or {}).get("content") or ""
        cut_short = choice.get("finish_reason") == "length"
        if not cut_short or (usable is not None and usable(content)):
            return content, data
        more = min(OPENROUTER_MAX_TOKENS_CEILING, int(body.get("max_tokens") or 1200) * 4)
        if more <= int(body.get("max_tokens") or 0):
            break
        log("llm.more_room", max_tokens=more)
        body["max_tokens"] = more
    return content, data


def json_object_in(text: str) -> bool:
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end < 0:
        return False
    try:
        json.loads(text[start : end + 1])
        return True
    except ValueError:
        return False


# ---------- Web search + page reading: the ONE place a job reaches the open web ----------
# Firecrawl is optional (owner, 26 Sep 2026): the brand finder and the Research Brief must work
# with no web-research key at all. Order, per call:
#   search: Firecrawl (if her key is connected) -> Jina search (only answers with a key: it
#           returned 401 AuthenticationRequiredError without one when checked on 25 Sep 2026,
#           so it is skipped on 401) -> the keyless engines in FREE_SEARCH order: DuckDuckGo's
#           HTML page, DuckDuckGo Lite, then DuckDuckGo read through the keyless Jina reader.
#           DuckDuckGo answers GitHub's runners with 202 (its bot wall: all 12 searches of the
#           staging run on 26 Sep 2026); through Jina the request leaves from Jina's servers. An
#           engine that refuses is skipped for the rest of the job; the first that answers is
#           tried first from then on.
#   read:   Firecrawl (if connected) -> Jina reader r.jina.ai (keyless, ~20 requests a minute)
#           -> a plain fetch with the tags stripped.
# A Firecrawl 401/402 (bad key / out of credits) falls through to the free path and is counted,
# so the job can tell the Worker to show the light instead of failing. The validator
# `web-research-optional` keeps every job on this class and refuses a Firecrawl-only path.
FIRECRAWL_URL = "https://api.firecrawl.dev/v1"
JINA_SEARCH_URL = "https://s.jina.ai/"
JINA_READ_URL = "https://r.jina.ai/"
DDG_HTML_URL = "https://html.duckduckgo.com/html/"
DDG_LITE_URL = "https://lite.duckduckgo.com/lite/"
FREE_SEARCH = ("duckduckgo", "duckduckgo_lite", "jina_duckduckgo")
_UA = "Mozilla/5.0 (compatible; CreatorStudios/1.0; +https://github.com/example/studio-jobs)"


def _http(url: str, data: bytes | None = None, headers: dict[str, str] | None = None, timeout: float = 45) -> tuple[int, str]:
    req = urllib.request.Request(url, data=data, method="POST" if data is not None else "GET", headers={"User-Agent": _UA, **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read(3_000_000).decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, ""
    except (urllib.error.URLError, TimeoutError, OSError):
        return 0, ""


def parse_ddg_html(html: str, limit: int) -> list[dict[str, str]]:
    """Result links from DuckDuckGo's HTML page (the uddg= redirect holds the real url)."""
    import html as _html
    import re

    out: list[dict[str, str]] = []
    for m in re.finditer(r'<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>(.*?)</a>', html, re.S):
        href = _html.unescape(m.group(1))
        q = urllib.parse.parse_qs(urllib.parse.urlparse(href if "://" in href else f"https:{href}").query)
        url = q.get("uddg", [href])[0]
        if not url.startswith("http") or "duckduckgo.com/y.js" in url:
            continue
        title = re.sub(r"<[^>]+>", "", _html.unescape(m.group(2))).strip()
        snippet_m = re.search(r'class="result__snippet"[^>]*>(.*?)</a>', html[m.end() : m.end() + 3000], re.S)
        desc = re.sub(r"<[^>]+>", "", _html.unescape(snippet_m.group(1))).strip() if snippet_m else ""
        out.append({"url": url, "title": title[:200], "description": desc[:400]})
        if len(out) >= limit:
            break
    return out


def _uddg(href: str) -> str:
    import html as _html

    href = _html.unescape(href)
    q = urllib.parse.parse_qs(urllib.parse.urlparse(href if "://" in href else f"https:{href}").query)
    return q.get("uddg", [href])[0]


def parse_ddg_lite(html: str, limit: int) -> list[dict[str, str]]:
    """Result links from DuckDuckGo Lite (a table of result-link anchors and result-snippet cells)."""
    import html as _html
    import re

    out: list[dict[str, str]] = []
    for m in re.finditer(r"<a[^>]+href=\"([^\"]+)\"[^>]*class='result-link'[^>]*>(.*?)</a>", html, re.S):
        url = _uddg(m.group(1))
        if not url.startswith("http") or "duckduckgo.com/y.js" in url:
            continue
        snip = re.search(r"class='result-snippet'[^>]*>(.*?)</td>", html[m.end() : m.end() + 3000], re.S)
        clean = lambda t: re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", _html.unescape(t))).strip()
        out.append({"url": url, "title": clean(m.group(2))[:200], "description": clean(snip.group(1))[:400] if snip else ""})
        if len(out) >= limit:
            break
    return out


def parse_jina_ddg(text: str, limit: int) -> list[dict[str, str]]:
    """DuckDuckGo's result page as the Jina reader returns it: '## [title](duckduckgo.com/l/?uddg=…)' headings."""
    import re

    try:
        content = (json.loads(text).get("data") or {}).get("content") or ""
    except ValueError:
        content = text
    out: list[dict[str, str]] = []
    seen: set[str] = set()
    for m in re.finditer(r"^#+ \[([^\]]+)\]\((https?://duckduckgo\.com/l/\?uddg=[^)\s]+)\)", content, re.M):
        url = _uddg(m.group(2))
        if not url.startswith("http") or url in seen or "duckduckgo.com/y.js" in url:
            continue
        seen.add(url)
        after = content[m.end() : m.end() + 1500]
        desc = next((ln.strip() for ln in after.split("\n") if ln.strip() and not ln.lstrip().startswith(("[", "#", "!"))), "")
        out.append({"url": url, "title": m.group(1)[:200], "description": re.sub(r"[*_]", "", desc)[:400]})
        if len(out) >= limit:
            break
    return out


def strip_tags(html: str) -> str:
    import html as _html
    import re

    links = re.findall(r'href="(https?://[^"]+)"', html)
    text = re.sub(r"(?is)<(script|style|noscript)[^>]*>.*?</\1>", " ", html)
    text = re.sub(r"(?s)<[^>]+>", " ", text)
    text = re.sub(r"[ \t]+", " ", _html.unescape(text))
    text = re.sub(r"\n\s*\n+", "\n", text)
    return text.strip()[:60_000] + "\n" + "\n".join(links[:300])


class Web:
    """search(query) -> [{url, title, description}]; read(url) -> page text + its links."""

    def __init__(self, firecrawl_key: str | None = None, jina_key: str | None = None) -> None:
        self.firecrawl_key = firecrawl_key
        self.jina_key = jina_key
        self.calls = 0
        self.used: dict[str, int] = {}
        self.firecrawl_refused: str | None = None  # "key_invalid" | "out_of_credits"
        self.blocked: set[str] = set()  # keyless engines that refused this job
        self.working: str | None = None  # the keyless engine that last answered

    def _count(self, provider: str) -> None:
        self.calls += 1
        self.used[provider] = self.used.get(provider, 0) + 1

    def _firecrawl(self, path: str, body: dict[str, Any]) -> dict[str, Any] | None:
        if not self.firecrawl_key or self.firecrawl_refused:
            return None
        self._count("firecrawl")
        status, text = _http(f"{FIRECRAWL_URL}{path}", json.dumps(body).encode(), {"Authorization": f"Bearer {self.firecrawl_key}", "Content-Type": "application/json"}, 60)
        if status == 401:
            self.firecrawl_refused = "key_invalid"
            log("web.firecrawl_refused", status=401)
            return None
        if status == 402:
            self.firecrawl_refused = "out_of_credits"
            log("web.firecrawl_refused", status=402)
            return None
        if status != 200:
            log("web.firecrawl_error", status=status)
            return None
        try:
            return json.loads(text)
        except ValueError:
            return None

    def search(self, query: str, limit: int = 6) -> list[dict[str, str]]:
        fc = self._firecrawl("/search", {"query": query, "limit": limit})
        if fc and fc.get("data"):
            return [{"url": d.get("url", ""), "title": d.get("title", ""), "description": d.get("description", "")} for d in fc["data"] if d.get("url")][:limit]
        if self.jina_key:
            self._count("jina_search")
            status, text = _http(f"{JINA_SEARCH_URL}?q={urllib.parse.quote(query)}", None, {"Accept": "application/json", "Authorization": f"Bearer {self.jina_key}"})
            if status == 200:
                try:
                    data = json.loads(text).get("data") or []
                    rows = [{"url": d.get("url", ""), "title": d.get("title", ""), "description": d.get("description", "")} for d in data if d.get("url")]
                    if rows:
                        return rows[:limit]
                except ValueError:
                    pass
            log("web.jina_search_skipped", status=status)
        return self._free_search(query, limit)

    def _free_search(self, query: str, limit: int) -> list[dict[str, str]]:
        """The keyless engines, first-that-answers first; an engine that refuses is skipped from then on."""
        q = urllib.parse.quote_plus(query)
        order = sorted((e for e in FREE_SEARCH if e not in self.blocked), key=lambda e: e != self.working)
        for engine in order:
            self._count(engine)
            if engine == "duckduckgo":
                status, body = _http(f"{DDG_HTML_URL}?q={q}")
                rows = parse_ddg_html(body, limit) if status == 200 else []
            elif engine == "duckduckgo_lite":
                status, body = _http(f"{DDG_LITE_URL}?q={q}")
                rows = parse_ddg_lite(body, limit) if status == 200 else []
            else:
                status, body = _http(f"{JINA_READ_URL}{DDG_HTML_URL}?q={q}", None, {"Accept": "application/json", **({"Authorization": f"Bearer {self.jina_key}"} if self.jina_key else {})}, 60)
                if status == 429:
                    time.sleep(4)
                    status, body = _http(f"{JINA_READ_URL}{DDG_HTML_URL}?q={q}", None, {"Accept": "application/json"}, 60)
                rows = parse_jina_ddg(body, limit) if status == 200 else []
            if rows:
                self.working = engine
                return rows
            if status != 200:
                self.blocked.add(engine)
            log("web.search_empty", engine=engine, status=status)
        return []

    def read(self, url: str) -> str:
        fc = self._firecrawl("/scrape", {"url": url, "formats": ["markdown", "links"], "onlyMainContent": False})
        if fc and fc.get("data"):
            d = fc["data"]
            return (d.get("markdown") or "") + "\n" + "\n".join(str(x) for x in (d.get("links") or []))
        self._count("jina_read")
        status, text = _http(f"{JINA_READ_URL}{url}", None, {"Accept": "application/json", **({"Authorization": f"Bearer {self.jina_key}"} if self.jina_key else {})})
        if status == 200:
            try:
                d = json.loads(text).get("data") or {}
                content = d.get("content") or ""
                links = d.get("links") or {}
                link_list = list(links.values()) if isinstance(links, dict) else list(links)
                if content.strip():
                    return content + "\n" + "\n".join(str(x) for x in link_list)
            except ValueError:
                pass
        self._count("plain")
        status, html = _http(url)
        return strip_tags(html) if status == 200 and html else ""


@dataclass
class Job:
    id: str
    nonce: str
    worker_url: str
    secret: str
    run_id: str

    @classmethod
    def from_env(cls) -> "Job":
        missing = [k for k in ("JOB_ID", "JOB_NONCE", "WORKER_URL", "JOB_SHARED_SECRET") if not os.environ.get(k)]
        if missing:
            log("job.env.missing", count=len(missing))
            sys.exit(2)
        return cls(
            id=os.environ["JOB_ID"],
            nonce=os.environ["JOB_NONCE"],
            worker_url=os.environ["WORKER_URL"].rstrip("/"),
            secret=os.environ["JOB_SHARED_SECRET"],
            run_id=os.environ.get("RUN_ID", ""),
        )

    def _headers(self, signed: str, content_type: str = "application/json") -> dict[str, str]:
        ts = str(int(time.time()))
        sig = hmac.new(self.secret.encode(), f"{ts}.{signed}".encode(), hashlib.sha256).hexdigest()
        return {
            "Content-Type": content_type,
            "X-Job-Timestamp": ts,
            "X-Job-Signature": sig,
            "X-Job-Nonce": self.nonce,
            "X-Job-Run-Id": self.run_id,
            "User-Agent": "creator-studios-job",
        }

    def _url(self, path: str) -> str:
        return f"{self.worker_url}/api/jobs/{self.id}{path}"

    def _signed_line(self, method: str, url: str) -> str:
        """What the Worker verifies for a request with no JSON body: the path + query as sent."""
        u = urllib.parse.urlsplit(url)
        line = u.path + (f"?{u.query}" if u.query else "")
        return line if method == "GET" else f"{method} {line}"

    def _call(self, method: str, path: str, body: str | None) -> Any:
        url = self._url(path)
        for attempt in range(4):
            # Signed per attempt: a retry after a long back-off still carries a fresh timestamp.
            req = urllib.request.Request(url, method=method, data=body.encode() if body else None, headers=self._headers(body if body is not None else f"spec:{self.id}"))
            try:
                with urllib.request.urlopen(req, timeout=60) as res:
                    return json.loads(res.read().decode() or "{}")
            except urllib.error.HTTPError as e:
                if e.code in (400, 401, 403, 404, 409, 422):
                    log("worker.call.rejected", status=e.code)
                    raise
                log("worker.call.retry", status=e.code, attempt=attempt)
            except (urllib.error.URLError, TimeoutError):
                log("worker.call.retry", attempt=attempt)
            time.sleep(2 ** attempt)
        raise RuntimeError("worker unreachable")

    # ---------- storage, through the Worker ----------

    def input_url(self, key: str) -> str:
        return self._url("/input/" + urllib.parse.quote(key, safe="/"))

    def download_input(self, key: str, dest: Path) -> Path:
        """Stream one input file to dest; a dropped connection resumes with a Range request."""
        dest.parent.mkdir(parents=True, exist_ok=True)
        url = self.input_url(key)
        have = 0
        dest.write_bytes(b"")
        for attempt in range(5):
            headers = self._headers(self._signed_line("GET", url))
            if have:
                headers["Range"] = f"bytes={have}-"
            req = urllib.request.Request(url, method="GET", headers=headers)
            try:
                with urllib.request.urlopen(req, timeout=120) as res, dest.open("ab" if have else "wb") as f:
                    if have and res.status != 206:
                        f.truncate(0)
                        have = 0
                    while True:
                        chunk = res.read(1024 * 1024)
                        if not chunk:
                            break
                        f.write(chunk)
                        have += len(chunk)
                log("storage.download", ok=True, bytes=have)
                return dest
            except urllib.error.HTTPError as e:
                if e.code in (400, 401, 403, 404, 409, 416, 422):
                    log("storage.download.rejected", status=e.code)
                    raise
                log("storage.download.retry", status=e.code, attempt=attempt)
            except (urllib.error.URLError, TimeoutError, ConnectionError):
                log("storage.download.retry", attempt=attempt)
            time.sleep(2 ** attempt)
        raise RuntimeError("download failed")

    def read_input_bytes(self, key: str) -> bytes:
        tmp = WORK / "inputs" / hashlib.sha256(key.encode()).hexdigest()[:16]
        try:
            return self.download_input(key, tmp).read_bytes()
        finally:
            tmp.unlink(missing_ok=True)

    def upload_output(self, src: Path, key: str, content_type: str) -> None:
        """Write src to key in pieces through the Worker (the same protocol the browser uses)."""
        started = self._call("POST", "/output/start", json.dumps({"key": key, "contentType": content_type}))
        upload_id = started["uploadId"]
        part_size = int(started.get("partSize") or 10 * 1024 * 1024)
        parts: list[dict[str, Any]] = []
        try:
            with src.open("rb") as f:
                n = 0
                while True:
                    chunk = f.read(part_size)
                    if not chunk and n > 0:
                        break
                    n += 1
                    parts.append(self._put_part(key, upload_id, n, chunk))
                    if len(chunk) < part_size:
                        break
            self._call("POST", "/output/complete", json.dumps({"key": key, "uploadId": upload_id, "parts": parts}))
            log("storage.upload", ok=True, parts=len(parts), bytes=src.stat().st_size)
        except Exception:
            try:
                self._call("POST", "/output/abort", json.dumps({"key": key, "uploadId": upload_id}))
            except Exception:  # noqa: BLE001
                pass
            log("storage.upload", ok=False)
            raise

    def write_output_bytes(self, data: bytes, key: str, content_type: str) -> None:
        tmp = WORK / "outputs" / hashlib.sha256(key.encode()).hexdigest()[:16]
        tmp.parent.mkdir(parents=True, exist_ok=True)
        tmp.write_bytes(data)
        try:
            self.upload_output(tmp, key, content_type)
        finally:
            tmp.unlink(missing_ok=True)

    def _put_part(self, key: str, upload_id: str, n: int, chunk: bytes) -> dict[str, Any]:
        url = self._url(f"/output/parts/{n}?" + urllib.parse.urlencode({"key": key, "uploadId": upload_id}))
        for attempt in range(4):
            req = urllib.request.Request(url, method="PUT", data=chunk, headers=self._headers(self._signed_line("PUT", url), "application/octet-stream"))
            try:
                with urllib.request.urlopen(req, timeout=300) as res:
                    got = json.loads(res.read().decode() or "{}")
                    return {"partNumber": int(got["partNumber"]), "etag": str(got["etag"])}
            except urllib.error.HTTPError as e:
                if e.code in (400, 401, 403, 404, 409, 422):
                    log("storage.part.rejected", status=e.code)
                    raise
                log("storage.part.retry", status=e.code, attempt=attempt)
            except (urllib.error.URLError, TimeoutError, ConnectionError):
                log("storage.part.retry", attempt=attempt)
            time.sleep(2 ** attempt)
        raise RuntimeError("upload failed")

    def spec(self) -> dict[str, Any]:
        return self._call("GET", "/spec", None)

    def progress(self, step: str, done: int, total: int) -> None:
        try:
            self._call("POST", "/progress", json.dumps({"step": step, "done": done, "total": total}))
        except Exception:
            log("progress.skipped")

    def done(self, result: dict[str, Any]) -> None:
        self._call("POST", "/callback", json.dumps({"ok": True, "result": result}))
        log("job.done")

    def fail(self, safe_error: str, **why: Any) -> None:
        try:
            self._call("POST", "/callback", json.dumps({"ok": False, "safe_error": safe_error[:160]}))
        finally:
            log("job.failed", **why)


# ---------- storage (module-level, for the jobs' existing call sites) ----------

_CURRENT: Job | None = None


def download_input(key: str, dest: Path) -> Path:
    if _CURRENT is None:
        raise RuntimeError("no job")
    return _CURRENT.download_input(key, dest)


def upload_output(src: Path, key: str, content_type: str) -> None:
    if _CURRENT is None:
        raise RuntimeError("no job")
    _CURRENT.upload_output(src, key, content_type)


def run(main) -> None:
    """Wrap a job's main(job, spec) so every failure reaches the Worker as a safe summary."""
    global _CURRENT
    job = Job.from_env()
    _CURRENT = job
    log("job.start")
    spec: Any = None
    try:
        spec = job.spec()
        result = main(job, spec)
        job.done(result)
    except SystemExit:
        raise
    except Exception as e:  # noqa: BLE001
        why = failure_fields(e, spec)
        job.fail(f"{why['error']} at {why['where']}", **why)
        sys.exit(1)
