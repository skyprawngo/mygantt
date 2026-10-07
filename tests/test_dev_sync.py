import importlib.util
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = pathlib.Path(__file__).resolve().parents[1] / 'devtools/db-sync/sync.py'
spec = importlib.util.spec_from_file_location('dev_sync', SCRIPT)
sync = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sync)

class SyncGateTests(unittest.TestCase):
    def settings(self):
        return {'MYGANTT_SYNC_ENABLED':'true', 'MYGANTT_SYNC_PAIR_ID':'test-pair',
                'MYGANTT_SYNC_DB':'/tmp/test.sqlite3', 'MYGANTT_SYNC_SSH_HOST':'example-peer',
                'MYGANTT_SYNC_REMOTE_SCRIPT':'/tmp/helper/sync.py'}

    def test_disabled_without_explicit_opt_in(self):
        for value in ('', 'false', '1'):
            config=self.settings(); config['MYGANTT_SYNC_ENABLED']=value
            with self.assertRaises(RuntimeError): sync.coordinator_config(config)

    def test_peer_mismatch_rejected_before_database_access(self):
        with self.assertRaises(RuntimeError): sync.authorize(self.settings(),'other-pair')
        self.assertEqual(sync.authorize(self.settings(),'test-pair'),'/tmp/test.sqlite3')

    def test_missing_peer_has_no_default_and_delay_is_at_least_five_minutes(self):
        config=self.settings();config.pop('MYGANTT_SYNC_SSH_HOST')
        with self.assertRaises(RuntimeError):sync.coordinator_config(config)
        config=self.settings();config['MYGANTT_SYNC_DELAY_SECONDS']='2'
        self.assertEqual(sync.coordinator_config(config)['delay'],300)

    def test_binding_prevents_silent_switch_to_another_peer(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(sync,'ROOT',pathlib.Path(directory)):
            config=sync.coordinator_config(self.settings())
            with self.assertRaises(RuntimeError):sync.verify_binding(config)
            sync.atomic(sync.ROOT/'binding.json',{key:config[key] for key in ('local_db','host','remote_script','pair_id')})
            sync.verify_binding(config)
            config['host']='another-peer'
            with self.assertRaises(RuntimeError):sync.verify_binding(config)

    def test_clean_install_cli_cannot_read_write_watch_or_connect(self):
        env={key:value for key,value in os.environ.items() if not key.startswith('MYGANTT_SYNC_')}
        for action in ('snapshot','apply','watch','daemon','backup','check','initialize'):
            result=subprocess.run([sys.executable,str(SCRIPT),action,'--pair-id','other'],env=env,capture_output=True,text=True,timeout=5)
            self.assertNotEqual(result.returncode,0)
            self.assertEqual(result.stdout,'')
            self.assertIn('disabled',result.stderr)

    def test_merge_and_conflict_protection_on_temporary_databases(self):
        from mygantt.database import Database
        import copy
        with tempfile.TemporaryDirectory() as directory:
            path=pathlib.Path(directory)/'test.sqlite3'
            Database(path, holiday_fetcher=lambda year: [])
            base=sync.read(path)
            key=next(iter(base['tables']['projects']))
            local=copy.deepcopy(base);remote=copy.deepcopy(base)
            local['tables']['projects'][key]['name']='local change'
            merged,conflicts=sync.merge(base,local,remote)
            self.assertFalse(conflicts)
            sync.apply(path,sync.digest(base),merged)
            self.assertEqual(sync.read(path),merged)
            with self.assertRaises(RuntimeError):sync.apply(path,sync.digest(base),base)
            remote['tables']['projects'][key]['name']='conflicting remote change'
            self.assertTrue(sync.merge(base,local,remote)[1])

    def test_remote_command_requires_verified_ssh_host_and_pair(self):
        command=sync.remote_command(sync.coordinator_config(self.settings()),'snapshot')
        self.assertIn('StrictHostKeyChecking=yes',command)
        self.assertIn('--pair-id test-pair',command[-1])
        self.assertNotIn('--db',command[-1])

if __name__=='__main__':unittest.main()
