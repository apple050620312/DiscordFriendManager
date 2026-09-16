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
        self.assertIsNone(item["last_message_at"])
        self.assertNotIn("token", item)

    def test_private_channel_activity_maps_last_message_to_recipient(self) -> None:
        activity = app.private_channel_activity(
            [
                {
                    "type": 1,
                    "last_message_id": "175928847299117063",
                    "recipients": [{"id": "123"}],
                },
                {
                    "type": 3,
                    "last_message_id": "175928847299117064",
                    "recipients": [{"id": "456"}, {"id": "789"}],
                },
                {"type": 1, "last_message_id": None, "recipients": [{"id": "999"}]},
            ]
        )

        self.assertEqual(activity, {"123": "2016-04-30T11:18:25+00:00"})

    def test_cache_round_trip_is_cache_first(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            cache_dir = Path(directory)
            cache_path = cache_dir / "relationships.json"
            lock_path = cache_dir / "fetch.lock"
            message_scan_path = cache_dir / "message_scan.json"
            with (
                patch.object(app, "CACHE_DIR", cache_dir),
                patch.object(app, "CACHE_PATH", cache_path),
                patch.object(app, "LOCK_PATH", lock_path),
                patch.object(app, "MESSAGE_SCAN_PATH", message_scan_path),
            ):
                saved = app.save_cache([{"id": "1"}])
                loaded = app.load_cache()

            self.assertEqual(saved["source"], "discord")
            self.assertEqual(loaded["source"], "cache")
            self.assertEqual(loaded["relationships"][0]["id"], "1")
            self.assertFalse(loaded["relationships"][0]["last_message_checked"])
            self.assertNotIn("TOKEN", json.dumps(loaded))

    def test_get_data_does_not_refetch_completed_dm_activity(self) -> None:
        cached = {
            "version": app.CACHE_VERSION,
            "source": "cache",
            "fetched_at": "2026-01-01T00:00:00+00:00",
            "dm_activity_fetched_at": "2026-01-01T00:01:00+00:00",
            "relationships": [{"id": "123", "last_message_at": None}],
        }
        with (
            patch.object(app, "load_cache", return_value=cached),
            patch.object(app, "fetch_private_activity") as fetch_activity,
        ):
            result = app.get_data()

        self.assertIs(result, cached)
        fetch_activity.assert_not_called()

    def test_message_scan_results_mark_empty_conversations_checked(self) -> None:
        payload = {
            "relationships": [
                {"id": "123", "last_message_at": None},
                {"id": "456", "last_message_at": "2026-01-01T00:00:00+00:00"},
            ]
        }

        app.apply_message_scan_results(payload, {"123": None})

        self.assertTrue(payload["relationships"][0]["last_message_checked"])
        self.assertIsNone(payload["relationships"][0]["last_message_at"])
        self.assertTrue(payload["relationships"][1]["last_message_checked"])

    def test_message_scan_processes_only_unchecked_friends(self) -> None:
        server = object.__new__(app.DashboardServer)
        server.payload = {
            "relationships": [
                {
                    "id": "123",
                    "type_name": "friend",
                    "last_message_at": "2026-01-01T00:00:00+00:00",
                    "last_message_checked": True,
                },
                {
                    "id": "456",
                    "type_name": "friend",
                    "last_message_at": None,
                    "last_message_checked": False,
                },
                {
                    "id": "789",
                    "type_name": "outgoing_request",
                    "last_message_at": None,
                    "last_message_checked": False,
                },
            ]
        }
        server.data_lock = app.threading.RLock()
        server.discord_service = Mock()
        server.discord_service.fetch_last_message_at.return_value = None
        server.message_scan_results = {}
        server.message_scan_stop = app.threading.Event()
        server.message_scan_state = "scanning"
        server.message_scan_error = None

        with patch.object(app, "write_message_scan") as write_scan:
            server._run_message_scan()

        server.discord_service.fetch_last_message_at.assert_called_once_with("456")
        self.assertTrue(server.payload["relationships"][1]["last_message_checked"])
        self.assertEqual(server.message_scan_results, {"456": None})
        self.assertEqual(server.message_scan_state, "complete")
        write_scan.assert_called_once_with({"456": None})

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
