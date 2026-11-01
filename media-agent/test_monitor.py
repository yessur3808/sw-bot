import unittest
from unittest.mock import patch
import monitor


class FakeAPI:
    def __init__(self, channels):
        self.channels = channels
        self.scans = []

    def call(self, path, data=None):
        if path == '/media/monitor':
            return {'channels': self.channels, 'jobs': []}
        self.scans.append(data)
        return {'ok': True}


class MonitorTests(unittest.TestCase):
    def test_first_scan_does_not_download_or_fetch_old_trailers(self):
        api = FakeAPI([{'id': 'official', 'title': 'Official', 'known': []}])
        with patch.object(monitor, 'list_channel', return_value=[{'id': 'AbcDefGh123', 'title': 'Official trailer'}]), patch.object(monitor, 'metadata') as meta:
            monitor.run(api)
            meta.assert_not_called()
            self.assertEqual(api.scans[0]['items'][0]['id'], 'AbcDefGh123')

    def test_new_trailer_requires_watch_page_identity(self):
        api = FakeAPI([{'id': 'official', 'title': 'Official', 'known': ['Baseline001']}])
        with patch.object(monitor, 'list_channel', return_value=[{'id': 'AbcDefGh123', 'title': 'Official trailer'}]), patch.object(monitor, 'metadata', return_value={'id': 'AbcDefGh123', 'title': 'Official trailer', 'channel_id': 'official'}) as meta:
            monitor.run(api)
            meta.assert_called_once_with('AbcDefGh123', 'official')
            self.assertEqual(api.scans[0]['items'][0]['channel_id'], 'official')

    def test_platform_block_stops_further_channels_and_uploads(self):
        api = FakeAPI([{'id': 'one', 'title': 'One', 'known': []}, {'id': 'two', 'title': 'Two', 'known': []}])
        with patch.object(monitor, 'list_channel', side_effect=monitor.MediaError('access_blocked')) as read:
            monitor.run(api)
            self.assertEqual(read.call_count, 1)
            self.assertEqual(api.scans[0]['error'], 'access_blocked')

    def test_public_failure_does_not_claim_success(self):
        api = FakeAPI([{'id': 'one', 'title': 'One', 'known': []}])
        with patch.object(monitor, 'list_channel', return_value=[]):
            monitor.run(api)
            self.assertEqual(api.scans[0]['status'], 'error')


if __name__ == '__main__':
    unittest.main()
