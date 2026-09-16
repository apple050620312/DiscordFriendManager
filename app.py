from __future__ import annotations

import argparse
import asyncio
import json
import os
import secrets
import sys
import threading
import time
import uuid
import webbrowser
from contextlib import contextmanager
from datetime import UTC, datetime
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Iterator

import discord
from discord.enums import RelationshipAction
from dotenv import dotenv_values


ROOT = Path(__file__).resolve().parent
STATIC_DIR = ROOT / "static"
CACHE_DIR = ROOT / "cache"
CACHE_PATH = CACHE_DIR / "relationships.json"
MESSAGE_SCAN_PATH = CACHE_DIR / "message_scan.json"
OPERATIONS_PATH = CACHE_DIR / "operations.json"
LOCK_PATH = CACHE_DIR / "fetch.lock"
CACHE_VERSION = 1
MESSAGE_SCAN_VERSION = 1
OPERATIONS_VERSION = 1
DISCORD_EPOCH_MS = 1_420_070_400_000
LOCK_STALE_SECONDS = 300

RELATIONSHIP_TYPES = {
    0: "none",
    1: "friend",
    2: "blocked",
    3: "incoming_request",
    4: "outgoing_request",
    5: "implicit",
    6: "suggestion",
}


class CacheError(RuntimeError):
    pass


def utc_now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def account_created_at(user_id: str) -> str | None:
    return snowflake_created_at(user_id)


def snowflake_created_at(snowflake_id: str | None) -> str | None:
    if not snowflake_id:
        return None
    try:
        timestamp_ms = (int(snowflake_id) >> 22) + DISCORD_EPOCH_MS
        return datetime.fromtimestamp(timestamp_ms / 1000, UTC).isoformat(timespec="seconds")
    except (ValueError, OSError, OverflowError):
        return None


def avatar_url(user_id: str, avatar_hash: str | None) -> str | None:
    if not avatar_hash:
        return None
    extension = "gif" if avatar_hash.startswith("a_") else "webp"
    return f"https://cdn.discordapp.com/avatars/{user_id}/{avatar_hash}.{extension}?size=64"


def _guild_tag(user: dict[str, Any]) -> str | None:
    guild = user.get("primary_guild") or user.get("clan") or {}
    if not isinstance(guild, dict):
        return None
    tag = guild.get("tag")
    return str(tag) if tag else None


def normalise_relationship(raw: dict[str, Any]) -> dict[str, Any]:
    user = raw.get("user") or {}
    user_id = str(user.get("id") or raw.get("id") or "")
    relation_type = int(raw.get("type", 0))
    username = str(user.get("username") or "")
    global_name = user.get("global_name")
    nickname = raw.get("nickname")

    return {
        "id": user_id,
        "type": relation_type,
        "type_name": RELATIONSHIP_TYPES.get(relation_type, "unknown"),
        "username": username,
        "global_name": str(global_name) if global_name else None,
        "display_name": str(nickname or global_name or username),
        "nickname": str(nickname) if nickname else None,
        "note": str(raw.get("note")) if raw.get("note") else None,
        "since": raw.get("since"),
        "account_created_at": account_created_at(user_id),
        "last_message_at": None,
        "avatar_url": avatar_url(user_id, user.get("avatar")),
        "public_flags": int(user.get("public_flags") or 0),
        "guild_tag": _guild_tag(user),
        "is_spam_request": bool(raw.get("is_spam_request", False)),
        "user_ignored": bool(raw.get("user_ignored", False)),
    }


def load_cache() -> dict[str, Any] | None:
    if not CACHE_PATH.exists():
        return None
    try:
        payload = json.loads(CACHE_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise CacheError(f"無法讀取快取：{exc}") from exc
    if payload.get("version") != CACHE_VERSION or not isinstance(payload.get("relationships"), list):
        raise CacheError("快取格式不相容；請明確執行 --clear-cache 後再啟動。")
    apply_message_scan_results(payload, load_message_scan())
    payload["source"] = "cache"
    return payload


def save_cache(relationships: list[dict[str, Any]]) -> dict[str, Any]:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    payload = {
        "version": CACHE_VERSION,
        "fetched_at": utc_now(),
        "source": "discord",
        "relationships": relationships,
    }
    write_cache(payload)
    return payload


def write_cache(payload: dict[str, Any]) -> None:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    temporary = CACHE_PATH.with_suffix(".tmp")
    temporary.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    os.replace(temporary, CACHE_PATH)


def load_message_scan() -> dict[str, str | None]:
    if not MESSAGE_SCAN_PATH.exists():
        return {}
    try:
        payload = json.loads(MESSAGE_SCAN_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise CacheError(f"無法讀取訊息時間掃描快取：{exc}") from exc
    if payload.get("version") != MESSAGE_SCAN_VERSION or not isinstance(payload.get("results"), dict):
        raise CacheError("訊息時間掃描快取格式不相容；請明確清除快取後再啟動。")
    return payload["results"]


def write_message_scan(results: dict[str, str | None]) -> None:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    payload = {
        "version": MESSAGE_SCAN_VERSION,
        "updated_at": utc_now(),
        "results": results,
    }
    temporary = MESSAGE_SCAN_PATH.with_suffix(".tmp")
    temporary.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    os.replace(temporary, MESSAGE_SCAN_PATH)


def apply_message_scan_results(
    payload: dict[str, Any], results: dict[str, str | None]
) -> None:
    for relationship in payload["relationships"]:
        user_id = relationship["id"]
        if user_id in results:
            relationship["last_message_at"] = results[user_id]
            relationship["last_message_checked"] = True
        else:
            relationship["last_message_checked"] = bool(relationship.get("last_message_at"))


def load_operations() -> list[dict[str, Any]]:
    if not OPERATIONS_PATH.exists():
        return []
    try:
        payload = json.loads(OPERATIONS_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise CacheError(f"無法讀取操作紀錄：{exc}") from exc
    if payload.get("version") != OPERATIONS_VERSION or not isinstance(payload.get("operations"), list):
        raise CacheError("操作紀錄格式不相容。")
    return payload["operations"]


def write_operations(operations: list[dict[str, Any]]) -> None:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    payload = {
        "version": OPERATIONS_VERSION,
        "updated_at": utc_now(),
        "operations": operations,
    }
    temporary = OPERATIONS_PATH.with_suffix(".tmp")
    temporary.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    os.replace(temporary, OPERATIONS_PATH)


def user_snapshot(user: dict[str, Any]) -> dict[str, Any]:
    user_id = str(user.get("id") or "")
    username = str(user.get("username") or "")
    global_name = user.get("global_name")
    return {
        "id": user_id,
        "username": username,
        "global_name": str(global_name) if global_name else None,
        "display_name": str(global_name or username or user_id),
        "avatar_url": avatar_url(user_id, user.get("avatar")),
        "public_flags": int(user.get("public_flags") or 0),
    }


def relationship_user_snapshot(relationship: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": relationship["id"],
        "username": relationship.get("username") or "",
        "global_name": relationship.get("global_name"),
        "display_name": relationship.get("display_name") or relationship.get("username") or relationship["id"],
        "avatar_url": relationship.get("avatar_url"),
        "public_flags": int(relationship.get("public_flags") or 0),
    }


@contextmanager
def fetch_lock() -> Iterator[None]:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    try:
        descriptor = os.open(LOCK_PATH, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError as exc:
        try:
            age = time.time() - LOCK_PATH.stat().st_mtime
        except OSError:
            age = 0
        if age > LOCK_STALE_SECONDS:
            raise CacheError(
                "偵測到逾時的抓取鎖。請確認沒有其他執行個體後，執行 --clear-cache。"
            ) from exc
        raise CacheError("另一個執行個體正在取得資料，請稍後重新啟動。") from exc

    try:
        os.write(descriptor, str(os.getpid()).encode("ascii"))
        os.close(descriptor)
        yield
    finally:
        LOCK_PATH.unlink(missing_ok=True)


def read_token() -> str:
    token = str(dotenv_values(ROOT / ".env").get("TOKEN") or "").strip()
    if not token:
        raise RuntimeError(".env 中缺少 TOKEN，或 TOKEN 為空。")
    return token


async def fetch_discord_snapshot(
    token: str,
) -> tuple[list[dict[str, Any]], dict[str, str]]:
    # discord.py-self's HTTP client serialises requests and honours Discord's
    # bucket limits, X-RateLimit headers, and Retry-After values on 429s.
    client = discord.Client(max_ratelimit_timeout=None)
    try:
        await client.login(token)
        raw_items = await client.http.get_relationships()
        channels = await client.http.get_private_channels()
        relationships = [normalise_relationship(item) for item in raw_items]
        return relationships, private_channel_activity(channels)
    finally:
        await client.close()


def private_channel_activity(channels: list[dict[str, Any]]) -> dict[str, str]:
    activity: dict[str, str] = {}
    for channel in channels:
        if int(channel.get("type", 0)) != 1:
            continue
        recipients = channel.get("recipients") or []
        if len(recipients) != 1:
            continue
        recipient_id = str(recipients[0].get("id") or "")
        timestamp = snowflake_created_at(str(channel.get("last_message_id") or ""))
        if recipient_id and timestamp and timestamp > activity.get(recipient_id, ""):
            activity[recipient_id] = timestamp
    return activity


async def fetch_private_activity(token: str) -> dict[str, str]:
    client = discord.Client(max_ratelimit_timeout=None)
    try:
        await client.login(token)
        channels = await client.http.get_private_channels()
        return private_channel_activity(channels)
    finally:
        await client.close()


def enrich_private_activity(payload: dict[str, Any]) -> dict[str, Any]:
    if payload.get("dm_activity_fetched_at"):
        return payload

    activity = asyncio.run(fetch_private_activity(read_token()))
    return apply_private_activity(payload, activity)


def apply_private_activity(
    payload: dict[str, Any], activity: dict[str, str]
) -> dict[str, Any]:
    for relationship in payload["relationships"]:
        relationship["last_message_at"] = activity.get(relationship["id"])
    payload["dm_activity_fetched_at"] = utc_now()
    write_cache(payload)
    return payload


class DiscordService:
    """Runs one lazy Discord client so deletion requests share rate-limit state."""

    def __init__(self) -> None:
        self._loop = asyncio.new_event_loop()
        self._thread = threading.Thread(target=self._run_loop, name="discord-http", daemon=True)
        self._thread.start()
        self._client: discord.Client | None = None
        self._async_lock: asyncio.Lock | None = None

    def _run_loop(self) -> None:
        asyncio.set_event_loop(self._loop)
        self._loop.run_forever()

    async def _ensure_client(self) -> discord.Client:
        if self._client is None:
            client = discord.Client(max_ratelimit_timeout=None)
            await client.login(read_token())
            self._client = client
        return self._client

    async def _remove_friend(self, user_id: int) -> None:
        if self._async_lock is None:
            self._async_lock = asyncio.Lock()
        async with self._async_lock:
            client = await self._ensure_client()
            await client.http.remove_relationship(user_id, action=RelationshipAction.unfriend)

    def remove_friend(self, user_id: str) -> None:
        if not user_id.isdecimal():
            raise ValueError("無效的 Discord 使用者 ID。")
        future = asyncio.run_coroutine_threadsafe(self._remove_friend(int(user_id)), self._loop)
        future.result(timeout=600)

    async def _fetch_last_message_at(self, user_id: int) -> str | None:
        if self._async_lock is None:
            self._async_lock = asyncio.Lock()
        async with self._async_lock:
            client = await self._ensure_client()
            channel = await client.http.start_private_message(user_id)
            return snowflake_created_at(str(channel.get("last_message_id") or ""))

    def fetch_last_message_at(self, user_id: str) -> str | None:
        if not user_id.isdecimal():
            raise ValueError("無效的 Discord 使用者 ID。")
        future = asyncio.run_coroutine_threadsafe(
            self._fetch_last_message_at(int(user_id)), self._loop
        )
        return future.result(timeout=600)

    async def _fetch_user(self, user_id: int) -> dict[str, Any]:
        if self._async_lock is None:
            self._async_lock = asyncio.Lock()
        async with self._async_lock:
            client = await self._ensure_client()
            return await client.http.get_user(user_id)

    def fetch_user(self, user_id: str) -> dict[str, Any]:
        if not user_id.isdecimal():
            raise ValueError("無效的 Discord 使用者 ID。")
        future = asyncio.run_coroutine_threadsafe(self._fetch_user(int(user_id)), self._loop)
        return future.result(timeout=600)

    async def _send_friend_request(self, user_id: int) -> None:
        if self._async_lock is None:
            self._async_lock = asyncio.Lock()
        async with self._async_lock:
            client = await self._ensure_client()
            await client.http.add_relationship(
                user_id,
                action=RelationshipAction.send_friend_request,
            )

    def send_friend_request(self, user_id: str) -> None:
        if not user_id.isdecimal():
            raise ValueError("無效的 Discord 使用者 ID。")
        future = asyncio.run_coroutine_threadsafe(
            self._send_friend_request(int(user_id)), self._loop
        )
        future.result(timeout=600)

    async def _close(self) -> None:
        if self._client is not None:
            await self._client.close()

    def close(self) -> None:
        if not self._thread.is_alive():
            return
        future = asyncio.run_coroutine_threadsafe(self._close(), self._loop)
        try:
            future.result(timeout=10)
        finally:
            self._loop.call_soon_threadsafe(self._loop.stop)
            self._thread.join(timeout=10)


def get_data() -> dict[str, Any]:
    cached = load_cache()
    if cached is not None and cached.get("dm_activity_fetched_at"):
        return cached

    with fetch_lock():
        # Recheck after acquiring the lock in case another process just filled it.
        cached = load_cache()
        if cached is not None:
            return enrich_private_activity(cached)
        token = read_token()
        relationships, activity = asyncio.run(fetch_discord_snapshot(token))
        payload = save_cache(relationships)
        payload = apply_private_activity(payload, activity)
        token = ""
        return payload


def clear_cache() -> bool:
    removed = False
    for path in (
        CACHE_PATH,
        CACHE_PATH.with_suffix(".tmp"),
        MESSAGE_SCAN_PATH,
        MESSAGE_SCAN_PATH.with_suffix(".tmp"),
        LOCK_PATH,
    ):
        if path.exists():
            path.unlink()
            removed = True
    try:
        CACHE_DIR.rmdir()
    except OSError:
        pass
    return removed


class DashboardHandler(SimpleHTTPRequestHandler):
    server_version = "DiscordFriendAnalyze/1.0"

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, directory=str(STATIC_DIR), **kwargs)

    @property
    def dashboard_server(self) -> "DashboardServer":
        return self.server  # type: ignore[return-value]

    def log_message(self, format: str, *args: Any) -> None:
        if self.path.startswith("/api/") and args and str(args[1]) != "200":
            super().log_message(format, *args)

    def _json(self, payload: Any, status: HTTPStatus = HTTPStatus.OK) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if self.path == "/api/relationships":
            self._json(self.dashboard_server.payload)
            return
        if self.path == "/api/status":
            data = self.dashboard_server.payload
            self._json(
                {
                    "source": data["source"],
                    "fetched_at": data["fetched_at"],
                    "count": len(data["relationships"]),
                    "csrf_token": self.dashboard_server.csrf_token,
                }
            )
            return
        if self.path == "/api/message-scan":
            self._json(self.dashboard_server.message_scan_status())
            return
        if self.path == "/api/operations":
            self._json(self.dashboard_server.operations_payload())
            return
        super().do_GET()

    def do_POST(self) -> None:
        supplied = self.headers.get("X-CSRF-Token", "")
        if not secrets.compare_digest(supplied, self.dashboard_server.csrf_token):
            self._json({"error": "拒絕未授權的本機請求。"}, HTTPStatus.FORBIDDEN)
            return
        if self.path == "/api/message-scan":
            self._json(self.dashboard_server.start_message_scan(), HTTPStatus.ACCEPTED)
            return
        if self.path.startswith("/api/operations/") and self.path.endswith("/readd"):
            operation_id = self.path.removeprefix("/api/operations/").removesuffix("/readd")
            try:
                operation = self.dashboard_server.readd_friend(operation_id)
            except ValueError as exc:
                self._json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
                return
            except TimeoutError:
                self._json(
                    {"error": "Discord 回應逾時；請先確認好友邀請狀態再重試。"},
                    HTTPStatus.GATEWAY_TIMEOUT,
                )
                return
            except discord.HTTPException as exc:
                self._json(
                    {"error": f"Discord 拒絕好友邀請（HTTP {exc.status}）。"},
                    HTTPStatus.BAD_GATEWAY,
                )
                return
            except (OSError, RuntimeError) as exc:
                self._json({"error": f"送出好友邀請失敗：{exc}"}, HTTPStatus.BAD_GATEWAY)
                return
            self._json({"operation": operation}, HTTPStatus.ACCEPTED)
            return
        self.send_error(HTTPStatus.NOT_FOUND)

    def do_DELETE(self) -> None:
        supplied = self.headers.get("X-CSRF-Token", "")
        if not secrets.compare_digest(supplied, self.dashboard_server.csrf_token):
            self._json({"error": "拒絕未授權的本機請求。"}, HTTPStatus.FORBIDDEN)
            return

        if self.path.startswith("/api/relationships/"):
            user_id = self.path.removeprefix("/api/relationships/")
            try:
                removed = self.dashboard_server.remove_friend(user_id)
            except ValueError as exc:
                self._json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
                return
            except TimeoutError:
                self._json(
                    {"error": "Discord 回應逾時；請先在 Discord 確認好友狀態再重試。"},
                    HTTPStatus.GATEWAY_TIMEOUT,
                )
                return
            except discord.HTTPException as exc:
                self._json(
                    {"error": f"Discord 拒絕刪除請求（HTTP {exc.status}）。"},
                    HTTPStatus.BAD_GATEWAY,
                )
                return
            except (OSError, RuntimeError) as exc:
                self._json({"error": f"刪除失敗：{exc}"}, HTTPStatus.BAD_GATEWAY)
                return
            self._json({"removed": removed, "id": user_id})
            return

        if self.path == "/api/message-scan":
            self._json(self.dashboard_server.pause_message_scan())
            return

        if self.path != "/api/cache":
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        if self.dashboard_server.message_scan_active():
            self._json(
                {"error": "請先暫停最後訊息時間掃描，再清除快取。"},
                HTTPStatus.CONFLICT,
            )
            return
        removed = clear_cache()
        self._json(
            {
                "removed": removed,
                "message": "快取已清除。請停止並重新啟動程式，以重新向 Discord 取得資料。",
            }
        )


class DashboardServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address: tuple[str, int], payload: dict[str, Any]) -> None:
        super().__init__(address, DashboardHandler)
        self.payload = payload
        self.csrf_token = secrets.token_urlsafe(32)
        self.discord_service = DiscordService()
        self.data_lock = threading.RLock()
        self.message_scan_results = load_message_scan()
        self.operations = load_operations()
        self.message_scan_stop = threading.Event()
        self.message_scan_thread: threading.Thread | None = None
        self.message_scan_state = "idle"
        self.message_scan_error: str | None = None
        if self._message_scan_completed() == self._message_scan_total():
            self.message_scan_state = "complete"

    def operations_payload(self) -> dict[str, Any]:
        with self.data_lock:
            operations = sorted(
                self.operations,
                key=lambda item: item.get("occurred_at") or item.get("created_at") or "",
                reverse=True,
            )
            return {"operations": operations, "count": len(operations)}

    def _new_operation(
        self,
        action: str,
        user: dict[str, Any],
        *,
        source: str = "user_action",
        relationship: dict[str, Any] | None = None,
        linked_operation_id: str | None = None,
    ) -> dict[str, Any]:
        created_at = utc_now()
        return {
            "id": uuid.uuid4().hex,
            "action": action,
            "status": "pending",
            "source": source,
            "created_at": created_at,
            "occurred_at": created_at,
            "completed_at": None,
            "failed_at": None,
            "error": None,
            "linked_operation_id": linked_operation_id,
            "user": user,
            "relationship": relationship,
        }

    def recover_orphaned_removals(self) -> list[dict[str, Any]]:
        with self.data_lock:
            current_ids = {item["id"] for item in self.payload["relationships"]}
            logged_ids = {
                item.get("user", {}).get("id")
                for item in self.operations
                if item.get("action") == "remove_friend"
            }
            orphan_ids = sorted(
                user_id
                for user_id in self.message_scan_results
                if user_id not in current_ids and user_id not in logged_ids
            )

        if not orphan_ids:
            return []

        try:
            estimated_at = datetime.fromtimestamp(CACHE_PATH.stat().st_mtime, UTC).isoformat(
                timespec="seconds"
            )
        except OSError:
            estimated_at = utc_now()

        recovered: list[dict[str, Any]] = []
        for user_id in orphan_ids:
            recovery_error = None
            try:
                user = user_snapshot(self.discord_service.fetch_user(user_id))
            except (TimeoutError, discord.HTTPException, OSError, RuntimeError, ValueError) as exc:
                user = {
                    "id": user_id,
                    "username": "",
                    "global_name": None,
                    "display_name": user_id,
                    "avatar_url": None,
                    "public_flags": 0,
                }
                recovery_error = f"無法補取使用者資料：{exc}"

            operation = self._new_operation(
                "remove_friend",
                user,
                source="recovered_from_message_scan",
                relationship={
                    "id": user_id,
                    "type": 1,
                    "type_name": "friend",
                    "last_message_at": self.message_scan_results[user_id],
                },
            )
            operation.update(
                {
                    "status": "completed",
                    "occurred_at": estimated_at,
                    "completed_at": estimated_at,
                    "recovered_at": utc_now(),
                    "time_is_estimated": True,
                    "error": recovery_error,
                }
            )
            with self.data_lock:
                self.operations.append(operation)
                write_operations(self.operations)
            recovered.append(operation)
        return recovered

    def _message_scan_friends(self) -> list[dict[str, Any]]:
        return [
            item for item in self.payload["relationships"] if item["type_name"] == "friend"
        ]

    def _message_scan_total(self) -> int:
        return len(self._message_scan_friends())

    def _message_scan_completed(self) -> int:
        return sum(
            bool(item.get("last_message_checked"))
            for item in self._message_scan_friends()
        )

    def message_scan_status(self) -> dict[str, Any]:
        with self.data_lock:
            friends = self._message_scan_friends()
            total = len(friends)
            completed = sum(bool(item.get("last_message_checked")) for item in friends)
            with_time = sum(bool(item.get("last_message_at")) for item in friends)
            return {
                "status": self.message_scan_state,
                "total": total,
                "completed": completed,
                "remaining": total - completed,
                "with_time": with_time,
                "error": self.message_scan_error,
            }

    def message_scan_active(self) -> bool:
        return bool(self.message_scan_thread and self.message_scan_thread.is_alive())

    def start_message_scan(self) -> dict[str, Any]:
        with self.data_lock:
            if self.message_scan_active():
                return self.message_scan_status()
            if self._message_scan_completed() >= self._message_scan_total():
                self.message_scan_state = "complete"
                return self.message_scan_status()
            self.message_scan_stop.clear()
            self.message_scan_state = "scanning"
            self.message_scan_error = None
            self.message_scan_thread = threading.Thread(
                target=self._run_message_scan,
                name="message-time-scan",
                daemon=True,
            )
            self.message_scan_thread.start()
            return self.message_scan_status()

    def pause_message_scan(self) -> dict[str, Any]:
        with self.data_lock:
            if self.message_scan_active():
                self.message_scan_stop.set()
                self.message_scan_state = "pausing"
            return self.message_scan_status()

    def _run_message_scan(self) -> None:
        while not self.message_scan_stop.is_set():
            with self.data_lock:
                target = next(
                    (
                        item
                        for item in self._message_scan_friends()
                        if not item.get("last_message_checked")
                    ),
                    None,
                )
            if target is None:
                with self.data_lock:
                    self.message_scan_state = "complete"
                return

            try:
                timestamp = self.discord_service.fetch_last_message_at(target["id"])
            except TimeoutError:
                error = "Discord 回應逾時；可稍後繼續掃描。"
            except discord.HTTPException as exc:
                if exc.status in {400, 403, 404}:
                    with self.data_lock:
                        target["last_message_at"] = None
                        target["last_message_checked"] = True
                        self.message_scan_results[target["id"]] = None
                        write_message_scan(self.message_scan_results)
                    continue
                error = f"Discord 回傳 HTTP {exc.status}；掃描已暫停。"
            except (OSError, RuntimeError, ValueError) as exc:
                error = f"掃描失敗：{exc}"
            else:
                with self.data_lock:
                    target["last_message_at"] = timestamp
                    target["last_message_checked"] = True
                    self.message_scan_results[target["id"]] = timestamp
                    write_message_scan(self.message_scan_results)
                continue

            with self.data_lock:
                self.message_scan_error = error
                self.message_scan_state = "error"
            return

        with self.data_lock:
            self.message_scan_state = "paused"

    def remove_friend(self, user_id: str) -> bool:
        with self.data_lock:
            target = next(
                (item for item in self.payload["relationships"] if item["id"] == user_id),
                None,
            )
            if target is None:
                raise ValueError("這位使用者已不在目前資料中。")
            if target["type_name"] != "friend":
                raise ValueError("只能用此操作移除好友。")

            operation = self._new_operation(
                "remove_friend",
                relationship_user_snapshot(target),
                relationship=dict(target),
            )
            self.operations.append(operation)
            write_operations(self.operations)

        try:
            self.discord_service.remove_friend(user_id)
        except Exception as exc:
            with self.data_lock:
                operation["status"] = "failed"
                operation["failed_at"] = utc_now()
                operation["error"] = str(exc)
                write_operations(self.operations)
            raise

        with self.data_lock:
            before = len(self.payload["relationships"])
            self.payload["relationships"] = [
                item for item in self.payload["relationships"] if item["id"] != user_id
            ]
            removed = len(self.payload["relationships"]) != before
            if removed:
                operation["status"] = "completed"
                operation["completed_at"] = utc_now()
                write_operations(self.operations)
                self.payload["source"] = "cache"
                self.payload["local_updated_at"] = utc_now()
                write_cache(self.payload)
            return removed

    def readd_friend(self, operation_id: str) -> dict[str, Any]:
        with self.data_lock:
            removal = next(
                (item for item in self.operations if item["id"] == operation_id),
                None,
            )
            if removal is None or removal.get("action") != "remove_friend":
                raise ValueError("找不到可重新加回的刪除紀錄。")
            if removal.get("status") != "completed":
                raise ValueError("只有已完成的刪除紀錄可以重新加回。")
            user_id = removal["user"]["id"]
            current = next(
                (item for item in self.payload["relationships"] if item["id"] == user_id),
                None,
            )
            if current is not None:
                raise ValueError("這位使用者目前已有好友或邀請關係。")

            request_operation = self._new_operation(
                "send_friend_request",
                dict(removal["user"]),
                linked_operation_id=operation_id,
            )
            self.operations.append(request_operation)
            write_operations(self.operations)

        try:
            self.discord_service.send_friend_request(user_id)
        except Exception as exc:
            with self.data_lock:
                request_operation["status"] = "failed"
                request_operation["failed_at"] = utc_now()
                request_operation["error"] = str(exc)
                write_operations(self.operations)
            raise

        with self.data_lock:
            completed_at = utc_now()
            request_operation["status"] = "completed"
            request_operation["completed_at"] = completed_at
            removal["readd_requested_at"] = completed_at
            original = dict(removal.get("relationship") or {})
            original.update(
                {
                    "id": user_id,
                    "type": 4,
                    "type_name": "outgoing_request",
                    "username": removal["user"].get("username") or "",
                    "global_name": removal["user"].get("global_name"),
                    "display_name": removal["user"].get("display_name") or user_id,
                    "avatar_url": removal["user"].get("avatar_url"),
                    "public_flags": int(removal["user"].get("public_flags") or 0),
                    "since": None,
                    "nickname": None,
                    "note": None,
                }
            )
            self.payload["relationships"].append(original)
            write_operations(self.operations)
            write_cache(self.payload)
            return request_operation

    def server_close(self) -> None:
        self.message_scan_stop.set()
        if self.message_scan_thread and self.message_scan_thread.is_alive():
            self.message_scan_thread.join(timeout=15)
        self.discord_service.close()
        super().server_close()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="本機 Discord 好友排序儀表板")
    parser.add_argument("--host", default="127.0.0.1", help="監聽位址（預設只限本機）")
    parser.add_argument("--port", type=int, default=8765, help="監聽連接埠")
    parser.add_argument("--no-browser", action="store_true", help="不要自動開啟瀏覽器")
    parser.add_argument(
        "--clear-cache",
        action="store_true",
        help="明確清除本機好友快取後退出，不會立即重新請求",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.clear_cache:
        print("快取已清除。" if clear_cache() else "目前沒有快取。")
        return 0

    if args.host not in {"127.0.0.1", "localhost", "::1"}:
        print("錯誤：為保護好友資料，伺服器只允許綁定本機位址。", file=sys.stderr)
        return 2

    print("提醒：使用 user token 自動化可能違反 Discord 服務條款並帶來帳號風險。")
    try:
        payload = get_data()
    except (CacheError, RuntimeError, discord.DiscordException, OSError) as exc:
        print(f"無法啟動：{exc}", file=sys.stderr)
        return 1

    source_label = "本機快取" if payload["source"] == "cache" else "Discord（已建立快取）"
    print(f"已載入 {len(payload['relationships'])} 筆關係，來源：{source_label}")

    try:
        server = DashboardServer((args.host, args.port), payload)
    except (CacheError, OSError) as exc:
        print(f"無法啟動本機伺服器：{exc}", file=sys.stderr)
        return 1

    recovered = server.recover_orphaned_removals()
    if recovered:
        print(f"已從掃描快取復原 {len(recovered)} 筆先前的好友刪除紀錄。")

    url = f"http://127.0.0.1:{server.server_port}/"
    print(f"儀表板：{url}")
    if not args.no_browser:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止。")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
