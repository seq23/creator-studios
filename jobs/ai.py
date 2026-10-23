"""The model ladder every studio-intelligence call goes through (quota fix, 23 Oct 2026).

Why: the OpenRouter key is on the free tier, 50 requests a day for the whole account, shared by the
cut, critic and golden jobs of every host studio. One dump used ~45 of them (one picture per video,
one critic call per clip, up to six retries per failure), so the golden set at 0e0eebb found every
model answering 429 and failed. $0 only: no credits are bought, no account is made, the key's limit
is never changed.

Two providers, both $0:
  1. OpenRouter free models (`:free` / openrouter/free), at most OPENROUTER_JOB_BUDGET calls per job.
     A 429 that says the DAILY free quota is used trips the breaker at once (no more calls this job);
     any other 429 tries one more model, and a whole round of 429s also trips it.
  2. A local open vision model on the runner's CPU (Qwen2-VL-2B-Instruct, Apache-2.0), where
     VISION_LOCAL=1 (the cut job and the golden set). No token, no account, no quota: it only costs
     runner minutes, which are free on this public repo. Used for shot sheets when OpenRouter is out.
Checked and ruled out on 23 Oct 2026: Cloudflare Workers AI (the account's included 10k neurons a day
were already used, 9.85k, by other Workers; any more is billed), Hugging Face Inference Providers (the
account's monthly credits are used up and it cannot pay, so every call is refused), GitHub Models (the
endpoint no longer answers).

Every call is counted per provider (CALLS_BY) and the job logs and returns the counts.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
import urllib.error
from pathlib import Path
from typing import Any, Callable

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import json_object_in, log, openrouter_content  # noqa: E402

# A dump of ~9 videos and ~12 clips needs about 11 (3 batched shot-sheet calls, 1 copy call, 3 batched
# critic calls, up to 4 for re-cuts): 16 leaves headroom while keeping 3 dumps a day inside 50.
OPENROUTER_JOB_BUDGET = int(os.environ.get("OPENROUTER_JOB_BUDGET", "16"))
LOCAL_VLM = os.environ.get("LOCAL_VLM_MODEL", "Qwen/Qwen2-VL-2B-Instruct")
# About 1,000 picture tokens: a grid stays readable and a CPU answer takes a minute or two.
LOCAL_MAX_PIXELS = 1024 * 28 * 28
LOCAL_MAX_NEW_TOKENS = 1100
# Its own cache folder (the workflows keep it between runs with actions/cache, key vlm-<model>).
VLM_CACHE = os.environ.get("VLM_CACHE", str(Path.home() / ".cache" / "vlm"))

CALLS_BY: dict[str, int] = {"openrouter": 0, "openrouter_failed": 0, "local_vlm": 0, "local_vlm_failed": 0}
STATE = {"quota_out": False}


def reset() -> None:
    for k in CALLS_BY:
        CALLS_BY[k] = 0
    STATE["quota_out"] = False


def openrouter_left() -> int:
    return max(0, OPENROUTER_JOB_BUDGET - CALLS_BY["openrouter"])


def daily_quota_message(body: str) -> bool:
    """OpenRouter's 429 for the used-up free daily quota (as opposed to a busy model)."""
    b = (body or "").lower()
    return "per-day" in b or "per day" in b or "free-models-per-day" in b


def _error_code(e: Exception) -> Any:
    code = getattr(e, "code", None)
    return code if isinstance(code, int) else type(e).__name__


def ask_openrouter(key: str | None, payload_for: Callable[[str], dict[str, Any]], models: list[str], kind: str, usable: Any = json_object_in, timeout: float = 150, ask: Any = None) -> tuple[str | None, str]:
    """One answer from the first of `models` that gives one, within the job's budget.
    Returns (text, model) or (None, "")."""
    ask = ask or openrouter_content
    if not key or STATE["quota_out"]:
        return None, ""
    codes: list[Any] = []
    for model in models[:2]:
        if openrouter_left() <= 0:
            log("ai.budget_used", provider="openrouter", kind=kind, budget=OPENROUTER_JOB_BUDGET)
            return None, ""
        CALLS_BY["openrouter"] += 1
        try:
            content, _raw = ask(key, payload_for(model), timeout=timeout, usable=usable)
            if usable and not usable(content or ""):
                raise ValueError("no json")
            return content, model
        except Exception as e:  # noqa: BLE001
            CALLS_BY["openrouter_failed"] += 1
            code = _error_code(e)
            codes.append(code)
            body = ""
            if isinstance(e, urllib.error.HTTPError):
                try:
                    body = e.read().decode("utf-8", "replace")[:400] if e.fp else ""
                except Exception:  # noqa: BLE001
                    body = ""
            log("ai.call", provider="openrouter", kind=kind, ok=False, code=code)
            if code == 429 and daily_quota_message(body):
                STATE["quota_out"] = True
                log("ai.quota_out", provider="openrouter", kind=kind, why="daily")
                return None, ""
            time.sleep(2)
    if codes and all(c == 429 for c in codes):
        STATE["quota_out"] = True
        log("ai.quota_out", provider="openrouter", kind=kind, why="every_model_busy")
    return None, ""


# ---------------------------------------------------------------- the local vision model

_VLM: dict[str, Any] = {}


def _local_vlm() -> Any:
    """(model, processor) or None. Installed and loaded once per job, only where VISION_LOCAL=1."""
    if "ready" in _VLM:
        return _VLM["ready"]
    _VLM["ready"] = None
    if os.environ.get("VISION_LOCAL") != "1":
        return None
    pip = [sys.executable, "-m", "pip", "install", "-q", "--disable-pip-version-check"]
    try:
        # torchvision too: the Qwen2-VL image processor imports it (23 Oct 2026 run: ImportError without it).
        try:
            __import__("torch")
            __import__("torchvision")
        except Exception:  # noqa: BLE001
            subprocess.run([*pip, "torch", "torchvision", "--index-url", "https://download.pytorch.org/whl/cpu"], capture_output=True, timeout=900, check=True)
        subprocess.run([*pip, "transformers>=4.45,<5", "pillow", "accelerate"], capture_output=True, timeout=600, check=True)
        import importlib

        importlib.invalidate_caches()
        import torch  # type: ignore
        from transformers import AutoProcessor, Qwen2VLForConditionalGeneration  # type: ignore

        torch.set_num_threads(max(1, os.cpu_count() or 2))
        model = Qwen2VLForConditionalGeneration.from_pretrained(LOCAL_VLM, torch_dtype=torch.float32, device_map="cpu", cache_dir=VLM_CACHE)
        proc = AutoProcessor.from_pretrained(LOCAL_VLM, cache_dir=VLM_CACHE, min_pixels=256 * 28 * 28, max_pixels=LOCAL_MAX_PIXELS)
        _VLM["ready"] = (model, proc)
        log("ai.local_ready", provider="local_vlm", ok=True)
    except Exception as e:  # noqa: BLE001
        log("ai.local_ready", provider="local_vlm", ok=False, error=type(e).__name__, detail=str(e)[:160])
    return _VLM["ready"]


def ask_local_vlm(system: str, text: str, image: Path, kind: str, max_tokens: int = 900) -> str | None:
    vlm = _local_vlm()
    if vlm is None or not image or not image.exists():
        return None
    model, proc = vlm
    CALLS_BY["local_vlm"] += 1
    t0 = time.time()
    try:
        import torch  # type: ignore
        from PIL import Image  # type: ignore

        img = Image.open(image).convert("RGB")
        messages = [
            {"role": "system", "content": [{"type": "text", "text": system}]},
            {"role": "user", "content": [{"type": "image"}, {"type": "text", "text": text}]},
        ]
        prompt = proc.apply_chat_template(messages, add_generation_prompt=True)
        inputs = proc(text=[prompt], images=[img], return_tensors="pt")
        with torch.inference_mode():
            out = model.generate(**inputs, max_new_tokens=min(max_tokens, LOCAL_MAX_NEW_TOKENS), do_sample=False)
        answer = proc.batch_decode(out[:, inputs["input_ids"].shape[1]:], skip_special_tokens=True)[0]
        log("ai.call", provider="local_vlm", kind=kind, ok=True, seconds=round(time.time() - t0, 1))
        return answer
    except Exception as e:  # noqa: BLE001
        CALLS_BY["local_vlm_failed"] += 1
        log("ai.call", provider="local_vlm", kind=kind, ok=False, error=type(e).__name__)
        return None


def first_json(text: str | None) -> dict[str, Any] | None:
    m = re.search(r"\{.*\}", text or "", re.S)
    if not m:
        return None
    try:
        v = json.loads(m.group(0))
    except ValueError:
        return None
    return v if isinstance(v, dict) else None


def report() -> dict[str, int]:
    """Calls per provider this job (logged at the end, returned with the result)."""
    return dict(CALLS_BY)
