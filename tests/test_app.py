import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import app


class RelationshipTests(unittest.TestCase):
    def test_normalise_relationship_uses_nickname_for_display_name(self) -> None:
        item = app.normalise_relationship(
            {
                "id": "175928847299117063",
                "type": 1,
                "nickname": "本機暱稱",
                "note": "老朋友",
                "since": "2024-01-02T03:04:05+00:00",
                "user": {
                    "id": "175928847299117063",
                    "username": "example",
                    "global_name": "全域名稱",
                    "avatar": "abc",
                    "public_flags": 512,
                    "primary_guild": {"tag": "TEST"},
                },
            }
        )

        self.assertEqual(item["display_name"], "本機暱稱")
        self.assertEqual(item["type_name"], "friend")
        self.assertEqual(item["guild_tag"], "TEST")
        self.assertEqual(item["account_created_at"], "2016-04-30T11:18:25+00:00")
        self.assertNotIn("token", item)

    def test_cache_round_trip_is_cache_first(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            cache_dir = Path(directory)
            cache_path = cache_dir / "relationships.json"
            lock_path = cache_dir / "fetch.lock"
            with (
                patch.object(app, "CACHE_DIR", cache_dir),
                patch.object(app, "CACHE_PATH", cache_path),
                patch.object(app, "LOCK_PATH", lock_path),
            ):
                saved = app.save_cache([{"id": "1"}])
                loaded = app.load_cache()

            self.assertEqual(saved["source"], "discord")
            self.assertEqual(loaded["source"], "cache")
            self.assertEqual(loaded["relationships"], [{"id": "1"}])
            self.assertNotIn("TOKEN", json.dumps(loaded))

    def test_remove_friend_updates_cache_only_after_remote_success(self) -> None:
        payload = {
            "version": app.CACHE_VERSION,
            "source": "cache",
            "fetched_at": "2026-01-01T00:00:00+00:00",
            "relationships": [
                {"id": "123", "type_name": "friend"},
                {"id": "456", "type_name": "outgoing_request"},
            ],
        }
        server = object.__new__(app.DashboardServer)
        server.payload = payload
        server.data_lock = app.threading.RLock()
        server.discord_service = Mock()

        with patch.object(app, "write_cache") as write_cache:
            removed = server.remove_friend("123")

        self.assertTrue(removed)
        server.discord_service.remove_friend.assert_called_once_with("123")
        self.assertEqual([item["id"] for item in payload["relationships"]], ["456"])
        write_cache.assert_called_once_with(payload)

    def test_remove_friend_rejects_non_friend(self) -> None:
        server = object.__new__(app.DashboardServer)
        server.payload = {
            "relationships": [{"id": "456", "type_name": "outgoing_request"}],
        }
        server.data_lock = app.threading.RLock()
        server.discord_service = Mock()

        with self.assertRaisesRegex(ValueError, "只能用此操作移除好友"):
            server.remove_friend("456")

        server.discord_service.remove_friend.assert_not_called()


if __name__ == "__main__":
    unittest.main()
