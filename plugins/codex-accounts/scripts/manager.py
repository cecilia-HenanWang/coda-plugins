"""Read-only IPC with the existing credential owner (codex-account). stdout is private, never a log.

Resolve active/idle paths under the owner's flock. Neither refresh tokens nor
credential files are copied; refresh remains the account owner's job, and for
this machine's own login (`native`), Codex's.
"""
import base64
import fcntl
import hashlib
import json
import re
import sys
import time
from pathlib import Path


def read_json(path):
    if path.is_symlink() or path.stat().st_size > 2 * 1024 * 1024:
        raise ValueError()
    return json.loads(path.read_text())


class AccountBusy(Exception):
    pass


def shared_lock(lock):
    deadline = time.monotonic() + 3
    while True:
        try:
            fcntl.flock(lock, fcntl.LOCK_SH | fcntl.LOCK_NB)
            return
        except BlockingIOError:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise AccountBusy()
            time.sleep(min(0.05, remaining))


def tokens(path, expected=None):
    access = read_json(path)['tokens']['access_token']
    part = access.split('.')[1]
    claims = json.loads(base64.urlsafe_b64decode(part + '=' * (-len(part) % 4)))
    auth = claims['https://api.openai.com/auth']
    account = auth['chatgpt_account_id']
    if (expected and account != expected) or claims.get('exp', 0) <= time.time() + 30:
        raise ValueError()
    return {'accessToken': access, 'chatgptAccountId': account, 'chatgptPlanType': auth.get('chatgpt_plan_type')}


try:
    root, native, action = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3]
    if action == 'native':
        # This machine's own login, which Codex renews: read as it stands, without the manager.
        print(json.dumps(tokens(native / 'auth.json')))
        sys.exit(0)
    with (root / 'account.lock').open('rb') as lock:
        shared_lock(lock)
        registry = read_json(root / 'registry.json')
        accounts = registry['accounts']
        if action == 'list':
            result = [{'alias': alias, 'active': registry.get('active') == alias,
                       'identity': hashlib.sha256(record['account_id'].encode()).hexdigest(),
                       'plan': record.get('plan_type')}
                      for alias, record in accounts.items()
                      if re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,63}', alias)]
        else:
            alias = sys.argv[4]
            if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,63}', alias):
                raise ValueError()
            record = accounts[alias]
            if len(sys.argv) > 5 and sys.argv[5] != hashlib.sha256(record['account_id'].encode()).hexdigest():
                raise ValueError()
            path = native / 'auth.json' if registry.get('active') == alias else root / 'accounts' / alias / 'auth.json'
            result = tokens(path, record['account_id'])
            result['chatgptPlanType'] = result['chatgptPlanType'] or record.get('plan_type')
        print(json.dumps(result))
except AccountBusy:
    sys.stderr.write('账号管理器正在更新，请稍后重试\n')
    sys.exit(2)
except Exception:
    # Do not leak paths, token payloads or provider responses through errors.
    sys.stderr.write('账号凭据不可用，请在账号管理器更新登录后重试\n')
    sys.exit(1)
